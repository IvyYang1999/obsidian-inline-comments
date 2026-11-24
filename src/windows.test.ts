/**
 * Windows only: starting the agent CLIs through the `.cmd` shims npm installs.
 *
 * A stand-in package is installed with npm itself, so its `codex.cmd`, `claude.cmd` and
 * `gemini.cmd` are real npm shims, into a folder whose path has spaces and Chinese in it.
 * The stand-in writes down the arguments and stdin it received. The tests then go through the
 * plugin's own code (detection, headless runs, `codex login status`) and compare.
 *
 * With ILC_REAL_CLIS set to a folder holding the real Codex and Gemini CLIs (installed by
 * the Windows workflow, not signed in), they also check that those start and get as far as
 * asking for a sign-in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type HarnessId, codexSignedIn, detectHarnesses, headlessArgs, looksUnauthenticated, promptOnStdin, runHeadless } from './harnesses.ts';

// runHeadless times out with window.setTimeout, as it does inside Obsidian
if (!('window' in globalThis)) (globalThis as { window?: unknown }).window = globalThis;

const onWindows = process.platform === 'win32';
const ID = '3f1c2b9a-1111-4222-8333-444455556666';

/** The stand-in CLI: records argv, stdin and cwd, then exits with ILC_ECHO_EXIT */
const ECHO_JS = `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.ILC_ECHO_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin: input, cwd: process.cwd() }));
  process.exit(Number(process.env.ILC_ECHO_EXIT || 0));
});
`;

/** A letter as the plugin writes it, with everything cmd.exe would trip over */
const LETTER = [
  '「小林」你好：',
  '',
  '> 原文：把 `npm run build && npm test` 跑一遍 | 然后看 > out.txt',
  '评论：100% 确定吗？%PATH% 和 !PATH! 不该被展开；^ 也不该消失。',
  'Say "hi" to C:\\Program Files (x86)\\x\\ and a&b, a|b, <in>, 2>&1 🎉',
  '',
].join('\r\n') + '\n最后一行没有换行符';

/** Arguments that break naive quoting, one by one */
const TRICKY = [
  'plain', 'two words', '', ' leading and trailing ', 'tab\there',
  '"quoted"', 'say "hi" twice "x"', 'back\\slash', 'trailing\\', 'trailing\\\\', 'C:\\Program Files (x86)\\x\\',
  '\\"', 'a\\\\"b',
  '100%', '%PATH%', '%%', '%~dp0', '%1', '!PATH!', '^', '^^', 'a^b',
  'a&b', 'a&&b', 'a|b', 'a||b', '<in', '>out', '2>&1', '(paren)', ')', 'x;y,z=w', '`tick`', '*?', '@echo',
  '中文参数', '🎉 emoji', 'é ñ ü',
  '{"writable_roots":["C:\\\\a b\\\\c"]}', 'sandbox_mode="workspace-write"', '--flag=a b&c',
];

describe.runIf(onWindows)('on Windows, through npm .cmd shims', () => {
  let root = '';
  let shims = '';
  let cwd = '';
  let vault = '';
  let n = 0;

  /** Run once through runHeadless; returns what the stand-in saw */
  async function run(h: HarnessId, bin: string, args: string[], stdin?: string) {
    const out = path.join(root, `seen-${++n}.json`);
    process.env.ILC_ECHO_OUT = out;
    const res = await runHeadless(h, { bin, args, cwd, path: process.env.PATH ?? '', stdin, logFile: path.join(root, 'runs.log'), sessionId: ID });
    const seen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) as { argv: string[]; stdin: string; cwd: string } : null;
    return { res, seen };
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ilc win 测试 '));
    const pkg = path.join(root, 'stand-in');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'echo.js'), ECHO_JS);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'ilc-stand-in', version: '1.0.0', bin: { codex: 'echo.js', claude: 'echo.js', gemini: 'echo.js' },
    }));
    execSync(`npm pack "${pkg}" --pack-destination "${root}"`, { cwd: root, stdio: 'pipe' });
    shims = path.join(root, 'npm global');
    execSync(`npm install -g --no-audit --no-fund --prefix "${shims}" "${path.join(root, 'ilc-stand-in-1.0.0.tgz')}"`, { cwd: root, stdio: 'pipe' });
    cwd = path.join(root, 'work dir 工作');
    vault = path.join(root, '我的笔记 & 草稿 (2026)');
    fs.mkdirSync(cwd);
    fs.mkdirSync(vault);
    process.env.ILC_HARNESS_PATH = shims;
  }, 180_000);

  afterAll(() => {
    delete process.env.ILC_HARNESS_PATH;
    delete process.env.ILC_ECHO_OUT;
    delete process.env.ILC_ECHO_EXIT;
  });

  it('finds the npm shims', async () => {
    const { bins } = await detectHarnesses(true);
    for (const h of ['claude', 'codex', 'gemini'] as const) {
      expect(bins[h]).toBe(path.join(shims, `${h}.cmd`));
    }
  });

  it.each(['codex', 'claude', 'gemini'] as const)('%s gets its real arguments and the letter intact', async (h) => {
    const { bins } = await detectHarnesses();
    const bin = bins[h]!;
    for (const threadId of [undefined, 'thread-7']) {
      // As main.ts does it
      const onStdin = promptOnStdin(h, bin);
      const args = headlessArgs(h, { sessionId: ID, threadId, extraDir: vault, promptOnStdin: onStdin }, LETTER);
      const { res, seen } = await run(h, bin, args, onStdin ? LETTER : undefined);
      expect(res.error ?? '').not.toMatch(/EINVAL|ENOENT|not recognized/i);
      expect(seen, JSON.stringify(res)).not.toBeNull();
      expect(seen!.argv).toEqual(args);
      expect(seen!.stdin).toBe(LETTER);
      expect(seen!.cwd.toLowerCase()).toBe(cwd.toLowerCase());
    }
  });

  it('Gemini gets the letter on stdin, not as -p', async () => {
    const { bins } = await detectHarnesses();
    expect(promptOnStdin('gemini', bins.gemini!)).toBe(true);
    expect(headlessArgs('gemini', { sessionId: ID, promptOnStdin: true }, LETTER)).not.toContain('-p');
  });

  it('passes tricky arguments through unchanged', async () => {
    const { bins } = await detectHarnesses();
    const { res, seen } = await run('codex', bins.codex!, TRICKY);
    expect(seen, JSON.stringify(res)).not.toBeNull();
    expect(seen!.argv).toEqual(TRICKY);
    // And each one alone, so one argument can't mask another's mistake
    for (const arg of TRICKY) {
      const one = await run('codex', bins.codex!, [arg]);
      expect(one.seen?.argv, `argument ${JSON.stringify(arg)}`).toEqual([arg]);
    }
  }, 120_000);

  it('refuses an argument with a line break instead of running it', async () => {
    const { bins } = await detectHarnesses();
    const { res, seen } = await run('gemini', bins.gemini!, ['-p', 'line one\r\nline two & echo pwned']);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/line break/);
    expect(seen).toBeNull();
  });

  it('asks `codex login status` through the shim', async () => {
    const out = path.join(root, 'login-status.json');
    process.env.ILC_ECHO_OUT = out;
    process.env.ILC_ECHO_EXIT = '0';
    await detectHarnesses(true);
    expect(await codexSignedIn()).toBe(true);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).argv).toEqual(['login', 'status']);
  });
});

describe.runIf(onWindows && !!process.env.ILC_REAL_CLIS)('on Windows, the real CLIs (not signed in)', () => {
  let cwd = '';
  let logFile = '';

  beforeAll(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ilc real 测试 '));
    logFile = path.join(cwd, 'runs.log');
    process.env.ILC_HARNESS_PATH = process.env.ILC_REAL_CLIS;
  });

  afterAll(() => {
    delete process.env.ILC_HARNESS_PATH;
    if (fs.existsSync(logFile)) console.log(fs.readFileSync(logFile, 'utf8'));
  });

  it.each(['codex', 'gemini'] as const)('%s starts from its npm shim and asks for a sign-in', async (h) => {
    const { bins, path: searchPath } = await detectHarnesses(true);
    const bin = bins[h];
    expect(bin, `${h} in ${process.env.ILC_REAL_CLIS}`).toMatch(/\.cmd$/i);
    const onStdin = promptOnStdin(h, bin!);
    const res = await runHeadless(h, {
      bin: bin!, cwd, path: searchPath, logFile, sessionId: ID,
      args: headlessArgs(h, { sessionId: ID, extraDir: cwd, promptOnStdin: onStdin }, LETTER),
      stdin: onStdin ? LETTER : undefined,
    }, 90_000);
    console.log(h, JSON.stringify(res));
    expect(res.ok).toBe(false);
    expect(res.error ?? '').not.toMatch(/EINVAL|ENOENT|not recognized|unknown (option|argument)|unexpected argument/i);
    expect(looksUnauthenticated(res.error)).toBe(true);
  }, 120_000);
});
