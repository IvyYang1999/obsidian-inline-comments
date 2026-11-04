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
  it('where no terminal can be opened, the start command is offered instead (even without the hook)', () => {
    expect(decideReach(claude({ autoStart: true, cliInstalled: true, canOpenTerminal: false }))).toMatchObject({ level: 'later', text: expect.stringContaining('复制启动命令') });
    expect(decideReach(claude({ autoStart: true, cliInstalled: true, canOpenTerminal: false })).fix).toBeUndefined();
  });
  it('bypass or closed sessions wait for the hook', () => {
    expect(decideReach(claude({ open: true, holds: true, hookInstalled: true }))).toMatchObject({ level: 'later', text: expect.stringContaining('跳过了权限确认') });
    expect(decideReach(claude({ open: true, holds: true, hookInstalled: true })).text).toContain('换个权限模式');
    expect(decideReach(claude({ hookInstalled: true }))).toMatchObject({ level: 'later' });
  });
  it('a running session without an inbox is open, not closed', () => {
    expect(decideReach(claude({ open: true, noInbox: true, hookInstalled: true, autoStart: true, cliInstalled: true }))).toMatchObject({ level: 'later', text: expect.stringContaining('开着') });
    expect(decideReach(claude({ open: true, noInbox: true }))).toMatchObject({ level: 'none', fix: 'hook' });
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
  it('a background run settles it either way; before one, Codex itself and its config are asked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ilc-login-'));
    try {
      expect(await harnessLoggedIn('codex', home, {}, { lastRun: true })).toBe(true);
      expect(await harnessLoggedIn('gemini', home, {}, { lastRun: true })).toBe(true);
      expect(await harnessLoggedIn('codex', home, { OPENAI_API_KEY: 'k' }, { lastRun: false })).toBe(false);
      // credentials in the system keyring leave no file: `codex login status` knows
      expect(await harnessLoggedIn('codex', home, {}, { askCli: async () => true })).toBe(true);
      expect(await harnessLoggedIn('codex', home, {}, { askCli: async () => false })).toBe(false);
      // another provider's credentials are its own business: don't claim it is signed out
      mkdirSync(join(home, '.codex'));
      writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n[profiles.local]\nmodel_provider = "ollama"\n');
      expect(await harnessLoggedIn('codex', home, {})).toBe(true);
      writeFileSync(join(home, '.codex', 'config.toml'), 'model_provider = "openai"\n');
      expect(await harnessLoggedIn('codex', home, {})).toBe(false);
      expect(await harnessLoggedIn('codex', home, { CODEX_HOME: join(home, 'elsewhere') }, { askCli: async () => true })).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('decideReach: a session whose inbox file was deleted', () => {
  it('says the file is gone and that restarting the session fixes it', () => {
    expect(decideReach(claude({ open: true, noInbox: true, inboxGone: true, hookInstalled: true }))).toMatchObject({ level: 'later', text: expect.stringContaining('收信口文件不见了') });
    expect(decideReach(claude({ open: true, noInbox: true, inboxGone: true }))).toMatchObject({ level: 'none', fix: 'hook', text: expect.stringContaining('重开这个会话') });
    expect(decideReach(claude({ open: true, noInbox: true, hookInstalled: true })).text).toContain('没开收信口');
  });
});
