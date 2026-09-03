#!/usr/bin/env node
/**
 * Dump computed rendering metrics of the panel inside real Obsidian, so the
 * result can be diffed against any other rendering (e.g. the static preview).
 *
 * Usage: node e2e/metrics.mjs > e2e/out/metrics-obsidian.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { startObsidian, sleep, OUT, METRICS_FN } from './lib.mjs';

const { page, stop } = await startObsidian();
try {
  // Same UI state as the visual comparison: second card active, "@" typed
  await page.locator('.ilc-card').nth(1).click();
  await page.waitForSelector('.ilc-card-active .ilc-reply-input', { state: 'visible', timeout: 5000 });
  await page.locator('.ilc-card-active .ilc-reply-input').click();
  await page.keyboard.type('@');
  await page.waitForSelector('.ilc-at-dropdown', { timeout: 5000 });
  await sleep(200);

  const metrics = await page.evaluate(METRICS_FN);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'metrics-obsidian.json');
  fs.writeFileSync(file, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
} finally {
  await stop();
}
