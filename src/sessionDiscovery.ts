/**
 * Discover AI coding sessions running / recently active on this machine, so the
 * user can add them as @-mention members without leaving Obsidian.
 *
 * Sources (desktop only):
 *  - Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl (mtime = last activity;
 *    first lines carry cwd + first user message). Running = a `claude` process whose
 *    command line carries --resume=<id> / --session-id <id>.
 *  - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl. Codex does not put
 *    the id on its process command line, so "running" = a codex process exists and
 *    the log was touched in the last 15 minutes.
 */
import { promises as fsp } from 'fs';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export type Harness = 'claude' | 'codex';

export interface LocalSession {
  harness: Harness;
  sessionId: string;
  shortId: string;
  /** Working directory the session was started in (if the log says) */
  cwd?: string;
  /** First user message, trimmed — a cheap "what is this session about" */
  title?: string;
  lastActive: number;
  running: boolean;
  file: string;
}

const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const CODEX_RUNNING_WINDOW_MS = 15 * 60 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function ps(): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile('ps', ['-axo', 'command'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? '' : String(stdout));
      });
    } catch {
      resolve('');
    }
  });
}

async function readHead(file: string, bytes = 1024 * 1024): Promise<string> {
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => {});
  }
}

function cleanTitle(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, ' ').replace(/^<[^>]+>\s*/g, '').trim();
  if (!t) return undefined;
  // compaction / resume / harness boilerplate says nothing about the session
  if (/^This session is being continued|^<system-reminder>|^Caveat:|^<local-command|^<command-|^\[Image|^MemoraX|^Base directory|^You are|^# |^\{/i.test(t)) return undefined;
  if (/^[a-z0-9_-]{6,}$/i.test(t)) return undefined; // ids / slugs
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

/**
 * Best-effort extraction of cwd + first user message from a JSONL head.
 * Works on the raw text with regexes: the first lines can be hundreds of KB
 * (pasted screenshots are inlined as base64), so whole-line JSON.parse is not
 * an option.
 */
function parseHead(text: string): { cwd?: string; title?: string } {
  let cwd: string | undefined;
  const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try { cwd = JSON.parse(`"${m[1]}"`); } catch { cwd = m[1]; }
  }
  // Candidate texts in order of appearance: text parts and plain string contents
  const re = /"(?:text|content)":"((?:[^"\\]|\\.){2,6000})"/g;
  let title: string | undefined;
  for (const mm of text.matchAll(re)) {
    let raw: string;
    try { raw = JSON.parse(`"${mm[1]}"`); } catch { continue; }
    const t = cleanTitle(raw);
    if (t) { title = t; break; }
  }
  return { cwd, title };
}

async function discoverClaude(runningIds: Set<string>, now: number): Promise<LocalSession[]> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const out: LocalSession[] = [];
  let dirs: string[] = [];
  try { dirs = await fsp.readdir(root); } catch { return out; }

  for (const d of dirs) {
    const dir = path.join(root, d);
    let files: string[] = [];
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      if (!UUID_RE.test(id)) continue;
      const file = path.join(dir, f);
      let mtime = 0;
      try { mtime = (await fsp.stat(file)).mtimeMs; } catch { continue; }
      const running = runningIds.has(id.toLowerCase());
      if (!running && now - mtime > MAX_AGE_MS) continue;
      const head = parseHead(await readHead(file));
      out.push({
        harness: 'claude',
        sessionId: id,
        shortId: id.slice(0, 8),
        cwd: head.cwd,
        title: head.title,
        lastActive: mtime,
        running,
        file,
      });
    }
  }
  return out;
}

async function walk(dir: string, depth: number, acc: string[]): Promise<void> {
  if (depth < 0) return;
  let entries: import('fs').Dirent[] = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, depth - 1, acc);
    else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p);
  }
}

async function discoverCodex(codexRunning: boolean, now: number): Promise<LocalSession[]> {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files: string[] = [];
  await walk(root, 4, files);
  const out: LocalSession[] = [];
  for (const file of files) {
    const m = path.basename(file).match(UUID_RE);
    if (!m) continue;
    const id = m[0];
    let mtime = 0;
    try { mtime = (await fsp.stat(file)).mtimeMs; } catch { continue; }
    if (now - mtime > MAX_AGE_MS) continue;
    const head = parseHead(await readHead(file));
    out.push({
      harness: 'codex',
      sessionId: id,
      shortId: id.slice(0, 8),
      cwd: head.cwd,
      title: head.title,
      lastActive: mtime,
      running: codexRunning && now - mtime < CODEX_RUNNING_WINDOW_MS,
      file,
    });
  }
  return out;
}

/** All recently active local sessions, running ones first, newest first */
export async function discoverLocalSessions(): Promise<LocalSession[]> {
  const now = Date.now();
  const procs = await ps();
  const runningIds = new Set<string>();
  for (const m of procs.matchAll(/--(?:resume|session-id)[= ]([0-9a-f-]{36})/gi)) {
    runningIds.add(m[1].toLowerCase());
  }
  const codexRunning = /\bcodex\b/.test(procs);

  const [claude, codex] = await Promise.all([
    discoverClaude(runningIds, now),
    discoverCodex(codexRunning, now),
  ]);
  const all = [...claude, ...codex];
  // dedupe by id (a session can appear under several project slugs after a cwd change)
  const byId = new Map<string, LocalSession>();
  for (const s of all) {
    const prev = byId.get(s.sessionId);
    if (!prev || s.lastActive > prev.lastActive) byId.set(s.sessionId, { ...s, running: s.running || prev?.running || false });
  }
  return [...byId.values()]
    .sort((a, b) => Number(b.running) - Number(a.running) || b.lastActive - a.lastActive)
    .slice(0, 30);
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export function shortCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const home = os.homedir();
  const p = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = p.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p;
}
