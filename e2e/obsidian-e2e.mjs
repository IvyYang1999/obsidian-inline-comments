#!/usr/bin/env node
/**
 * Real-Obsidian e2e for the comment panel.
 *
 * Launches an isolated Obsidian instance (own user-data-dir, own vault) with the
 * freshly built plugin, attaches Playwright over CDP, drives the UI and asserts
 * the things that bit us in real use: opaque surfaces, visible borders, date
 * flush right, single-line quote rule, @ dropdown layout, optimistic mark-as-read,
 * and the right-click "添加划线评论" menu item.
 *
 * The test vault copies the REAL vault's appearance (theme, snippets, app.json)
 * so what we screenshot is what the user sees — that is the whole point.
 *
 * Usage:  node e2e/obsidian-e2e.mjs            (after `npm run build`)
 * Env:    ILC_E2E_DIR   work dir (default: os.tmpdir()/ilc-e2e)
 *         ILC_REAL_VAULT real vault to copy appearance from (default ~/Vaults/main)
 *         ILC_CDP_PORT   default 9444
 *         ILC_KEEP=1     keep Obsidian running after the run
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e', 'out');
const WORK = process.env.ILC_E2E_DIR || path.join(os.tmpdir(), 'ilc-e2e');
const REAL_VAULT = process.env.ILC_REAL_VAULT || path.join(os.homedir(), 'Vaults', 'main');
const PORT = Number(process.env.ILC_CDP_PORT || 9444);
const OBSIDIAN_BIN = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
const PLUGIN_ID = 'obsidian-inline-comments';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Build the isolated vault + user-data-dir ─────────────────────────────
function setupVault() {
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

// ─── 2. Launch Obsidian and attach over CDP ──────────────────────────────────
async function launch(userdata) {
  const proc = spawn(OBSIDIAN_BIN, [`--user-data-dir=${userdata}`, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    detached: false,
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

async function waitForPlugin(page) {
  try {
    await page.waitForFunction(
      (id) => !!globalThis.app?.plugins?.plugins?.[id],
      PLUGIN_ID,
      { timeout: 20000 },
    );
  } catch {
    // Restricted mode on a fresh vault — enable community plugins programmatically
    await page.evaluate(async (id) => {
      await app.plugins.setEnable(true);
      await app.plugins.enablePlugin(id);
    }, PLUGIN_ID);
    await page.waitForFunction((id) => !!globalThis.app?.plugins?.plugins?.[id], PLUGIN_ID, { timeout: 20000 });
  }
  // Dismiss any first-run modal
  await page.keyboard.press('Escape').catch(() => {});
}

// ─── 3. Scenarios ────────────────────────────────────────────────────────────
async function shot(page, name, selector) {
  const file = path.join(OUT, `${name}.png`);
  if (selector) {
    const el = page.locator(selector).first();
    await el.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file });
  }
  return file;
}

const isOpaque = (rgba) => !/rgba\(/.test(rgba) || /,\s*1\)$/.test(rgba);

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const { userdata } = setupVault();
  const { proc, browser, page } = await launch(userdata);
  try {
    await waitForPlugin(page);
    await page.evaluate(() => app.workspace.openLinkText('sample', '', false));
    await page.waitForSelector('.cm-editor', { timeout: 15000 });
    await page.evaluate(() => app.commands.executeCommandById('obsidian-inline-comments:open-comments-panel'));
    await page.waitForSelector('.ilc-panel .ilc-card', { timeout: 15000 });
    await sleep(600); // let layout settle

    // ── Panel basics
    const cardCount = await page.locator('.ilc-card').count();
    check('4 张卡片渲染', cardCount === 4, `count=${cardCount}`);

    const previews = await page.locator('.ilc-card-preview-text').allTextContents();
    check('预览条无原始 markdown', previews.every((t) => !t.includes('**')), previews.join(' | '));

    const cardStyle = await page.evaluate(() => {
      const c = document.querySelector('.ilc-card');
      const cs = getComputedStyle(c);
      return { bg: cs.backgroundColor, border: cs.borderTopColor, borderW: cs.borderTopWidth };
    });
    check('卡片背景不透明', isOpaque(cardStyle.bg), cardStyle.bg);
    check('卡片边线可见', cardStyle.borderW !== '0px' && cardStyle.border !== 'rgba(0, 0, 0, 0)', `${cardStyle.borderW} ${cardStyle.border}`);

    const ruleVsText = await page.evaluate(() => {
      const rule = document.querySelector('.ilc-card-quote-rule').getBoundingClientRect();
      const text = document.querySelector('.ilc-card-preview-text').getBoundingClientRect();
      return { rule: rule.height, text: text.height };
    });
    check('引文竖线不高于文字行', ruleVsText.rule <= ruleVsText.text + 2, `rule=${ruleVsText.rule.toFixed(1)} text=${ruleVsText.text.toFixed(1)}`);

    const dateGap = await page.evaluate(() => {
      const h = document.querySelector('.ilc-entry-header').getBoundingClientRect();
      const d = document.querySelector('.ilc-entry-date').getBoundingClientRect();
      return h.right - d.right;
    });
    check('日期贴右', dateGap <= 4, `gap=${dateGap.toFixed(1)}px`);

    // Cards follow anchors: never above the anchor; a card with room above sits on it
    const anchorCheck = await page.evaluate(() => {
      const view = app.workspace.getLeavesOfType('markdown')[0].view;
      const cm = view.editor.cm;
      const scroller = cm.scrollDOM.getBoundingClientRect();
      return [...document.querySelectorAll('.ilc-card')].map((card) => {
        const from = Number(card.dataset.annotationId.replace('ann-', ''));
        const c = cm.coordsAtPos(from + 3);
        const anchor = c ? c.top - scroller.top + cm.scrollDOM.scrollTop : null;
        return { top: parseFloat(card.style.top), anchor };
      });
    });
    const neverAbove = anchorCheck.every((c) => c.anchor === null || c.top >= c.anchor - 4);
    check('未选中时卡片不高于锚点', neverAbove, anchorCheck.map((c) => `${Math.round(c.top)}/${c.anchor === null ? '?' : Math.round(c.anchor)}`).join(' '));

    // Focused card must sit exactly on its anchor (cards above yield upward)
    await page.locator('.ilc-card').last().click();
    await sleep(400);
    const focusAlign = await page.evaluate(() => {
      const view = app.workspace.getLeavesOfType('markdown')[0].view;
      const cm = view.editor.cm;
      const scroller = cm.scrollDOM.getBoundingClientRect();
      const card = document.querySelector('.ilc-card-active');
      const from = Number(card.dataset.annotationId.replace('ann-', ''));
      const c = cm.coordsAtPos(from + 3);
      const anchor = c ? c.top - scroller.top + cm.scrollDOM.scrollTop : null;
      const cards = [...document.querySelectorAll('.ilc-card')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
      const rects = cards.map((e) => e.getBoundingClientRect());
      let overlap = false;
      for (let i = 1; i < rects.length; i++) if (rects[i].top < rects[i - 1].bottom - 1) overlap = true;
      // minimal top the focused card can reach: everything above stacked from 8px
      let feasible = 8;
      for (const c of cards) { if (c === card) break; feasible += c.offsetHeight + 8; }
      return { top: parseFloat(card.style.top), anchor, overlap, feasible };
    });
    const expected = Math.max(focusAlign.anchor ?? 0, focusAlign.feasible);
    check('选中的卡片贴着锚点（上方卡片让位）', focusAlign.anchor !== null && Math.abs(focusAlign.top - expected) < 4, `top=${Math.round(focusAlign.top)} anchor=${Math.round(focusAlign.anchor ?? -1)} feasible=${Math.round(focusAlign.feasible)}`);
    check('让位后仍互不重叠', !focusAlign.overlap);
    await shot(page, '01b-focus-aligned', '.workspace-leaf-content[data-type="ilc-comments-panel"]');

    const overlap = await page.$$eval('.ilc-card', (els) => {
      const rects = els.map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      for (let i = 1; i < rects.length; i++) if (rects[i].top < rects[i - 1].bottom - 1) return true;
      return false;
    });
    check('卡片互不重叠', !overlap);

    await shot(page, '01-panel', '.workspace-leaf-content[data-type="ilc-comments-panel"]');

    // ── Active card + reply box
    await page.locator('.ilc-card').nth(1).click();
    await page.waitForSelector('.ilc-card-active .ilc-reply-input', { state: 'visible', timeout: 5000 });
    await sleep(300);
    const ta = await page.evaluate(() => {
      const t = document.querySelector('.ilc-card-active .ilc-reply-input');
      const cs = getComputedStyle(t);
      const card = getComputedStyle(t.closest('.ilc-card'));
      return { bg: cs.backgroundColor, border: cs.borderTopColor, cardBg: card.backgroundColor };
    });
    check('回复框有底色（与卡片不同色）', ta.bg !== 'rgba(0, 0, 0, 0)' && ta.bg !== ta.cardBg, `ta=${ta.bg} card=${ta.cardBg}`);
    check('回复框有边线', ta.border !== 'rgba(0, 0, 0, 0)', ta.border);
    await shot(page, '02-active-card', '.ilc-card-active');

    // ── @ dropdown
    await page.locator('.ilc-card-active .ilc-reply-input').click();
    await page.keyboard.type('@');
    await page.waitForSelector('.ilc-at-dropdown', { timeout: 5000 });
    await sleep(200);
    const dd = await page.evaluate(() => {
      const d = document.querySelector('.ilc-at-dropdown');
      const cs = getComputedStyle(d);
      const names = [...d.querySelectorAll('.ilc-at-name')].map((n) => ({
        text: n.textContent,
        h: n.getBoundingClientRect().height,
        lines: n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).lineHeight || '16'),
      }));
      return { bg: cs.backgroundColor, items: d.querySelectorAll('.ilc-at-item').length, names, sources: [...d.querySelectorAll('.ilc-at-source')].map((s) => s.textContent) };
    });
    check('@ 下拉背景不透明', isOpaque(dd.bg), dd.bg);
    check('@ 下拉列出 4 位成员', dd.items === 4, `items=${dd.items}`);
    check('名字单行不竖排', dd.names.every((n) => n.lines < 1.5), dd.names.map((n) => `${n.text}:${n.h.toFixed(0)}px`).join(' '));
    check('自助成员显示来源胶囊', dd.sources.some((s) => s.includes('自助')), dd.sources.join(','));
    await shot(page, '03-at-dropdown', '.workspace-leaf-content[data-type="ilc-comments-panel"]');

    // filter + keyboard
    await page.keyboard.type('审');
    await sleep(150);
    const filtered = await page.locator('.ilc-at-item').count();
    check('输入后实时过滤', filtered === 1, `items=${filtered}`);
    await page.keyboard.press('Enter');
    await sleep(150);
    const val = await page.locator('.ilc-card-active .ilc-reply-input').inputValue();
    check('⏎ 插入结构化 @', /\[@审计员\]\(agent:[0-9a-f]{8}\?notify\)/.test(val), val);
    const ddGone = (await page.locator('.ilc-at-dropdown').count()) === 0;
    check('选择后下拉关闭', ddGone);

    // ── Mark as read (optimistic)
    const unreadBefore = await page.locator('.ilc-entry-unread').count();
    const headerBefore = await page.locator('.ilc-panel-header').textContent();
    await page.locator('.ilc-read-btn').first().click();
    await sleep(80); // must be instant — no vault rescan in the way
    const unreadAfter = await page.locator('.ilc-entry-unread').count();
    const headerAfter = await page.locator('.ilc-panel-header').textContent();
    check('标为已读立即生效', unreadAfter === unreadBefore - 1, `${unreadBefore} → ${unreadAfter}`);
    check('面板头未读数同步减一', headerBefore !== headerAfter, `${headerBefore} → ${headerAfter}`);
    const ownReplyHasBtn = await page.evaluate(() =>
      [...document.querySelectorAll('.ilc-entry-reply')].some((e) => e.querySelector('.ilc-entry-author')?.textContent === 'yyt' && e.querySelector('.ilc-read-btn')),
    );
    check('自己的回复没有「标为已读」', !ownReplyHasBtn);

    // ── Right-click → 添加划线评论 (right-click INSIDE the selection)
    const selPoint = await page.evaluate(() => {
      const view = app.workspace.getLeavesOfType('markdown')[0].view;
      const ed = view.editor;
      ed.setSelection({ line: 2, ch: 0 }, { line: 2, ch: 8 });
      ed.focus();
      const c = ed.cm.coordsAtPos(ed.posToOffset({ line: 2, ch: 4 }));
      return { x: c.left + 2, y: (c.top + c.bottom) / 2 };
    });
    try {
      // Focus the editor leaf, then open the editor context menu via Obsidian's own
      // command (same `editor-menu` event a real right-click fires; CDP right-clicks
      // don't reach CodeMirror reliably).
      await page.evaluate(() => {
        const leaf = app.workspace.getLeavesOfType('markdown')[0];
        app.workspace.setActiveLeaf(leaf, { focus: true });
        leaf.view.editor.focus();
      });
      await page.mouse.click(selPoint.x, selPoint.y, { button: 'right' });
      let menuOpen = await page.waitForSelector('.menu', { timeout: 1500 }).then(() => true).catch(() => false);
      if (!menuOpen) {
        await page.evaluate(() => app.commands.executeCommandById('editor:context-menu'));
        menuOpen = await page.waitForSelector('.menu', { timeout: 3000 }).then(() => true).catch(() => false);
      }
      if (!menuOpen) {
        await shot(page, '04-context-menu-FAILED');
        const dbg = await page.evaluate(() => ({
          cmds: Object.keys(app.commands.commands).filter((k) => /context|menu/i.test(k)),
          activeLeafType: app.workspace.activeLeaf?.view?.getViewType(),
          sel: app.workspace.getLeavesOfType('markdown')[0].view.editor.getSelection(),
          menus: document.querySelectorAll('.menu, .suggestion-container, .menu-item').length,
        }));
        check('右键菜单弹出', false, JSON.stringify(dbg));
      } else {
        const menuItems = await page.locator('.menu .menu-item-title').allTextContents();
        check('右键菜单含「添加划线评论」', menuItems.includes('添加划线评论'), menuItems.slice(0, 8).join(' / '));
        await shot(page, '04-context-menu');
        await page.locator('.menu .menu-item', { hasText: '添加划线评论' }).click();
        await page.waitForSelector('.ilc-card-draft', { timeout: 5000 });
        await sleep(300);
        check('草稿卡片出现', (await page.locator('.ilc-card-draft').count()) === 1);
        await shot(page, '05-draft-card', '.ilc-card-draft');
        await page.keyboard.press('Escape');
      }
    } catch (e) {
      await shot(page, '04-context-menu-CRASH').catch(() => {});
      check('右键菜单流程', false, String(e.message).split('\n')[0]);
    }

    await shot(page, '06-full-window');
  } finally {
    const failed = results.filter((r) => !r.ok);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
    console.log(`screenshots → ${OUT}`);
    if (!process.env.ILC_KEEP) {
      await browser.close().catch(() => {});
      proc.kill('SIGTERM');
    }
    process.exitCode = failed.length ? 1 : 0;
  }
}

run().catch((e) => {
  console.error('e2e crashed:', e);
  process.exit(2);
});
