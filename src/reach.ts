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
  /** Claude: the session is running */
  open?: boolean;
  /** Claude: it runs, but its Claude Code has no cross-session inbox */
  noInbox?: boolean;
  /** Claude: it had an inbox, but its socket file is gone (until the session restarts) */
  inboxGone?: boolean;
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
  if (f.open && f.noInbox && f.inboxGone) {
    return f.hookInstalled
      ? { level: 'later', text: t('开着，但它的收信口文件不见了，要等它下次说话；重开这个会话就能直接送到') }
      : { level: 'none', text: t('看不到：开着但收信口文件不见了，又没装 hook；装 hook 或重开这个会话'), fix: 'hook' };
  }
  if (f.open && f.noInbox) {
    return f.hookInstalled
      ? { level: 'later', text: t('开着，但它的 Claude Code 没开收信口，要等它下次说话') }
      : { level: 'none', text: t('看不到：开着但没开收信口，又没装 hook'), fix: 'hook' };
  }
  if (f.open && !f.holds) return { level: 'now', text: f.desktop ? t('开着（Claude 客户端），直接送进去') : t('开着（终端），直接送进去') };
  if (!f.open && f.autoStart && f.cliInstalled && f.canOpenTerminal) return { level: 'now', text: t('没开着，@ 时会在终端里打开它') };
  // No terminal the plugin can open (Linux, Windows): the card hands the user the start command
  if (!f.open && f.autoStart && f.cliInstalled) return { level: 'later', text: t('没开着：@ 后在卡片上复制启动命令，到终端里运行它就会收到') };
  // A session that skips permission prompts holds letters from other programs; switching its
  // mode takes effect at once (no restart), so the text says so
  if (f.hookInstalled) return { level: 'later', text: f.open ? t('它跳过了权限确认，要等它下次说话；换个权限模式就能直接送到') : t('没开着，下次打开它时会看到') };
  return { level: 'none', text: f.open ? t('看不到：它跳过了权限确认又没装 hook；装 hook 或换个权限模式') : t('看不到：没开着，又没装 hook'), fix: 'hook' };
}

/** A member whose harness the plugin does not know: its letters only wait in the mailbox */
export function unknownHarnessReach(harness: string): Reach {
  return { level: 'later', text: t('只放进信箱：插件不认识「{0}」这种会话，要它自己去看', [harness]) };
}

/** What a member's dot means, for its tooltip */
export function levelHint(level: ReachLevel): string {
  return level === 'now' ? t('现在就能收到') : level === 'later' ? t('要等它下次说话或打开') : t('现在收不到');
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

/** Does this Codex config talk to a provider other than OpenAI (a local model, OpenRouter, …)? */
async function otherProvider(configToml: string): Promise<boolean> {
  try {
    const text = await nodeFsp().readFile(configToml, 'utf8');
    return [...text.matchAll(/^\s*model_provider\s*=\s*["']([^"']+)["']/gm)].some((m) => m[1].toLowerCase() !== 'openai');
  } catch {
    return false;
  }
}

export interface LoginEvidence {
  /** What this CLI's last background run showed: it answered (true) or was turned away for credentials (false) */
  lastRun?: boolean;
  /** Ask the CLI itself (Codex: `codex login status`) */
  askCli?: () => Promise<boolean>;
}

/**
 * Has the user signed this CLI in? A background run settles it (`lastRun`): the
 * runs use Obsidian's environment, so that is the answer that matters. Before
 * any run: an API key in Obsidian's environment, the files the CLIs write when
 * they log in, Codex's own `login status` (it can keep credentials in the system
 * keyring), and a Codex set up for another provider, whose credentials we can't
 * see, so we don't claim it is signed out. Still a guess, so the UI says "好像" (seems).
 */
export async function harnessLoggedIn(id: HarnessId, home = process.env.ILC_HOME || nodeOs().homedir(), env: Record<string, string | undefined> = process.env, evidence: LoginEvidence = {}): Promise<boolean> {
  if (evidence.lastRun !== undefined) return evidence.lastRun;
  const join = nodePath().join;
  if (id === 'codex') {
    if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return true;
    const codexHome = env.CODEX_HOME || join(home, '.codex');
    if (await exists(join(codexHome, 'auth.json'))) return true;
    if (await otherProvider(join(codexHome, 'config.toml'))) return true;
    return evidence.askCli ? evidence.askCli().catch(() => false) : false;
  }
  if (id === 'gemini') {
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) return true;
    return (await exists(join(home, '.gemini', 'oauth_creds.json'))) || exists(join(home, '.gemini', '.env'));
  }
  return true; // Claude Code members run in a session the user already signed in to
}
