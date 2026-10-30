/**
 * What happened to each @ letter, so the card can say it right under the
 * comment: in the mailbox, handed to the session (working on it), or not
 * delivered and why. The reply itself is not recorded: the card sees it in
 * the thread, and then keeps one quiet line of how the letter got there.
 * Kept in the plugin folder (delivery-status.json), newest 500.
 */
import type { App } from 'obsidian';
import { t } from './i18n.ts';
import { HOLD_MS } from './claudeInbox.ts';

export type DeliveryState = 'sending' | 'mailbox' | 'handed' | 'failed';
/** How a handed letter reached the session */
export type DeliveryRoute = 'inbox' | 'terminal' | 'background' | 'hook';
export type DeliveryReason = 'held' | 'no-inbox' | 'not-autostart' | 'not-logged-in' | 'missing-cli' | 'error';

export interface DeliveryRecord {
  /** The mention's key (mentionDelivery.mentionKey) */
  key: string;
  /** Where the @ was written: note path, highlighted passage, comment text, member short id */
  doc: string;
  highlight: string;
  text: string;
  shortId: string;
  name: string;
  sessionId: string;
  harness?: string;
  /** Vault path of the letter */
  letter: string;
  state: DeliveryState;
  route?: DeliveryRoute;
  reason?: DeliveryReason;
  /** The error, for reason 'error' */
  detail?: string;
  /** When the state last changed (ms) */
  at: number;
}

export interface DeliveryLine {
  text: string;
  tone: 'info' | 'busy' | 'warn' | 'error' | 'done';
  action?: 'retry' | 'hook' | 'login' | 'open';
}

/** A handed letter with no reply after this long gets "还没回复 · 打开它的会话" */
export const STALE_MS = 10 * 60 * 1000;

/** 14:05 today, 10/29 14:05 another day (local time) */
function clock(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** After the reply: how the letter got there, as one quiet line */
function doneLine(r: DeliveryRecord, now: number): DeliveryLine {
  const when = clock(r.at, now);
  const how = r.state !== 'handed' ? t('{0} 放进信箱', [when])
    : r.route === 'background' ? t('{0} 交给后台', [when])
      : r.route === 'terminal' ? t('{0} 在终端打开', [when])
        : r.route === 'hook' ? t('{0} 由 hook 递过去', [when])
          : t('{0} 送进会话', [when]);
  return { text: t('已回复 · {0}', [how]), tone: 'done' };
}

/** The card's line for one @; once the member has replied, a quiet line of how it got there */
export function deliveryLine(r: DeliveryRecord, ctx: { replied: boolean; now: number; hookInstalled: boolean; label: string }): DeliveryLine | null {
  if (ctx.replied) return doneLine(r, ctx.now);
  const who = r.name;
  if (r.state === 'sending') return { text: t('正在送给 {0}…', [who]), tone: 'busy' };
  if (r.state === 'mailbox') {
    // Held at the session's door: switching its mode lets it in, no restart needed
    if (r.reason === 'held' && ctx.now - r.at < HOLD_MS) return { text: t('{0} 跳过了权限确认，留言在门口等：5 分钟内把它换个权限模式就直接送进去', [who]), tone: 'info', action: 'open' };
    if (r.reason === 'not-autostart') return { text: t('已放进 {0} 的信箱，但 {1} 会话不会自己看信箱', [who, ctx.label]), tone: 'warn' };
    if (!ctx.hookInstalled) return { text: t('已放进 {0} 的信箱，但它看不到：没装唤醒 hook', [who]), tone: 'warn', action: 'hook' };
    if (r.reason === 'held') return { text: t('已放进 {0} 的信箱：它跳过了权限确认，下次说话时会看到；换了权限模式可以重试', [who]), tone: 'info', action: 'retry' };
    if (r.reason === 'no-inbox') return { text: t('已放进 {0} 的信箱：它开着，但收不到直送，下次说话时会看到', [who]), tone: 'info' };
    return { text: t('已放进 {0} 的信箱，它下次说话时会看到', [who]), tone: 'info' };
  }
  if (r.state === 'handed') {
    if (ctx.now - r.at > STALE_MS) return { text: t('{0} 还没回复', [who]), tone: 'warn', action: 'open' };
    const text = r.route === 'background' ? t('{0} 正在后台回复…', [who])
      : r.route === 'terminal' ? t('已在终端打开 {0}，处理中…', [who])
        : r.route === 'hook' ? t('{0} 已看到留言，处理中…', [who])
          : t('已送进 {0} 的会话，处理中…', [who]);
    return { text, tone: 'busy' };
  }
  if (r.reason === 'not-logged-in') return { text: t('没送到：{0} 还没登录', [ctx.label]), tone: 'error', action: 'login' };
  if (r.reason === 'missing-cli') return { text: t('没送到：本机没找到 {0}', [ctx.label]), tone: 'error', action: 'retry' };
  return { text: t('没送到：{0}', [r.detail || t('出错了')]), tone: 'error', action: 'retry' };
}

/** Identifies the comment an @ was written in, without hashing */
export function deliverySlot(doc: string, highlight: string, text: string, shortId: string): string {
  return [doc, highlight, text, shortId.toLowerCase()].join('\u0000');
}

const KEEP = 500;

export class DeliveryLog {
  private records: DeliveryRecord[] = [];
  private listeners = new Set<(r: DeliveryRecord) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private app: App, private path: string) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await this.app.vault.adapter.read(this.path)) as { records?: DeliveryRecord[] };
      this.records = Array.isArray(data.records) ? data.records : [];
    } catch {
      this.records = [];
    }
  }

  onChange(fn: (r: DeliveryRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start (or restart) the record of a letter */
  record(r: Omit<DeliveryRecord, 'at'>): void {
    this.records = this.records.filter((x) => x.key !== r.key);
    this.records.push({ ...r, at: Date.now() });
    if (this.records.length > KEEP) this.records = this.records.slice(-KEEP);
    this.changed(this.records[this.records.length - 1]);
  }

  /** Move a letter to a new state; route / reason / detail are replaced, not merged */
  update(key: string, patch: Pick<DeliveryRecord, 'state'> & Partial<Pick<DeliveryRecord, 'route' | 'reason' | 'detail'>>): void {
    const i = this.records.findIndex((x) => x.key === key);
    if (i < 0) return;
    this.records[i] = { ...this.records[i], route: undefined, reason: undefined, detail: undefined, ...patch, at: Date.now() };
    this.changed(this.records[i]);
  }

  byKey(key: string): DeliveryRecord | undefined {
    return this.records.find((x) => x.key === key);
  }

  byLetter(letter: string): DeliveryRecord | undefined {
    return this.records.find((x) => x.letter === letter);
  }

  find(slot: string): DeliveryRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (deliverySlot(r.doc, r.highlight, r.text, r.shortId) === slot) return r;
    }
    return undefined;
  }

  /** When this member was last @-ed (0 = never) */
  lastAt(sessionId: string): number {
    let at = 0;
    for (const r of this.records) if (r.sessionId === sessionId && r.at > at) at = r.at;
    return at;
  }

  private changed(r: DeliveryRecord): void {
    for (const fn of this.listeners) fn(r);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.app.vault.adapter.write(this.path, JSON.stringify({ records: this.records }, null, 2)).catch(() => {});
    }, 500);
  }
}
