import { describe, it, expect } from 'vitest';
import { cleanTitle, shortCwd } from './sessionDiscovery.ts';

describe('cleanTitle', () => {
  it('skips what the harness injects before the first real message', () => {
    expect(cleanTitle('## Skills\nA skill is a set of local instructions to follow')).toBeUndefined();
    expect(cleanTitle('# AGENTS.md instructions for /repo')).toBeUndefined();
    expect(cleanTitle('Auto mode lets Claude handle permission prompts automatically')).toBeUndefined();
  });
  it('keeps a real first message, shortened', () => {
    expect(cleanTitle('请检查 Obsidian 信箱留言')).toBe('请检查 Obsidian 信箱留言');
    const long = 'please look at the retention numbers for week two and tell me why';
    expect(cleanTitle(long)).toBe(`${long.slice(0, 48)}…`);
  });
});

describe('shortCwd', () => {
  const home = '/Users/me';
  it('keeps a short folder as it is, home as ~', () => {
    expect(shortCwd('/Users/me/developer/repo', home)).toBe('~/developer/repo');
    expect(shortCwd('/opt/app', home)).toBe('/opt/app');
    expect(shortCwd(undefined, home)).toBeUndefined();
  });
  it('elides the middle of a long one: where it starts and its last two folders stay', () => {
    expect(shortCwd('/Users/me/vaults/main-2026-10-05/项目/obsidian搭建/评论插件', home)).toBe('~/vaults/…/obsidian搭建/评论插件');
    expect(shortCwd('/srv/work/clients/acme/site/app', home)).toBe('/srv/…/site/app');
  });
});
