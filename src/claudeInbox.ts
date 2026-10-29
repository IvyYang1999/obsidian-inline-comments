/**
 * Hand a letter straight to a running Claude Code session — a chat in the
 * Claude app's Code tab or a `claude` in a terminal — through the session's own
 * cross-session inbox. Claude Code lists each live session in
 * ~/.claude/sessions/<pid>.json with a Unix socket (`messagingSocketPath`) and,
 * since 2.1, a key file `<pid>.<sha256(socket)>.key` whose `peerToken` a sender
 * presents first. Dark Console uses the same channel.
 *
 * The letter queues behind the session's current turn (priority "next"), so it
 * never interrupts one. A session in bypass-permissions mode holds it instead,
 * waiting for an approval the Claude app has no place for, and drops it after
 * five minutes — so such sessions get their letters from the mailbox, and a
 * letter only counts as handed over once the session's transcript shows it queued.
 *
 * Desktop only (Node net/fs). `ILC_HOME` overrides the home directory (e2e).
 */
import { nodeCrypto, nodeFsp, nodeNet, nodeOs, nodePath } from './node.ts';
import { findClaudeTranscript } from './sessionLauncher.ts';

export interface ClaudeInbox {
  sessionId: string;
  pid: number;
  socket: string;
  /** Peer key published next to the record (absent on older Claude Code) */
  token?: string;
  cwd?: string;
  /** Started by the Claude app (Code tab) rather than a terminal */
  desktop: boolean;
  /** The Claude app's own id for the chat (local_…), for claude://code/continue?session= */
  hostSessionId?: string;
}

const SENDER = 'Agent Comments';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readJson(file: string, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  try {
    const st = await nodeFsp().stat(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    const v: unknown = JSON.parse(await nodeFsp().readFile(file, 'utf8'));
    return v && typeof v === 'object' ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function readToken(dir: string, pid: number, socket: string): Promise<string | undefined> {
  const hash = nodeCrypto().createHash('sha256').update(socket).digest('hex');
  const token = (await readJson(nodePath().join(dir, `${pid}.${hash}.key`)))?.peerToken;
  return typeof token === 'string' && /^[0-9a-f]{16,128}$/i.test(token) ? token : undefined;
}

/** The live inbox of this session, or null when it is not running (or its Claude Code has no inbox) */
export async function findClaudeInbox(sessionId: string, home = process.env.ILC_HOME || nodeOs().homedir()): Promise<ClaudeInbox | null> {
  if (!UUID_RE.test(sessionId)) return null;
  const dir = nodePath().join(home, '.claude', 'sessions');
  let files: string[];
  try { files = await nodeFsp().readdir(dir); } catch { return null; }
  let best: { inbox: ClaudeInbox; at: number } | null = null;
  for (const f of files) {
    const pid = Number(/^(\d+)\.json$/.exec(f)?.[1]);
    if (!pid) continue;
    const r = await readJson(nodePath().join(dir, f));
    if (!r || String(r.sessionId).toLowerCase() !== sessionId.toLowerCase()) continue;
    const socket = r.messagingSocketPath;
    if (r.pid !== pid || typeof socket !== 'string' || !nodePath().isAbsolute(socket) || !alive(pid)) continue;
    try {
      const st = await nodeFsp().lstat(socket);
      if (!st.isSocket() || st.uid !== process.getuid?.()) continue;
    } catch { continue; }
    const at = Number(r.updatedAt) || 0;
    if (best && best.at >= at) continue;
    best = {
      at,
      inbox: {
        sessionId: String(r.sessionId),
        pid,
        socket,
        token: await readToken(dir, pid, socket),
        cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
        desktop: String(r.entrypoint ?? '').startsWith('claude-desktop'),
        hostSessionId: typeof r.hostSessionId === 'string' && /^local_[0-9a-f-]{8,64}$/i.test(r.hostSessionId) ? r.hostSessionId : undefined,
      },
    };
  }
  return best?.inbox ?? null;
}

/** What goes down the socket: the auth line (when there is a key), then the letter as a user message */
export function inboxFrames(inbox: Pick<ClaudeInbox, 'sessionId' | 'token'>, text: string, msgId: string): string {
  const lines: object[] = [];
  if (inbox.token) lines.push({ type: 'auth', token: inbox.token });
  lines.push({ type: 'user', session_id: inbox.sessionId, uuid: msgId, msg_id: msgId, from: SENDER, priority: 'next', message: { role: 'user', content: text } });
  return lines.map((l) => `${JSON.stringify(l)}\n`).join('');
}

/**
 * Write the letter into the inbox. 'unreachable' means nothing was written (a
 * stale record), so the letter can still go another way. Once the frames are
 * written it counts as sent, even if the connection then fails: the session may
 * already have it, and sending again could deliver it twice.
 */
export function sendToClaudeInbox(inbox: ClaudeInbox, text: string, msgId = nodeCrypto().randomUUID(), timeoutMs = 5000): Promise<'sent' | 'unreachable'> {
  return new Promise((resolve) => {
    let written = false;
    let done = false;
    const sock = nodeNet().createConnection(inbox.socket);
    const finish = () => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(written ? 'sent' : 'unreachable');
    };
    sock.setTimeout(timeoutMs, finish);
    sock.once('connect', () => { written = true; sock.end(inboxFrames(inbox, text, msgId)); });
    sock.once('error', finish);
    sock.once('close', finish);
    sock.resume(); // the session sends nothing back on success; drain whatever it might
  });
}

/** The end of a file, whole lines only */
async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await nodeFsp().open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** The permission mode of the session's latest turn, as its transcript records it */
export async function claudeSessionMode(sessionId: string, home = process.env.ILC_HOME || nodeOs().homedir()): Promise<string | undefined> {
  const file = await findClaudeTranscript(sessionId, home);
  if (!file) return undefined;
  let mode: string | undefined;
  try {
    for (const m of (await readTail(file, 4 * 1024 * 1024)).matchAll(/"permissionMode":"([A-Za-z]+)"/g)) mode = m[1];
  } catch { /* unreadable: unknown */ }
  return mode;
}

/**
 * Would the session hold a letter from us rather than queue it? Claude Code
 * holds messages whose sender states no permission mode while the session runs
 * in bypassPermissions, unless the user's `crossSessionInbound` setting says
 * otherwise. An unknown mode counts as holding: the mailbox never loses a letter.
 */
export async function claudeInboxHolds(inbox: Pick<ClaudeInbox, 'sessionId'>, home = process.env.ILC_HOME || nodeOs().homedir()): Promise<boolean> {
  const setting = (await readJson(nodePath().join(home, '.claude', 'settings.json'), 1024 * 1024))?.crossSessionInbound;
  if (setting === 'accept') return false;
  if (setting === 'hold' || setting === 'refuse') return true;
  const mode = await claudeSessionMode(inbox.sessionId, home);
  return mode === undefined || mode === 'bypassPermissions';
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Did the session queue the letter? It writes the queue entry to its transcript
 * right away, even in the middle of a turn; a held or refused letter leaves no trace.
 */
export async function claudeInboxQueued(sessionId: string, text: string, msgId: string, home = process.env.ILC_HOME || nodeOs().homedir(), timeoutMs = 10000): Promise<boolean> {
  const want = squash(text);
  const since = Date.now() - 5000; // an identical letter queued earlier is not this one
  const deadline = Date.now() + timeoutMs;
  let file: string | null = null;
  for (;;) {
    file ??= await findClaudeTranscript(sessionId, home);
    if (file) {
      const tail = await readTail(file, 1024 * 1024).catch(() => '');
      for (const line of tail.split('\n')) {
        if (!line.includes(msgId) && !line.includes('"enqueue"')) continue;
        try {
          const r = JSON.parse(line) as { uuid?: unknown; origin?: { msg_id?: unknown }; type?: unknown; operation?: unknown; content?: unknown; timestamp?: unknown };
          if (r.uuid === msgId || r.origin?.msg_id === msgId) return true;
          if (r.type === 'queue-operation' && r.operation === 'enqueue' && typeof r.content === 'string' && squash(r.content) === want
            && Date.parse(String(r.timestamp)) >= since) return true;
        } catch { /* a line still being written */ }
      }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}
