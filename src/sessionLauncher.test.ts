import { describe, it, expect } from 'vitest';
import { buildLaunchPlan, buildLaunchPrompt } from './sessionLauncher.ts';

describe('buildLaunchPlan', () => {
  it('starts a brand-new session with --session-id and the prompt file', () => {
    const p = buildLaunchPlan({ sessionId: 'abc', cwd: "/Users/x/My Vault's", promptFile: '/tmp/p.txt', exists: false });
    expect(p.mode).toBe('new');
    expect(p.shell).toBe(`cd '/Users/x/My Vault'\\''s' && claude --session-id 'abc' "$(cat '/tmp/p.txt')"`);
  });
  it('resumes a known session, prompt optional', () => {
    const p = buildLaunchPlan({ sessionId: 'abc', cwd: '/v', exists: true });
    expect(p.mode).toBe('resume');
    expect(p.shell).toBe(`cd '/v' && claude --resume 'abc'`);
  });
});

describe('buildLaunchPrompt', () => {
  it("names the member and shows the reply format with today's date", () => {
    const s = buildLaunchPrompt('日记助理', '- 文档：a.md\n- 留言内容：hi', '2026-09-03');
    expect(s).toContain('你在评论区的名字：日记助理');
    expect(s).toContain('{>>日记助理|2026-09-03|reply: 你的回复<<}');
    expect(s).toContain('- 留言内容：hi');
  });
});
