import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import { DeliveryLog, STALE_MS, deliveryLine, deliverySlot, type DeliveryRecord } from './deliveryStatus.ts';

const rec = (r: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  key: 'k1', doc: 'a.md', highlight: '原文', text: '[@助理](agent:12345678?notify) 看看', shortId: '12345678',
  name: '助理', sessionId: '12345678-0000-4000-8000-000000000000', letter: '信箱/1.md', state: 'mailbox', at: 1000, ...r,
});
const ctx = (c: Partial<Parameters<typeof deliveryLine>[1]> = {}) => ({ replied: false, now: 2000, hookInstalled: true, label: 'Claude Code', ...c });

describe('deliveryLine', () => {
  it('disappears once the member replied', () => {
    expect(deliveryLine(rec({ state: 'handed' }), ctx({ replied: true }))).toBeNull();
  });
  it('sending: busy until the plugin knows where it went', () => {
    expect(deliveryLine(rec({ state: 'sending' }), ctx())).toEqual({ tone: 'busy', text: '正在送给 助理…' });
  });
  it('mailbox: says when it will be seen, or that it will not and how to fix it', () => {
    expect(deliveryLine(rec(), ctx())).toMatchObject({ tone: 'info', text: expect.stringContaining('下次说话时会看到') });
    expect(deliveryLine(rec({ reason: 'held' }), ctx())?.text).toContain('跳过了权限确认');
    expect(deliveryLine(rec(), ctx({ hookInstalled: false }))).toMatchObject({ tone: 'warn', action: 'hook' });
    expect(deliveryLine(rec({ reason: 'not-autostart' }), ctx({ label: 'Codex' }))).toMatchObject({ tone: 'warn', text: expect.stringContaining('Codex 会话不会自己看信箱') });
  });
  it('handed: says how it got there, then turns into 还没回复 with a way to look', () => {
    expect(deliveryLine(rec({ state: 'handed', route: 'inbox' }), ctx())).toMatchObject({ tone: 'busy', text: expect.stringContaining('已送进 助理 的会话') });
    expect(deliveryLine(rec({ state: 'handed', route: 'background' }), ctx())?.text).toContain('后台');
    expect(deliveryLine(rec({ state: 'handed', route: 'terminal' }), ctx())?.text).toContain('终端');
    expect(deliveryLine(rec({ state: 'handed', route: 'hook' }), ctx())?.text).toContain('已看到');
    expect(deliveryLine(rec({ state: 'handed' }), ctx({ now: 1000 + STALE_MS + 1 }))).toMatchObject({ tone: 'warn', action: 'open', text: '助理 还没回复' });
  });
  it('failed: a plain reason and the next step', () => {
    expect(deliveryLine(rec({ state: 'failed', reason: 'not-logged-in' }), ctx({ label: 'Codex' }))).toMatchObject({ tone: 'error', action: 'login', text: '没送到：Codex 还没登录' });
    expect(deliveryLine(rec({ state: 'failed', reason: 'missing-cli' }), ctx({ label: 'Codex' }))).toMatchObject({ action: 'retry' });
    expect(deliveryLine(rec({ state: 'failed', reason: 'error', detail: 'timeout' }), ctx())).toMatchObject({ action: 'retry', text: '没送到：timeout' });
  });
});

describe('DeliveryLog', () => {
  const app = () => {
    const files = new Map<string, string>();
    return {
      files,
      app: { vault: { adapter: { read: async (p: string) => { if (!files.has(p)) throw new Error('no'); return files.get(p)!; }, write: async (p: string, d: string) => { files.set(p, d); } } } } as unknown as App,
    };
  };

  it('records, moves on, finds by comment, and tells listeners', async () => {
    vi.useFakeTimers();
    const { app: a, files } = app();
    const log = new DeliveryLog(a, 'p/delivery-status.json');
    await log.load();
    const seen: string[] = [];
    log.onChange((r) => seen.push(r.state));
    log.record(rec()); // `at` is set by the log
    log.update('k1', { state: 'failed', reason: 'error', detail: 'x' });
    log.update('k1', { state: 'handed', route: 'inbox' });
    const r = log.find(deliverySlot('a.md', '原文', '[@助理](agent:12345678?notify) 看看', '12345678'))!;
    expect(r).toMatchObject({ state: 'handed', route: 'inbox', reason: undefined, detail: undefined });
    expect(log.byLetter('信箱/1.md')?.key).toBe('k1');
    expect(log.lastAt(r.sessionId)).toBeGreaterThan(0);
    expect(log.lastAt('other')).toBe(0);
    expect(seen).toEqual(['mailbox', 'failed', 'handed']);
    await vi.advanceTimersByTimeAsync(600);
    expect(JSON.parse(files.get('p/delivery-status.json')!).records).toHaveLength(1);
    vi.useRealTimers();
  });
});
