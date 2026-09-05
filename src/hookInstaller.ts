/**
 * Installs the mailbox hook into Claude Code's user settings (~/.claude/settings.json).
 *
 * Idempotent: entries are recognised by the script name in their command, removed
 * and re-added; everything else in the file is preserved. A timestamped backup is
 * written next to the file before the first modification of each install.
 *
 * Desktop only (Node fs). `ILC_HOME` overrides the home directory for tests.
 */
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOOK_SCRIPT, HOOK_SCRIPT_NAME } from './hookScript.ts';

export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionStart'] as const;

export interface HookStatus {
  installed: boolean;
  /** installed, but pointing at a different script/root than we would write now */
  stale: boolean;
  scriptExists: boolean;
  settingsPath: string;
  scriptPath: string;
  command: string;
}

interface HookEntry { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }
interface ClaudeSettings { hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

export function homeDir(): string {
  return process.env.ILC_HOME || os.homedir();
}

export function claudeSettingsPath(): string {
  return path.join(homeDir(), '.claude', 'settings.json');
}

export function hookCommand(scriptPath: string, mailboxRootAbs: string): string {
  return `bash "${scriptPath}" --root "${mailboxRootAbs}"`;
}

/** Write (or refresh) the hook script and make it executable */
export async function writeHookScript(scriptPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(scriptPath), { recursive: true });
  await fsp.writeFile(scriptPath, HOOK_SCRIPT, 'utf8');
  await fsp.chmod(scriptPath, 0o755);
}

async function readSettings(file: string): Promise<ClaudeSettings> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? (data as ClaudeSettings) : {};
  } catch {
    return {};
  }
}

const isOurs = (e: HookEntry) => e.hooks?.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT_NAME));

export async function getHookStatus(scriptPath: string, mailboxRootAbs: string): Promise<HookStatus> {
  const settingsPath = claudeSettingsPath();
  const command = hookCommand(scriptPath, mailboxRootAbs);
  const settings = await readSettings(settingsPath);
  const hooks = settings.hooks ?? {};
  const present = HOOK_EVENTS.filter((ev) => (hooks[ev] ?? []).some(isOurs));
  const exact = HOOK_EVENTS.every((ev) => (hooks[ev] ?? []).some((e) => e.hooks?.some((h) => h.command === command)));
  let scriptExists = false;
  try { await fsp.access(scriptPath); scriptExists = true; } catch { /* not installed yet */ }
  return {
    installed: present.length === HOOK_EVENTS.length,
    stale: present.length > 0 && !exact,
    scriptExists,
    settingsPath,
    scriptPath,
    command,
  };
}

/** Install (or refresh) our hook entries. Returns the backup path if one was written. */
export async function installClaudeHooks(scriptPath: string, mailboxRootAbs: string): Promise<{ backup?: string; settingsPath: string }> {
  await writeHookScript(scriptPath);
  const settingsPath = claudeSettingsPath();
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });

  let backup: string | undefined;
  try {
    await fsp.access(settingsPath);
    backup = `${settingsPath}.bak-ilc-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fsp.copyFile(settingsPath, backup);
  } catch {
    // no existing file — nothing to back up
  }

  const settings = await readSettings(settingsPath);
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  const command = hookCommand(scriptPath, mailboxRootAbs);
  for (const ev of HOOK_EVENTS) {
    const kept = (hooks[ev] ?? []).filter((e) => !isOurs(e));
    kept.push({ hooks: [{ type: 'command', command, timeout: 20 }] });
    hooks[ev] = kept;
  }
  settings.hooks = hooks;
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { backup, settingsPath };
}

/** Remove our entries; leaves other hooks untouched */
export async function uninstallClaudeHooks(): Promise<void> {
  const settingsPath = claudeSettingsPath();
  const settings = await readSettings(settingsPath);
  if (!settings.hooks) return;
  const hooks: Record<string, HookEntry[]> = {};
  for (const [ev, entries] of Object.entries(settings.hooks)) {
    const kept = entries.filter((e) => !isOurs(e));
    if (kept.length) hooks[ev] = kept;
  }
  settings.hooks = hooks;
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
