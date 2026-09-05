/**
 * Shared harness: isolated Obsidian instance + Playwright over CDP.
 * Used by obsidian-e2e.mjs (assertions) and metrics.mjs (measurements).
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'e2e', 'out');
export const WORK = process.env.ILC_E2E_DIR || path.join(os.tmpdir(), 'ilc-e2e');
export const REAL_VAULT = process.env.ILC_REAL_VAULT || path.join(os.homedir(), 'Vaults', 'main');
export const PORT = Number(process.env.ILC_CDP_PORT || 9444);
export const OBSIDIAN_BIN = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
export const PLUGIN_ID = 'inline-comments';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build the isolated vault (plugin + fixtures + the real vault's appearance) and user-data-dir */
export function setupVault() {
  fs.rmSync(WORK, { recursive: true, force: true });
  const vault = path.join(WORK, 'vault');
  const userdata = path.join(WORK, 'userdata');
  const obs = path.join(vault, '.obsidian');
  const pluginDir = path.join(obs, 'plugins', PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(userdata, { recursive: true });

  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(pluginDir, f));
  }
  fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify({ authorName: 'yyt' }, null, 2));
  fs.writeFileSync(path.join(obs, 'community-plugins.json'), JSON.stringify([PLUGIN_ID]));

  // Mirror the real vault's look: theme choice, snippets, app settings
  const realObs = path.join(REAL_VAULT, '.obsidian');
  for (const f of ['appearance.json', 'app.json']) {
    const src = path.join(realObs, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(obs, f));
  }
  // Native (macOS) menus live outside the DOM — force Obsidian's own .menu so the
  // right-click flow can be observed. Everything else stays as the user has it.
  try {
    const ap = path.join(obs, 'appearance.json');
    const cfg = fs.existsSync(ap) ? JSON.parse(fs.readFileSync(ap, 'utf8')) : {};
    cfg.nativeMenus = false;
    fs.writeFileSync(ap, JSON.stringify(cfg, null, 2));
  } catch {}
  for (const d of ['themes', 'snippets']) {
    const src = path.join(realObs, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(obs, d), { recursive: true });
  }

  fs.cpSync(path.join(ROOT, 'e2e', 'fixtures'), vault, { recursive: true });

  fs.writeFileSync(
    path.join(userdata, 'obsidian.json'),
    JSON.stringify({ vaults: { e2e: { path: vault, ts: Date.now(), open: true } } }),
  );
  return { vault, userdata };
}

/** Launch Obsidian with remote debugging and attach Playwright */
export async function launch(userdata) {
  const home = path.join(WORK, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // Pre-existing foreign hook: the installer must keep it intact
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other-tool' }] }] } }, null, 2));
  const proc = spawn(OBSIDIAN_BIN, [`--user-data-dir=${userdata}`, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, ILC_HOME: home, ILC_LAUNCH_LOG: path.join(WORK, 'launch.log') },
  });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) break;
    } catch {}
    await sleep(400);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  let page = null;
  const pageDeadline = Date.now() + 30000;
  while (Date.now() < pageDeadline && !page) {
    page = ctx.pages().find((p) => p.url().startsWith('app://')) ?? null;
    if (!page) await sleep(300);
  }
  if (!page) throw new Error('Obsidian window not found over CDP');
  return { proc, browser, page };
}

export async function waitForPlugin(page) {
  try {
    await page.waitForFunction((id) => !!globalThis.app?.plugins?.plugins?.[id], PLUGIN_ID, { timeout: 20000 });
  } catch {
    // Restricted mode on a fresh vault — enable community plugins programmatically
    await page.evaluate(async (id) => {
      await app.plugins.setEnable(true);
      await app.plugins.enablePlugin(id);
    }, PLUGIN_ID);
    await page.waitForFunction((id) => !!globalThis.app?.plugins?.plugins?.[id], PLUGIN_ID, { timeout: 20000 });
  }
  await page.keyboard.press('Escape').catch(() => {});
}

/** Open the sample note and the comments panel; returns once cards are rendered */
export async function openSampleWithPanel(page) {
  await page.evaluate(() => app.workspace.openLinkText('sample', '', false));
  await page.waitForSelector('.cm-editor', { timeout: 15000 });
  await page.evaluate(() => app.commands.executeCommandById('inline-comments:open-comments-panel'));
  await page.waitForSelector('.ilc-panel .ilc-card', { timeout: 15000 });
  await sleep(600);
}

export async function shot(page, name, selector) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  try {
    if (selector) await page.locator(selector).first().screenshot({ path: file, timeout: 8000, animations: 'disabled' });
    else await page.screenshot({ path: file, timeout: 8000 });
  } catch (e) {
    // a screenshot is evidence, not a gate — never let it abort the run
    console.warn(`  (screenshot ${name} skipped: ${String(e.message).split('\n')[0]})`);
  }
  return file;
}

/** Start an isolated Obsidian with the plugin loaded and the sample + panel open */
export async function startObsidian() {
  const { userdata } = setupVault();
  const { proc, browser, page } = await launch(userdata);
  await waitForPlugin(page);
  await openSampleWithPanel(page);
  const stop = async () => {
    if (process.env.ILC_KEEP) return;
    await browser.close().catch(() => {});
    proc.kill('SIGTERM');
  };
  return { page, browser, proc, stop };
}

/**
 * Browser-side metrics dump — evaluated in whichever page hosts the panel DOM.
 * Keep this a plain function so it can be passed to page.evaluate as-is.
 */
export const METRICS_FN = `(() => {
  const pick = (el, props) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const o = { w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    for (const p of props) o[p] = cs[p];
    return o;
  };
  const text = ['fontFamily','fontSize','fontWeight','lineHeight','color','letterSpacing'];
  const box  = ['paddingTop','paddingRight','paddingBottom','paddingLeft','borderRadius','borderTopWidth','borderTopColor','backgroundColor','boxShadow','marginLeft','marginTop'];
  const q = (s) => document.querySelector(s);
  return {
    env: {
      dpr: window.devicePixelRatio,
      zoom: getComputedStyle(document.body).zoom,
      bodyFont: getComputedStyle(document.body).fontFamily,
      bodyFontSize: getComputedStyle(document.body).fontSize,
      bodyLineHeight: getComputedStyle(document.body).lineHeight,
      panelWidth: q('.ilc-panel')?.getBoundingClientRect().width,
      vars: Object.fromEntries(['--font-interface','--font-ui-small','--font-ui-smaller','--font-ui-medium','--text-normal','--text-muted','--text-faint','--background-primary','--background-secondary','--background-modifier-border','--interactive-accent','--line-height-tight','--font-weight'].map(v => [v, getComputedStyle(document.body).getPropertyValue(v).trim()])),
    },
    panel:        pick(q('.ilc-panel'), [...box]),
    header:       pick(q('.ilc-panel-header'), [...text, ...box]),
    card:         pick(q('.ilc-card'), [...box]),
    quoteRule:    pick(q('.ilc-card-quote-rule'), ['backgroundColor','width']),
    quoteText:    pick(q('.ilc-card-preview-text'), [...text]),
    preview:      pick(q('.ilc-card-preview'), [...box]),
    entry:        pick(q('.ilc-entry'), [...box]),
    avatar:       pick(q('.ilc-entry-avatar'), ['fontSize','fontWeight','backgroundColor']),
    author:       pick(q('.ilc-entry-author'), [...text]),
    chip:         pick(q('.ilc-entry-chip'), [...text, ...box]),
    date:         pick(q('.ilc-entry-date'), [...text]),
    body:         pick(q('.ilc-entry-body'), [...text, 'marginLeft','marginTop']),
    readBtn:      pick(q('.ilc-read-btn'), [...text, ...box]),
    replyInput:   pick(q('.ilc-card-active .ilc-reply-input'), [...text, ...box]),
    replySubmit:  pick(q('.ilc-card-active .ilc-reply-submit'), [...text, ...box]),
    atDropdown:   pick(q('.ilc-at-dropdown'), [...box]),
    atHead:       pick(q('.ilc-at-head'), [...text, ...box]),
    atItem:       pick(q('.ilc-at-item'), [...box]),
    atName:       pick(q('.ilc-at-name'), [...text]),
    atRole:       pick(q('.ilc-at-role'), [...text]),
    atSource:     pick(q('.ilc-at-source'), [...text, ...box]),
    mention:      pick(q('.ilc-mention'), [...text, ...box]),
  };
})()`;
