import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decideReach, harnessLoggedIn, legacyReach, unknownHarnessReach, type ReachFacts } from './reach.ts';

const claude = (f: Partial<ReachFacts> = {}): ReachFacts => ({
  harness: 'claude', label: 'Claude Code', headless: false, autoStart: false,
  hookInstalled: false, cliInstalled: false, loggedIn: true, canOpenTerminal: true, ...f,
});
const codex = (f: Partial<ReachFacts> = {}): ReachFacts => ({
  harness: 'codex', label: 'Codex', headless: true, autoStart: true,
  hookInstalled: false, cliInstalled: true, loggedIn: true, canOpenTerminal: true, ...f,
});

describe('decideReach: Claude Code', () => {
  it('an open session that takes letters gets it now, wherever it runs', () => {
    expect(decideReach(claude({ open: true, desktop: true }))).toMatchObject({ level: 'now', text: expect.stringContaining('Claude 客户端') });
    expect(decideReach(claude({ open: true }))).toMatchObject({ level: 'now', text: expect.stringContaining('终端') });
  });
  it('a closed plugin-created session is opened in a terminal', () => {
    expect(decideReach(claude({ autoStart: true, cliInstalled: true }))).toMatchObject({ level: 'now' });
    expect(decideReach(claude({ autoStart: true, cliInstalled: false })).level).not.toBe('now');
  });
  it('bypass or closed sessions wait for the hook', () => {
    expect(decideReach(claude({ open: true, holds: true, hookInstalled: true }))).toMatchObject({ level: 'later', text: expect.stringContaining('跳过了权限确认') });
    expect(decideReach(claude({ open: true, holds: true, hookInstalled: true })).text).toContain('换个权限模式');
    expect(decideReach(claude({ hookInstalled: true }))).toMatchObject({ level: 'later' });
  });
  it('without the hook nobody reads it, and the fix is the hook', () => {
    expect(decideReach(claude({ open: true, holds: true }))).toMatchObject({ level: 'none', fix: 'hook' });
    expect(decideReach(claude())).toMatchObject({ level: 'none', fix: 'hook' });
  });
});

describe('decideReach: Codex / Gemini', () => {
  it('answers in the background when installed and signed in', () => {
    expect(decideReach(codex())).toMatchObject({ level: 'now', text: '在后台回复' });
  });
  it('says what is missing', () => {
    expect(decideReach(codex({ loggedIn: false }))).toMatchObject({ level: 'none', fix: 'login' });
    expect(decideReach(codex({ cliInstalled: false }))).toMatchObject({ level: 'none', text: expect.stringContaining('没找到 Codex') });
    expect(decideReach(codex({ autoStart: false }))).toMatchObject({ level: 'none', text: expect.stringContaining('不会自己看信箱') });
  });
});

it('an unknown harness says its letters only wait in the mailbox', () => {
  expect(unknownHarnessReach('cursor')).toMatchObject({ level: 'later', text: expect.stringContaining('cursor') });
});

it('legacy roster presence maps onto the same levels', () => {
  expect([legacyReach('在线').level, legacyReach('闲置').level, legacyReach('离线').level]).toEqual(['now', 'later', 'none']);
});

describe('harnessLoggedIn', () => {
  it('reads the files the CLIs write when signed in, or an API key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ilc-login-'));
    try {
      expect(await harnessLoggedIn('codex', home, {})).toBe(false);
      expect(await harnessLoggedIn('codex', home, { OPENAI_API_KEY: 'k' })).toBe(true);
      mkdirSync(join(home, '.codex'));
      writeFileSync(join(home, '.codex', 'auth.json'), '{}');
      expect(await harnessLoggedIn('codex', home, {})).toBe(true);
      expect(await harnessLoggedIn('gemini', home, {})).toBe(false);
      mkdirSync(join(home, '.gemini'));
      writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{}');
      expect(await harnessLoggedIn('gemini', home, {})).toBe(true);
      expect(await harnessLoggedIn('claude', home, {})).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
