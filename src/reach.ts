/**
 * How a member gets a letter right now: the one thing the @ list and the
 * members dialog tell the user about each member.
 *
 * - now:   it gets the letter straight away (an open Claude Code session that
 *          takes it, a background Codex / Gemini run, or a session the plugin
 *          opens in a terminal);
 * - later: it sees the letter the next time it speaks (mailbox + wake hook);
 * - none:  nobody reads the letter until the user fixes something.
 *
 * `decideReach` is pure; the facts come from this machine (see atSelector's
 * memberReach). `harnessLoggedIn` is a best-effort look at the CLIs' own files.
 */
import { t } from './i18n.ts';
import type { HarnessId } from './harnesses.ts';
import { nodeFsp, nodeOs, nodePath } from './node.ts';

export type ReachLevel = 'now' | 'later' | 'none';

export interface Reach {
  level: ReachLevel;
  /** Short, shown under the name */
  text: string;
  /** One click that turns 'none' into something better */
  fix?: 'hook' | 'login';
}

export interface ReachFacts {
  harness: HarnessId;
  /** Harness display name (Claude Code, Codex, …) */
  label: string;
  headless: boolean;
  /** Plugin-created member: started / answered by the plugin when a letter arrives */
  autoStart: boolean;
  /** Claude: the session is running with a live inbox */
  open?: boolean;
  /** Claude: that session would not take a letter from us (it skips permission prompts) */
  holds?: boolean;
  /** Claude: the open session is a chat in the Claude app (else a terminal) */
  desktop?: boolean;
  hookInstalled: boolean;
  cliInstalled: boolean;
  loggedIn: boolean;
  /** This machine can open a terminal for the session (macOS) */
  canOpenTerminal: boolean;
}

export const REACH_ORDER: Record<ReachLevel, number> = { now: 0, later: 1, none: 2 };

export function decideReach(f: ReachFacts): Reach {
  if (f.headless) {
    if (!f.autoStart) return { level: 'none', text: t('收不到：{0} 会话不会自己看信箱', [f.label]) };
    if (!f.cliInstalled) return { level: 'none', text: t('收不到：本机没找到 {0}', [f.label]) };
    if (!f.loggedIn) return { level: 'none', text: t('收不到：{0} 好像还没登录', [f.label]), fix: 'login' };
    return { level: 'now', text: t('在后台回复') };
  }
  if (f.open && !f.holds) return { level: 'now', text: f.desktop ? t('开着（Claude 客户端），直接送进去') : t('开着（终端），直接送进去') };
  if (!f.open && f.autoStart && f.cliInstalled && f.canOpenTerminal) return { level: 'now', text: t('没开着，@ 时会在终端里打开它') };
  if (f.hookInstalled) return { level: 'later', text: f.open ? t('跳过了权限确认，它下次说话时会看到') : t('没开着，下次打开它时会看到') };
  return { level: 'none', text: f.open ? t('看不到：跳过了权限确认，又没装 hook') : t('看不到：没开着，又没装 hook'), fix: 'hook' };
}

/** Members from the old roster file carry their own presence */
export function legacyReach(status: string): Reach {
  if (status === '在线') return { level: 'now', text: t('在线') };
  if (status === '闲置') return { level: 'later', text: t('闲置') };
  return { level: 'none', text: t('离线') };
}

async function exists(file: string): Promise<boolean> {
  try { await nodeFsp().access(file); return true; } catch { return false; }
}

/**
 * Has the user signed this CLI in? Looks for the files the CLIs write when they
 * log in, and for API keys in Obsidian's own environment. Keys exported only in
 * a shell profile are missed, so the UI says "好像" (seems).
 */
export async function harnessLoggedIn(id: HarnessId, home = process.env.ILC_HOME || nodeOs().homedir(), env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const join = nodePath().join;
  if (id === 'codex') {
    if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return true;
    return exists(join(env.CODEX_HOME || join(home, '.codex'), 'auth.json'));
  }
  if (id === 'gemini') {
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) return true;
    return (await exists(join(home, '.gemini', 'oauth_creds.json'))) || exists(join(home, '.gemini', '.env'));
  }
  return true; // Claude Code members run in a session the user already signed in to
}
