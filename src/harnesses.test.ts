import { describe, it, expect } from 'vitest';
import { harnessDef, headlessArgs, looksUnauthenticated, parseHeadlessOutput, resumeShell } from './harnesses.ts';

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
  it('reads Gemini JSON; a failed first run proves no session', () => {
    expect(parseHeadlessOutput('gemini', `{"session_id":"${ID}","response":"ok"}`, 0, ID)).toEqual({ ok: true, threadId: ID, error: undefined });
    const failed = parseHeadlessOutput('gemini', `{"session_id":"${ID}","error":{"message":"Please set an Auth method"}}`, 41, ID);
    expect(failed.ok).toBe(false);
    expect(failed.threadId).toBeUndefined();
    expect(looksUnauthenticated(failed.error)).toBe(true);
  });
});

describe('resumeShell', () => {
  it('reopens the right session in its folder', () => {
    expect(resumeShell('codex', "/My Vault's", 'T1')).toBe(`cd '/My Vault'\\''s' && codex resume 'T1'`);
    expect(resumeShell('gemini', '/v', ID)).toBe(`cd '/v' && gemini --resume '${ID}'`);
  });
});
