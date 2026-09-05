/**
 * Start (or resume) a real Claude Code session in a terminal and hand it a
 * letter as its first message. Used when a member was @-mentioned but has no
 * running session: a brand-new member gets `claude --session-id <id>`, a known
 * but idle one gets `claude --resume <id>`. Either way it is the member's own
 * persistent session — the user can walk over to the terminal and keep talking.
 *
 * Desktop/macOS only. With `ILC_LAUNCH_LOG` set, the launch is recorded there
 * instead of opening Terminal (used by e2e).
 */
import { promises as fsp } from 'fs';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export interface LaunchPlan {
  mode: 'new' | 'resume';
  sessionId: string;
  cwd: string;
  promptFile?: string;
  /** Shell line executed in the terminal */
  shell: string;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Does a transcript for this session id already exist on this machine? */
export async function sessionFileExists(sessionId: string, home = process.env.ILC_HOME || os.homedir()): Promise<boolean> {
  const root = path.join(home, '.claude', 'projects');
  let dirs: string[] = [];
  try { dirs = await fsp.readdir(root); } catch { return false; }
  for (const d of dirs) {
    try {
      await fsp.access(path.join(root, d, `${sessionId}.jsonl`));
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

/** Ids of claude processes currently running (from their command lines) */
export function runningClaudeIds(): Promise<Set<string>> {
  return new Promise((resolve) => {
    try {
      execFile('ps', ['-axo', 'command'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        const ids = new Set<string>();
        if (!err) for (const m of String(stdout).matchAll(/--(?:resume|session-id)[= ]([0-9a-f-]{36})/gi)) ids.add(m[1].toLowerCase());
        resolve(ids);
      });
    } catch {
      resolve(new Set());
    }
  });
}

/** The message a freshly started session receives: the letter + how to answer */
export function buildLaunchPrompt(name: string, letterBody: string, today: string): string {
  return `📬 Obsidian 评论区有 1 封新留言给你（你在评论区的名字：${name}）。
${letterBody.trim()}

如何回复：打开留言里的「文档」，找到「划线原文」对应的评论块（形如 {==原文==}{>>作者|日期|类型: 内容<<}），在该块的最后一个 <<} 之后紧接着追加一条：
{>>${name}|${today}|reply: 你的回复<<}
要修改划线原文时，另外追加一条建议（正文只放替换后的原文，不要解释，解释写在 reply 里）：
{>>${name}|${today}|suggest: 替换后的原文<<}
用户在面板里点「采纳」原文才会变，你自己不要直接改 {==原文==}。
规则：不要删改已有评论和 {==原文==}；回复正文里不要出现连续的 << 或 >>；需要上下文就先读文档。回复写进文档后，用户会在评论面板里看到。之后用户还可能继续在评论里 @ 你，留言会自动送到这里。`;
}

export function buildLaunchPlan(opts: { sessionId: string; cwd: string; promptFile?: string; exists: boolean }): LaunchPlan {
  const mode: LaunchPlan['mode'] = opts.exists ? 'resume' : 'new';
  const flag = mode === 'resume' ? '--resume' : '--session-id';
  const prompt = opts.promptFile ? ` "$(cat ${shq(opts.promptFile)})"` : '';
  const shell = `cd ${shq(opts.cwd)} && claude ${flag} ${shq(opts.sessionId)}${prompt}`;
  return { mode, sessionId: opts.sessionId, cwd: opts.cwd, promptFile: opts.promptFile, shell };
}

/** Write the prompt to a temp file (keeps the shell line short and quoting sane) */
export async function writePromptFile(sessionId: string, prompt: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'ilc-launch');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId.slice(0, 8)}-${Date.now()}.txt`);
  await fsp.writeFile(file, prompt, 'utf8');
  return file;
}

/** Open Terminal.app and run the plan (or log it when ILC_LAUNCH_LOG is set) */
export async function launchInTerminal(plan: LaunchPlan): Promise<'launched' | 'logged' | 'unsupported'> {
  const log = process.env.ILC_LAUNCH_LOG;
  if (log) {
    await fsp.appendFile(log, JSON.stringify({ ...plan, at: new Date().toISOString() }) + '\n', 'utf8');
    return 'logged';
  }
  if (process.platform !== 'darwin') return 'unsupported';
  const asq = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Terminal"
  activate
  do script "${asq(plan.shell)}"
end tell`;
  await new Promise<void>((resolve) => execFile('osascript', ['-e', script], () => resolve()));
  return 'launched';
}
