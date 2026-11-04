import { describe, it, expect } from 'vitest';
import { shortCwd } from './sessionDiscovery.ts';

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
