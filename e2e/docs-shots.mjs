#!/usr/bin/env node
/**
 * Real-Obsidian screenshots for the README (English UI, coherent demo note).
 *
 * Boots the same isolated Obsidian the e2e uses, but with `language: en`, the
 * note from docs/demo/ and two English members, then captures:
 *   docs/obsidian-en.png   editor + panel + explorer badge
 *   docs/reading-en.png    the same note in reading view
 *   docs/picker-en.png     the @ picker inside a reply box
 *
 * Usage: npm run build && node e2e/docs-shots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { WORK, launch, setupVault, sleep, waitForPlugin } from './lib.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(ROOT, 'docs');
const NOTE = 'August review';

const { userdata } = setupVault();
const vault = path.join(WORK, 'vault');
// English UI, English note, English members
fs.writeFileSync(path.join(vault, '.obsidian', 'plugins', 'inline-comments', 'data.json'), JSON.stringify({ authorName: 'yyt', language: 'en', enableMentionDelivery: false }, null, 2));
fs.copyFileSync(path.join(ROOT, 'docs', 'demo', `${NOTE}.md`), path.join(vault, `${NOTE}.md`));
fs.rmSync(path.join(vault, 'sample.md'), { force: true });
fs.writeFileSync(path.join(vault, '_os', 'comment-agents.json'), JSON.stringify({ agents: [
  { name: 'Reviewer', sessionId: '3f9a12c0-aaaa-bbbb-cccc-000000000001', harness: 'claude', joinedAt: '2026-09-01T00:00:00Z' },
  { name: 'Auditor', sessionId: '7b2e44d1-aaaa-bbbb-cccc-000000000002', harness: 'codex', joinedAt: '2026-09-01T00:00:00Z' },
] }, null, 2));
for (const f of ['花名册.md', '在场.md']) fs.rmSync(path.join(vault, '_os', f), { force: true });

const { proc, browser, page } = await launch(userdata);
try {
  await waitForPlugin(page);
  await page.evaluate((n) => app.workspace.openLinkText(n, '', false), NOTE);
  await page.waitForSelector('.cm-editor', { timeout: 15000 });
  await page.evaluate(() => app.commands.executeCommandById('inline-comments:open-comments-panel'));
  await page.waitForSelector('.ilc-panel .ilc-card', { timeout: 15000 });
  await sleep(900);
  await page.evaluate(() => { const p = app.plugins.plugins['inline-comments'].getPanel(); p.activeAnnotationId = null; return p.refresh(); });
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, 'obsidian-en.png') });
  console.log('obsidian-en.png');

  // @ picker inside the first card's reply box
  const first = page.locator('.ilc-card').first();
  await first.click();
  await sleep(300);
  await first.locator('.ilc-reply-input').fill('Can you double-check the cohort? @');
  await first.locator('.ilc-reply-input').press('End');
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, 'picker-en.png'), clip: await page.locator('.ilc-panel').boundingBox() });
  console.log('picker-en.png');
  await page.keyboard.press('Escape');

  // Reading view
  await page.evaluate(async () => { const leaf = app.workspace.getLeavesOfType('markdown')[0]; const st = leaf.getViewState(); st.state = { ...st.state, mode: 'preview' }; await leaf.setViewState(st, { focus: true }); });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'reading-en.png') });
  console.log('reading-en.png');
} finally {
  await browser.close();
  proc.kill();
}
