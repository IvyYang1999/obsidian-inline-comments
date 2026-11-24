import { describe, it, expect } from 'vitest';
import { harnessDef, headlessArgs, looksUnauthenticated, parseHeadlessOutput, promptOnStdin, resumeShell, spawnCommand } from './harnesses.ts';

const ID = '3f1c2b9a-1111-4222-8333-444455556666';

describe('harnessDef', () => {
  it('treats members without a harness as Claude Code', () => {
    expect(harnessDef(undefined)?.id).toBe('claude');
    expect(harnessDef('codex')?.mode).toBe('headless');
    expect(harnessDef('kimi')).toBeUndefined();
  });

  it('reads the spellings people and older join scripts write', () => {
    for (const s of ['claude-code', 'Claude Code', 'claude_code', 'CLAUDE', 'unknown', '']) expect(harnessDef(s)?.id, s).toBe('claude');
    expect(harnessDef('codex-cli')?.id).toBe('codex');
    expect(harnessDef('Gemini CLI')?.id).toBe('gemini');
    expect(harnessDef('cursor')).toBeUndefined();
  });
});

describe('headlessArgs', () => {
  it('starts Codex in exec mode with the prompt on stdin, then resumes its thread', () => {
    expect(headlessArgs('codex', { sessionId: ID }, 'hi')).toEqual(
      ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-'],
    );
    expect(headlessArgs('codex', { sessionId: ID, threadId: 'T1', extraDir: '/v' }, 'hi')).toEqual(
      ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.writable_roots=["/v"]', 'T1', '-'],
    );
  });
  it('runs Claude Code in print mode with the member id as its session, then resumes it', () => {
    expect(headlessArgs('claude', { sessionId: ID }, 'hi')).toEqual(
      ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--session-id', ID],
    );
    expect(headlessArgs('claude', { sessionId: ID, threadId: ID, extraDir: '/v' }, 'hi')).toEqual(
      ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--add-dir', '/v', '--resume', ID],
    );
  });
  it('gives Gemini the member id as its session id, then resumes it', () => {
    expect(headlessArgs('gemini', { sessionId: ID }, 'hi')).toEqual(
      ['--session-id', ID, '--approval-mode', 'auto_edit', '--skip-trust', '-o', 'json', '-p', 'hi'],
    );
    expect(headlessArgs('gemini', { sessionId: ID, threadId: ID, extraDir: '/v' }, 'hi')).toEqual(
      ['--resume', ID, '--approval-mode', 'auto_edit', '--skip-trust', '-o', 'json', '--include-directories', '/v', '-p', 'hi'],
    );
  });
});

describe('parseHeadlessOutput', () => {
  it('reads the Codex thread id and a clean turn', () => {
    const out = '{"type":"thread.started","thread_id":"T1"}\n{"type":"turn.started"}\n{"type":"turn.completed"}\n';
    expect(parseHeadlessOutput('codex', out, 0, ID)).toEqual({ ok: true, threadId: 'T1', error: undefined });
  });
  it('keeps the Codex thread but reports a failed turn, ignoring reconnect noise', () => {
    const out = [
      '{"type":"thread.started","thread_id":"T1"}',
      '{"type":"error","message":"Reconnecting... 1/5 (401)"}',
      '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}',
    ].join('\n');
    const r = parseHeadlessOutput('codex', out, 1, ID);
    expect(r).toEqual({ ok: false, threadId: 'T1', error: 'unexpected status 401 Unauthorized' });
    expect(looksUnauthenticated(r.error)).toBe(true);
  });
  it('reads the Claude Code result; an error result fails even with exit 0', () => {
    expect(parseHeadlessOutput('claude', `{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"${ID}"}`, 0, ID))
      .toEqual({ ok: true, threadId: ID, error: undefined });
    const failed = parseHeadlessOutput('claude', `{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login","session_id":"${ID}"}`, 1, ID);
    expect(failed.ok).toBe(false);
    expect(looksUnauthenticated(failed.error)).toBe(true);
  });
  it('reads Gemini JSON; a failed first run proves no session', () => {
    expect(parseHeadlessOutput('gemini', `{"session_id":"${ID}","response":"ok"}`, 0, ID)).toEqual({ ok: true, threadId: ID, error: undefined });
    const failed = parseHeadlessOutput('gemini', `{"session_id":"${ID}","error":{"message":"Please set an Auth method"}}`, 41, ID);
    expect(failed.ok).toBe(false);
    expect(failed.threadId).toBeUndefined();
    expect(looksUnauthenticated(failed.error)).toBe(true);
  });
  it('reads the error Gemini prints on stderr when it is not signed in (0.57)', () => {
    const stderr = `{\n  "session_id": "${ID}",\n  "error": {\n    "type": "Error",\n    "message": "Please set an Auth method in your settings.json or specify one of the following environment variables before running: GEMINI_API_KEY",\n    "code": 41\n  }\n}\n`;
    const failed = parseHeadlessOutput('gemini', '', 41, ID, stderr);
    expect(failed.ok).toBe(false);
    expect(failed.threadId).toBeUndefined();
    expect(failed.error).toMatch(/^Please set an Auth method/);
    expect(looksUnauthenticated(failed.error)).toBe(true);
  });
});

/**
 * What cmd.exe makes of a line, as far as it matters here: outside quotes `^` escapes the next
 * character, an unescaped `"` starts quoting, and an unescaped & | < > would run as shell syntax;
 * inside quotes everything is literal up to the closing `"`. Returns the text it hands on.
 */
function cmdReads(line: string): { text: string; unsafe: boolean } {
  let text = '';
  let quoted = false;
  let unsafe = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') quoted = false;
      text += c;
      continue;
    }
    if (c === '^') { text += line[++i] ?? ''; continue; }
    if (c === '"') quoted = true;
    else if ('&|<>'.includes(c)) unsafe = true;
    text += c;
  }
  return { text, unsafe };
}

/** How a Windows program splits its command line (CommandLineToArgvW rules) */
function argvOf(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else quoted = !quoted;
      } else {
        cur += '\\'.repeat(n);
        i--;
      }
      inArg = true;
      continue;
    }
    if (c === '"') { quoted = !quoted; inArg = true; continue; }
    if ((c === ' ' || c === '\t') && !quoted) {
      if (inArg) { out.push(cur); cur = ''; inArg = false; }
      continue;
    }
    cur += c;
    inArg = true;
  }
  if (inArg) out.push(cur);
  return out;
}

const COMSPEC = 'C:\\Windows\\system32\\cmd.exe';
const SHIM = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\codex.cmd';

/** What the CLI behind a shim receives: cmd.exe reads the line, then reads the arguments again as the shim's %* */
function shimSees(bin: string, args: string[]): { unsafe: boolean; argv: string[] } {
  const c = spawnCommand(bin, args, 'win32', COMSPEC);
  expect(c.command).toBe(COMSPEC);
  expect(c.windowsVerbatimArguments).toBe(true);
  expect(c.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  const line = c.args[3].slice(1, -1); // /s: cmd.exe drops the outer pair of quotes
  const first = cmdReads(line);
  const prog = `"${bin}"`;
  expect(first.text.startsWith(prog)).toBe(true);
  expect(argvOf(first.text)[0]).toBe(bin); // a space in the shim's path doesn't split it
  const second = cmdReads(first.text.slice(prog.length));
  return { unsafe: first.unsafe || second.unsafe, argv: argvOf(second.text) };
}

describe('spawnCommand', () => {
  const tricky = [
    'a & b', 'a"&b', 'say "hi" | more', '(x86) ^caret <in> >out', '100% done!',
    'C:\\Users\\Jane Doe\\vault', 'C:\\vault\\', 'sandbox_mode="workspace-write"',
    `sandbox_workspace_write.writable_roots=${JSON.stringify(['C:\\Users\\Jane Doe\\vault'])}`, '',
  ];

  it('gets every argument through cmd.exe and the shim unchanged, with nothing left to run as a command', () => {
    const r = shimSees(SHIM, tricky);
    expect(r.unsafe).toBe(false);
    expect(r.argv).toEqual(tricky);
  });

  it('gets the real Codex and Claude arguments through for a vault path with a space', () => {
    const vault = 'C:\\Users\\Jane Doe\\My Vault';
    for (const args of [
      headlessArgs('codex', { sessionId: ID, threadId: 'T1', extraDir: vault }, 'hi'),
      headlessArgs('claude', { sessionId: ID, extraDir: vault }, 'hi'),
      headlessArgs('gemini', { sessionId: ID, extraDir: vault, promptOnStdin: true }, 'hi'),
    ]) {
      const r = shimSees(SHIM, args);
      expect(r.unsafe).toBe(false);
      expect(r.argv).toEqual(args);
    }
  });

  it('the checks above would catch plain joining (what shell: true does)', () => {
    const naive = cmdReads(`"${SHIM}" ${tricky.join(' ')}`);
    expect(naive.unsafe).toBe(true);
  });

  it('refuses an argument with a line break, which cmd.exe cannot carry', () => {
    expect(() => spawnCommand(SHIM, ['-p', 'line one\nline two'], 'win32', COMSPEC)).toThrow(/line break/);
  });

  it('leaves .exe files, bare names and other platforms alone', () => {
    const args = ['-p', 'a & b\nc'];
    expect(spawnCommand('C:\\bin\\claude.exe', args, 'win32', COMSPEC)).toEqual({ command: 'C:\\bin\\claude.exe', args });
    expect(spawnCommand('claude', args, 'win32', COMSPEC)).toEqual({ command: 'claude', args });
    expect(spawnCommand('/usr/bin/codex', args, 'darwin', COMSPEC)).toEqual({ command: '/usr/bin/codex', args });
    expect(spawnCommand('/usr/bin/codex.cmd', args, 'linux', COMSPEC)).toEqual({ command: '/usr/bin/codex.cmd', args });
  });

  it('treats .bat like .cmd', () => {
    expect(spawnCommand('C:\\npm\\gemini.BAT', ['x'], 'win32', COMSPEC).command).toBe(COMSPEC);
  });
});

describe('promptOnStdin', () => {
  it('keeps Gemini on -p, except through cmd.exe; the others always read stdin', () => {
    expect(promptOnStdin('gemini', '/usr/local/bin/gemini', 'darwin')).toBe(false);
    expect(promptOnStdin('gemini', 'C:\\bin\\gemini.exe', 'win32')).toBe(false);
    expect(promptOnStdin('gemini', 'C:\\npm\\gemini.cmd', 'win32')).toBe(true);
    expect(promptOnStdin('codex', '/usr/local/bin/codex', 'darwin')).toBe(true);
    expect(promptOnStdin('claude', 'C:\\bin\\claude.exe', 'win32')).toBe(true);
  });

  it('leaves -p out of the Gemini arguments when the letter goes on stdin', () => {
    expect(headlessArgs('gemini', { sessionId: ID, promptOnStdin: true }, 'hi')).toEqual(
      ['--session-id', ID, '--approval-mode', 'auto_edit', '--skip-trust', '-o', 'json'],
    );
  });
});

describe('resumeShell', () => {
  it('reopens the right session in its folder', () => {
    expect(resumeShell('codex', "/My Vault's", 'T1')).toBe(`cd '/My Vault'\\''s' && codex resume 'T1'`);
    expect(resumeShell('gemini', '/v', ID)).toBe(`cd '/v' && gemini --resume '${ID}'`);
  });
});
