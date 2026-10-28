/**
 * Hand a letter straight to a running Claude Code session — a chat in the
 * Claude app's Code tab or a `claude` in a terminal — through the session's own
 * cross-session inbox. Claude Code lists each live session in
 * ~/.claude/sessions/<pid>.json with a Unix socket (`messagingSocketPath`) and,
 * since 2.1, a key file `<pid>.<sha256(socket)>.key` whose `peerToken` a sender
 * presents first. Dark Console uses the same channel.
 *
 * The letter queues behind the session's current turn (priority "next"), so it
 * never interrupts one. A session in bypass-permissions mode holds messages from
 * other programs until the user approves them in that session.
 *
 * Desktop only (Node net/fs). `ILC_HOME` overrides the home directory (e2e).
 */
import { nodeCrypto, nodeFsp, nodeNet, nodeOs, nodePath } from './node.ts';

export interface ClaudeInbox {
  sessionId: string;
  pid: number;
  socket: string;
  /** Peer key published next to the record (absent on older Claude Code) */
  token?: string;
  cwd?: string;
  /** Started by the Claude app (Code tab) rather than a terminal */
  desktop: boolean;
}

const SENDER = 'Agent Comments';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const st = await nodeFsp().stat(file);
    if (!st.isFile() || st.size > 64 * 1024) return null;
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
