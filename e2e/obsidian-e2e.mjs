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
import fs from 'node:fs';
import path from 'node:path';
import { OUT, PLUGIN_ID, sleep, setupVault, launch, waitForPlugin, shot } from './lib.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
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
    check('5 张卡片渲染（含畸形嵌套段落解析出的 1 张）', cardCount === 5, `count=${cardCount}`);

    // Width budget: Obsidian's .view-content padding must not eat into the cards
    const widths = await page.evaluate(() => {
      const panel = document.querySelector('.ilc-panel');
      const card = document.querySelector('.ilc-card');
      const body = document.querySelector('.ilc-entry-body');
      const cs = getComputedStyle(panel);
      return { panel: panel.getBoundingClientRect().width, card: card.getBoundingClientRect().width, body: body.getBoundingClientRect().width, padL: cs.paddingLeft, padR: cs.paddingRight };
    });
    check('面板无多余内边距', widths.padL === '0px' && widths.padR === '0px', `${widths.padL}/${widths.padR}`);
    check('卡片占满面板宽度（≥ 面板 − 20）', widths.card >= widths.panel - 20, `panel=${widths.panel} card=${widths.card} body=${widths.body}`);

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

    // Cards follow anchors (screen space): never above the highlighted text
    const anchorCheck = await page.evaluate(() => {
      const view = app.workspace.getLeavesOfType('markdown')[0].view;
      const cm = view.editor.cm;
      return [...document.querySelectorAll('.ilc-card')].map((card) => {
        const from = Number(card.dataset.annotationId.replace('ann-', ''));
        const c = cm.coordsAtPos(from + 3);
        return { top: card.getBoundingClientRect().top, anchor: c ? c.top : null };
      });
    });
    const neverAbove = anchorCheck.every((c) => c.anchor === null || c.top >= c.anchor - 4);
    check('未选中时卡片不高于锚点', neverAbove, anchorCheck.map((c) => `${Math.round(c.top)}/${c.anchor === null ? '?' : Math.round(c.anchor)}`).join(' '));

    // Screen-space alignment: card top must meet the highlighted text's top (not just scroller coords)
    const screenAlign = await page.evaluate(() => {
      const view = app.workspace.getLeavesOfType('markdown')[0].view;
      const cm = view.editor.cm;
      const card = document.querySelector('.ilc-card');
      const from = Number(card.dataset.annotationId.replace('ann-', ''));
      const c = cm.coordsAtPos(from + 3);
      return { card: card.getBoundingClientRect().top, text: c?.top ?? null };
    });
    check('首张卡片与划线文字在屏幕上对齐（±6px）', screenAlign.text !== null && Math.abs(screenAlign.card - screenAlign.text) <= 6, `card=${Math.round(screenAlign.card)} text=${screenAlign.text === null ? '?' : Math.round(screenAlign.text)}`);

    // Focused card must sit exactly on its anchor (cards above yield upward) — screen space
    await page.locator('.ilc-card').last().click();
    await sleep(400);
    const focusAlign = await page.evaluate(() => {
      const view = app.workspace.getLeavesOfType('markdown')[0].view;
      const cm = view.editor.cm;
      const card = document.querySelector('.ilc-card-active');
      const from = Number(card.dataset.annotationId.replace('ann-', ''));
      const c = cm.coordsAtPos(from + 3);
      const cards = [...document.querySelectorAll('.ilc-card')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
      const rects = cards.map((e) => e.getBoundingClientRect());
      let overlap = false;
      for (let i = 1; i < rects.length; i++) if (rects[i].top < rects[i - 1].bottom - 1) overlap = true;
      // minimal screen top the focused card can reach: everything above stacked from 8px
      const zoneTop = document.querySelector('.ilc-cards-zone').getBoundingClientRect().top;
      let feasible = zoneTop + 8;
      for (const e of cards) { if (e === card) break; feasible += e.offsetHeight + 8; }
      return { top: card.getBoundingClientRect().top, anchor: c ? c.top : null, overlap, feasible };
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

    // ── In-plugin mention delivery (replaces the cron scanner)
    await page.evaluate(() => app.plugins.plugins['obsidian-inline-comments'].mentionDelivery.sweep(false));
    await sleep(500);
    const delivery = await page.evaluate(async () => {
      const a = app.vault.adapter;
      const list = async (dir) => (await a.exists(dir)) ? (await a.list(dir)).files : [];
      const feibao = await list('Agent协作空间/信箱/44444444');
      const shenji = await list('Agent协作空间/信箱/22222222');
      const letter = feibao[0] ? await a.read(feibao[0]) : '';
      const state = JSON.parse(await a.read('_os/.comment-mention-state.json'));
      return { feibao: feibao.length, shenji: shenji.length, letter, processed: state.processed.length };
    });
    check('yyt 的 @费宝（question）投递 1 封', delivery.feibao === 1, `feibao=${delivery.feibao}`);
    check('yyt 在回复里 @审计员 也投递', delivery.shenji === 1, `shenji=${delivery.shenji}`);
    check('Agent 的 reply 里 @费宝 不投（防自触发）', delivery.feibao === 1 && delivery.processed === 2, `processed=${delivery.processed}`);
    check('信的 frontmatter 契约', /^---\nfrom: comment-scanner\nto: 44444444-0000-1111\nurgency: 普通\nwake: true\nstatus: 未读\ncreated: /.test(delivery.letter), delivery.letter.split('\n').slice(0, 7).join(' | '));
    await page.evaluate(() => app.plugins.plugins['obsidian-inline-comments'].mentionDelivery.sweep(false));
    await sleep(300);
    const again = await page.evaluate(async () => (await app.vault.adapter.list('Agent协作空间/信箱/44444444')).files.length);
    check('重扫不重复投信', again === 1, `letters=${again}`);

    // ── Badge click → focus card, editor stays untouched (no raw markup reveal)
    const badgeCountBefore = await page.locator('.cm-editor .ilc-badge').count();
    const thirdId = await page.locator('.ilc-card').nth(2).getAttribute('data-annotation-id');
    await page.locator(`.cm-editor .ilc-badge[data-annotation-id="${thirdId}"]`).click();
    await sleep(500);
    const badgeState = await page.evaluate((id) => {
      const active = document.querySelector('.ilc-card-active');
      const ed = app.workspace.getLeavesOfType('markdown')[0].view.editor;
      const raw = document.querySelector('.cm-editor')?.innerText ?? '';
      return {
        activeId: active?.dataset.annotationId,
        badges: document.querySelectorAll('.cm-editor .ilc-badge').length,
        rawMarkupVisible: raw.includes('{==能同桌很暖') || raw.includes('{==今天入职'),
        cursor: ed.getCursor(),
      };
    }, thirdId);
    check('点角标 → 对应卡片激活', badgeState.activeId === thirdId, `active=${badgeState.activeId} expected=${thirdId}`);
    check('点角标后装饰仍在（不露源码）', badgeState.badges === badgeCountBefore && !badgeState.rawMarkupVisible, `badges ${badgeCountBefore}→${badgeState.badges} raw=${badgeState.rawMarkupVisible}`);
    const stickyHeader = await page.evaluate(() => getComputedStyle(document.querySelector('.ilc-panel-header')).position);
    check('面板头吸顶', stickyHeader === 'sticky', stickyHeader);
    await page.locator('.ilc-card').nth(0).click(); // reset focus state
    await sleep(200);

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
    const ddGeom = await page.evaluate(() => {
      const d = document.querySelector('.ilc-at-dropdown').getBoundingClientRect();
      const p = document.querySelector('.ilc-panel').getBoundingClientRect();
      const foot = document.querySelector('.ilc-at-manage').getBoundingClientRect();
      return { inside: d.top >= p.top - 1 && d.bottom <= p.bottom + 1, footInside: foot.bottom <= p.bottom + 1 && foot.top >= p.top, d: [Math.round(d.top), Math.round(d.bottom)], p: [Math.round(p.top), Math.round(p.bottom)] };
    });
    check('@ 下拉完整落在面板可视区内（管理成员可见）', ddGeom.inside && ddGeom.footInside, JSON.stringify(ddGeom));
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
    check('自己加入的成员显示 harness 胶囊（不再是黑话「自助」）', dd.sources.includes('codex') && !dd.sources.some((s) => s.includes('自助')), dd.sources.join(','));
    const notifyLabel = await page.locator('.ilc-at-notify').textContent();
    check('通知开关用人话', (notifyLabel ?? '').includes('通知对方'), notifyLabel ?? '');
    await shot(page, '03-at-dropdown', '.workspace-leaf-content[data-type="ilc-comments-panel"]');

    // 管理成员 → dedicated modal (not the settings page)
    await page.locator('.ilc-at-manage').click();
    await page.waitForSelector('.ilc-members-modal', { timeout: 5000 });
    await sleep(800); // discovery
    const modal = await page.evaluate(() => ({
      title: document.querySelector('.ilc-members-modal h2')?.textContent,
      sections: document.querySelectorAll('.ilc-members-section').length,
      members: document.querySelectorAll('.ilc-members-list')[0]?.querySelectorAll('.ilc-members-row').length,
      sessionRows: document.querySelectorAll('.ilc-members-session').length,
      settingsOpen: !!document.querySelector('.modal-settings'),
    }));
    check('管理成员打开独立弹窗', modal.title === '评论 @ 成员' && modal.sections === 3 && !modal.settingsOpen, JSON.stringify(modal));
    check('弹窗列出现有成员', (modal.members ?? 0) === 4, `members=${modal.members}`);
    check('弹窗发现本机会话（这台机器上有 claude 在跑）', (modal.sessionRows ?? 0) > 0, `sessions=${modal.sessionRows}`);
    const titled = await page.evaluate(() => [...document.querySelectorAll('.ilc-members-session .ilc-members-title')].filter((t) => !/^[0-9a-f]{8}$/.test(t.textContent ?? '')).length);
    check('绝大多数会话解析出标题/目录（大首行也能抽出）', titled >= (modal.sessionRows ?? 0) * 0.8, `titled=${titled}/${modal.sessionRows}`);
    const firstId = await page.evaluate(() => document.querySelector('.ilc-members-session .ilc-members-sub')?.textContent?.match(/[0-9a-f]{8}$/)?.[0] ?? '');
    await page.locator('.ilc-members-search').fill(firstId);
    await sleep(150);
    const filteredSessions = await page.locator('.ilc-members-session').count();
    check('会话列表可按短 id 搜索', firstId.length === 8 && filteredSessions === 1, `q=${firstId} rows=${filteredSessions}`);
    await page.locator('.ilc-members-search').fill('');
    await sleep(150);
    await shot(page, '07-members-modal', '.ilc-members-modal-shell');
    await page.keyboard.press('Escape');
    await sleep(200);
    // reopen the dropdown for the remaining @ checks
    await page.locator('.ilc-card-active .ilc-reply-input').click();
    await page.keyboard.press('End');
    await page.waitForSelector('.ilc-at-dropdown', { timeout: 5000 }).catch(async () => {
      await page.keyboard.type('@');
      await page.waitForSelector('.ilc-at-dropdown', { timeout: 5000 });
    });

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
        const draftState = await page.evaluate(() => {
          const view = app.workspace.getLeavesOfType('markdown')[0].view;
          const cm = view.editor.cm;
          const hl = document.querySelector('.cm-editor .ilc-draft-highlight');
          const card = document.querySelector('.ilc-card-draft');
          const from = view.editor.posToOffset({ line: 2, ch: 0 });
          const c = cm.coordsAtPos(from);
          return { hlText: hl?.textContent ?? null, hlCls: hl?.className ?? '', cardTop: card.getBoundingClientRect().top, textTop: c?.top ?? null };
        });
        check('草稿期间划线文字有临时高亮', draftState.hlText === '这是一段没有评论', `hl=${draftState.hlText}`);
        check('临时高亮与正式高亮同款（类型色类名）', /ilc-highlight/.test(draftState.hlCls) && /ilc-hl-agree/.test(draftState.hlCls), draftState.hlCls);
        await page.locator('.ilc-draft-type-btn', { hasText: '疑问' }).click();
        await sleep(100);
        const hlAfter = await page.evaluate(() => document.querySelector('.cm-editor .ilc-draft-highlight')?.className ?? '');
        check('切换类型后临时高亮跟着换色', /ilc-hl-question/.test(hlAfter), hlAfter);
        // Esc must work with focus still on the chip (not only in the textarea)
        check('草稿卡片与划线文字对齐（±6px）', draftState.textTop !== null && Math.abs(draftState.cardTop - draftState.textTop) <= 6, `card=${Math.round(draftState.cardTop)} text=${draftState.textTop === null ? '?' : Math.round(draftState.textTop)}`);
        await shot(page, '05-draft-card', '.workspace-leaf-content[data-type="ilc-comments-panel"]');
        await page.keyboard.press('Escape');
        await sleep(150);
        const hlGone = (await page.locator('.cm-editor .ilc-draft-highlight').count()) === 0;
        check('取消草稿后临时高亮消失', hlGone);
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
