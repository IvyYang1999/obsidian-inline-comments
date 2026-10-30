/**
 * Agent CLIs ("harnesses") a plugin-created member can run on.
 *
 * - Claude Code opens in a terminal with the letter as its first message; later
 *   letters reach the running session through its hooks (hookInstaller.ts).
 * - Codex and Gemini CLI have no way to receive a letter mid-session, so every
 *   letter is answered by one headless run that resumes the member's session.
 *   The user can still open that session in a terminal and keep talking.
 *
 * Only CLIs found on this machine are offered. GUI apps start with a minimal
 * PATH, so detection asks the user's login shell for its PATH first.
 * `ILC_HARNESS_PATH` replaces that PATH (e2e points it at fake CLIs).
 */
import { nodeCp, nodeFsp, nodeOs, nodePath } from './node.ts';

export type HarnessId = 'claude' | 'codex' | 'gemini';

export interface HarnessDef {
  id: HarnessId;
  label: string;
  bin: string;
  /** terminal = start in Terminal, hooks deliver later letters; headless = one resumed run per letter */
  mode: 'terminal' | 'headless';
  /** Install spots that are often missing from PATH (Claude's local install lives behind an alias) */
  extraBins?: string[];
}

export const HARNESSES: HarnessDef[] = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', mode: 'terminal', extraBins: ['~/.claude/local/claude', '~/.local/bin/claude'] },
  { id: 'codex', label: 'Codex', bin: 'codex', mode: 'headless' },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini', mode: 'headless' },
];

/**
 * A member's harness from what the registry says. Members joined by hand or by
 * older scripts say `claude-code`, `Claude Code`, `codex-cli`…; none or `unknown`
 * is a Claude Code session (the original behaviour). Anything else: undefined.
 */
export function harnessDef(id: string | undefined): HarnessDef | undefined {
  const key = (id ?? '').trim().toLowerCase();
  if (!key || key === 'unknown') return HARNESSES[0];
  const letters = key.replace(/[^a-z]/g, '');
  return HARNESSES.find((h) => key === h.id || letters.startsWith(h.id));
}

// ─── Detection ───────────────────────────────────────────────────────────────

export interface InstalledHarnesses {
  /** PATH to run harnesses with (login shell's PATH + Obsidian's own) */
  path: string;
  /** Absolute path of each harness found */
  bins: Partial<Record<HarnessId, string>>;
}

let detecting: Promise<InstalledHarnesses> | null = null;

/** Which harnesses are installed; cached, `refresh` looks again (e.g. after the user installed one) */
export function detectHarnesses(refresh = false): Promise<InstalledHarnesses> {
  if (!detecting || refresh) detecting = detect();
  return detecting;
}

const MARK = '__ILC_PATH__';

function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      nodeCp().execFile(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeout: 8000 }, (_err, stdout) => {
        resolve(String(stdout ?? '').split(MARK)[1] ?? '');
      });
    } catch {
      resolve('');
    }
  });
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await nodeFsp().access(file, 1 /* X_OK */);
    return (await nodeFsp().stat(file)).isFile();
  } catch {
    return false;
  }
}

async function detect(): Promise<InstalledHarnesses> {
  const sep = process.platform === 'win32' ? ';' : ':';
  const override = process.env.ILC_HARNESS_PATH;
  const searchPath = override ?? [await loginShellPath(), process.env.PATH ?? ''].filter(Boolean).join(sep);
  const dirs = [...new Set(searchPath.split(sep).filter(Boolean))];
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  const home = nodeOs().homedir();
  const bins: InstalledHarnesses['bins'] = {};
  for (const h of HARNESSES) {
    const candidates = dirs.flatMap((d) => exts.map((x) => nodePath().join(d, h.bin + x)));
    if (!override) candidates.push(...(h.extraBins ?? []).map((p) => p.replace(/^~(?=\/)/, home)));
    for (const c of candidates) {
      if (await isExecutable(c)) { bins[h.id] = c; break; }
    }
  }
  const path = [...new Set([...dirs, ...(process.env.PATH ?? '').split(sep)].filter(Boolean))].join(sep);
  return { path, bins };
}

// ─── Headless runs ───────────────────────────────────────────────────────────

export interface HeadlessOpts {
  /** The member's own id (Gemini takes it as its session id) */
  sessionId: string;
  /** The harness's session id once known: resume it instead of starting a new one */
  threadId?: string;
  /** Vault folder, when the session works elsewhere and still has to edit the note */
  extraDir?: string;
}

/** argv for one letter. The prompt goes on stdin for Codex and as `-p` for Gemini. */
export function headlessArgs(h: HarnessId, o: HeadlessOpts, prompt: string): string[] {
  if (h === 'codex') {
    // workspace-write: may edit files under cwd (+ the vault), never asks for approval in exec mode
    const common = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"'];
    if (o.extraDir) common.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([o.extraDir])}`);
    return o.threadId ? ['exec', 'resume', ...common, o.threadId, '-'] : ['exec', ...common, '-'];
  }
  if (h === 'gemini') {
    // auto_edit: file edits are approved, shell commands are not
    const common = ['--approval-mode', 'auto_edit', '--skip-trust', '-o', 'json'];
    if (o.extraDir) common.push('--include-directories', o.extraDir);
    const session = o.threadId ? ['--resume', o.threadId] : ['--session-id', o.sessionId];
    return [...session, ...common, '-p', prompt];
  }
  throw new Error(`no headless mode for ${h}`);
}

export interface HeadlessResult {
  ok: boolean;
  /** The harness's session id, to resume next time */
  threadId?: string;
  error?: string;
}

/** Read a finished run: Codex prints JSON lines, Gemini one JSON object */
export function parseHeadlessOutput(h: HarnessId, stdout: string, code: number | null, sessionId: string): HeadlessResult {
  let threadId: string | undefined;
  let error: string | undefined;
  if (h === 'codex') {
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      let ev: { type?: string; thread_id?: string; message?: string; error?: { message?: string } };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id;
      if (ev.type === 'turn.failed') error = ev.error?.message ?? 'turn failed';
      else if (ev.type === 'error' && ev.message && !/^Reconnecting/.test(ev.message)) error = ev.message;
    }
  } else {
    const start = stdout.indexOf('{');
    try {
      const out = JSON.parse(stdout.slice(start)) as { session_id?: string; error?: { message?: string } };
      threadId = out.session_id;
      if (out.error) error = out.error.message ?? 'error';
    } catch { /* not JSON: fall back to the exit code */ }
    // A failed first run saves nothing, so only a clean run proves the session exists
    if (!threadId && code === 0) threadId = sessionId;
  }
  const ok = code === 0 && !error;
  // A Codex thread exists from `thread.started` on, even when the turn then failed
  return { ok, threadId: ok || h === 'codex' ? threadId : undefined, error: ok ? undefined : error };
}

/** Does this error mean the CLI is not signed in? */
export function looksUnauthenticated(error: string | undefined): boolean {
  return !!error && /401|unauthori[sz]ed|auth method|not logged in|log ?in|api key/i.test(error);
}

/** Shell line that reopens a member's session in a terminal to keep talking */
export function resumeShell(h: HarnessId, cwd: string, threadId: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = h === 'codex' ? `codex resume ${q(threadId)}` : h === 'gemini' ? `gemini --resume ${q(threadId)}` : `claude --resume ${q(threadId)}`;
  return `cd ${q(cwd)} && ${cmd}`;
}

/**
 * Run one headless turn. Output is appended to `logFile` (kept for debugging);
 * the run is killed after `timeoutMs`.
 */
export function runHeadless(
  h: HarnessId,
  run: { bin: string; args: string[]; cwd: string; path: string; stdin?: string; logFile: string; sessionId: string },
  timeoutMs = 15 * 60 * 1000,
): Promise<HeadlessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = nodeCp().spawn(run.bin, run.args, { cwd: run.cwd, env: { ...process.env, PATH: run.path } });
    const timer = window.setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    let done = false;
    const finish = (code: number | null, spawnError?: string) => {
      if (done) return; // a failed spawn emits both 'error' and 'close'
      done = true;
      window.clearTimeout(timer);
      const log = `$ ${run.bin} ${run.args.map((a) => (a.length > 80 ? a.slice(0, 80) + '…' : a)).join(' ')}\n(cwd ${run.cwd}, exit ${code})\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`;
      void nodeFsp().mkdir(nodePath().dirname(run.logFile), { recursive: true })
        .then(() => nodeFsp().appendFile(run.logFile, log, 'utf8'))
        .catch(() => {});
      if (spawnError) { resolve({ ok: false, error: spawnError }); return; }
      const res = parseHeadlessOutput(h, stdout, code, run.sessionId);
      if (!res.ok) res.error ??= stderr.trim().split('\n').pop() || `exit ${code}`;
      resolve(res);
    };
    child.on('error', (err) => finish(null, String(err?.message ?? err)));
    child.on('close', (code) => finish(code));
    child.stdin?.end(run.stdin ?? '');
  });
}
