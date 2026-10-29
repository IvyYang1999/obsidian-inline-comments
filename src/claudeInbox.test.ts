import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeInboxHolds, claudeInboxQueued, findClaudeInbox, inboxFrames, sendToClaudeInbox } from './claudeInbox.ts';

const SID = '3f1c2b9a-1111-4222-8333-444455556666';
let home: string;
let socket: string;
let server: Server | null;
let received: string;

function record(extra: Record<string, unknown> = {}, pid = process.pid) {
  const dir = join(home, '.claude', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: SID, cwd: '/v', kind: 'interactive', entrypoint: 'claude-desktop', messagingSocketPath: socket, ...extra }));
}
function key(token: string, pid = process.pid) {
  const hash = createHash('sha256').update(socket).digest('hex');
  writeFileSync(join(home, '.claude', 'sessions', `${pid}.${hash}.key`), JSON.stringify({ peerToken: token }));
}
const listen = () => new Promise<void>((resolve) => {
  received = '';
  server = createServer((c) => { c.on('data', (d) => { received += d; }); c.on('end', () => c.end()); });
  server.listen(socket, resolve);
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ilc-inbox-'));
  socket = join(home, 's.sock');
  server = null;
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  rmSync(home, { recursive: true, force: true });
});

describe('findClaudeInbox', () => {
  it('finds a live session with its socket and key', async () => {
    await listen();
    record();
    key('ab'.repeat(16));
    const inbox = await findClaudeInbox(SID.toUpperCase(), home);
    expect(inbox).toMatchObject({ sessionId: SID, pid: process.pid, socket, token: 'ab'.repeat(16), cwd: '/v', desktop: true });
  });
  it('works without a key (older Claude Code)', async () => {
    await listen();
    record({ entrypoint: 'cli' });
    expect(await findClaudeInbox(SID, home)).toMatchObject({ token: undefined, desktop: false });
  });
  it('ignores other sessions, dead processes and missing sockets', async () => {
    await listen();
    record({ sessionId: '00000000-0000-4000-8000-000000000000' });
    expect(await findClaudeInbox(SID, home)).toBeNull();
    record({}, 999999);
    expect(await findClaudeInbox(SID, home)).toBeNull();
    rmSync(join(home, '.claude', 'sessions'), { recursive: true });
    record({ messagingSocketPath: join(home, 'gone.sock') });
    expect(await findClaudeInbox(SID, home)).toBeNull();
  });
});

describe('sendToClaudeInbox', () => {
  it('authenticates, then sends the letter as a queued user message', async () => {
    await listen();
    record();
    key('cd'.repeat(16));
    const inbox = (await findClaudeInbox(SID, home))!;
    expect(await sendToClaudeInbox(inbox, '📬 hi', 'm-1')).toBe('sent');
    const lines = received.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: 'auth', token: 'cd'.repeat(16) });
    expect(lines[1]).toEqual({ type: 'user', session_id: SID, uuid: 'm-1', msg_id: 'm-1', from: 'Agent Comments', priority: 'next', message: { role: 'user', content: '📬 hi' } });
  });
  it('reports unreachable when nobody listens on the socket', async () => {
    await listen();
    record();
    const inbox = (await findClaudeInbox(SID, home))!;
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    writeFileSync(socket, ''); // the stale socket path of a crashed session
    expect(await sendToClaudeInbox(inbox, 'x')).toBe('unreachable');
  });
});

describe('inboxFrames', () => {
  it('skips the auth line without a key', () => {
    expect(inboxFrames({ sessionId: SID }, 'x', 'm').split('\n').filter(Boolean)).toHaveLength(1);
  });
});

/** A transcript in ~/.claude/projects/<slug>/<id>.jsonl, one record per line */
function transcript(...records: object[]) {
  const dir = join(home, '.claude', 'projects', '-v');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}
function userSettings(s: object) {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(s));
}

describe('claudeInboxHolds', () => {
  it('follows the permission mode of the latest turn', async () => {
    transcript({ type: 'user', permissionMode: 'acceptEdits' }, { type: 'user', permissionMode: 'bypassPermissions' });
    expect(await claudeInboxHolds({ sessionId: SID }, home)).toBe(true);
    transcript({ type: 'user', permissionMode: 'bypassPermissions' }, { type: 'assistant' }, { type: 'user', permissionMode: 'default' });
    expect(await claudeInboxHolds({ sessionId: SID }, home)).toBe(false);
  });
  it('counts an unknown mode as holding', async () => {
    expect(await claudeInboxHolds({ sessionId: SID }, home)).toBe(true);
    transcript({ type: 'assistant', message: { content: 'said "permissionMode":"default" in a reply' } });
    expect(await claudeInboxHolds({ sessionId: SID }, home)).toBe(true);
  });
  it('lets the crossSessionInbound setting decide first', async () => {
    transcript({ type: 'user', permissionMode: 'bypassPermissions' });
    userSettings({ crossSessionInbound: 'accept' });
    expect(await claudeInboxHolds({ sessionId: SID }, home)).toBe(false);
    transcript({ type: 'user', permissionMode: 'default' });
    userSettings({ crossSessionInbound: 'hold' });
    expect(await claudeInboxHolds({ sessionId: SID }, home)).toBe(true);
  });
});

describe('claudeInboxQueued', () => {
  const now = () => new Date().toISOString();
  it('sees the queue entry the session writes for the letter', async () => {
    transcript({ type: 'queue-operation', operation: 'enqueue', timestamp: now(), content: '📬 letter\n  body ' });
    expect(await claudeInboxQueued(SID, '📬 letter\nbody', 'm-1', home, 0)).toBe(true);
  });
  it('sees the turn that started from it', async () => {
    transcript({ type: 'user', uuid: 'm-2', origin: { kind: 'peer', msg_id: 'm-2' } });
    expect(await claudeInboxQueued(SID, 'other text', 'm-2', home, 0)).toBe(true);
  });
  it('is false for a held letter, or an identical one queued long ago', async () => {
    transcript({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-01-01T00:00:00.000Z', content: '📬 letter' });
    expect(await claudeInboxQueued(SID, '📬 letter', 'm-3', home, 0)).toBe(false);
  });
  it('waits for the entry to appear', async () => {
    transcript({ type: 'assistant' });
    setTimeout(() => transcript({ type: 'queue-operation', operation: 'enqueue', timestamp: now(), content: 'late' }), 200);
    expect(await claudeInboxQueued(SID, 'late', 'm-4', home, 3000)).toBe(true);
  });
});
