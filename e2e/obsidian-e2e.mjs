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
import { OUT, PLUGIN_ID, WORK, sleep, setupVault, launch, waitForPlugin, shot } from './lib.mjs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

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
    await page.evaluate(() => app.commands.executeCommandById('inline-comments:open-comments-panel'));
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
    await page.evaluate(() => app.plugins.plugins['inline-comments'].mentionDelivery.sweep(false));
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
    check('信的 frontmatter 契约', /^---\nfrom: comment-scanner\nto: 44444444-0000-1111\nto_name: 费宝\nurgency: 普通\nwake: true\nstatus: 未读\ncreated: /.test(delivery.letter), delivery.letter.split('\n').slice(0, 7).join(' | '));
    await page.evaluate(() => app.plugins.plugins['inline-comments'].mentionDelivery.sweep(false));
    await sleep(300);
    const again = await page.evaluate(async () => (await app.vault.adapter.list('Agent协作空间/信箱/44444444')).files.length);
    check('重扫不重复投信', again === 1, `letters=${again}`);

    // ── "用新会话回答": first item, Enter creates an auto-named member and @s it
    {
      await page.locator('.ilc-card').nth(1).click();
      await page.waitForSelector('.ilc-card-active .ilc-reply-input', { state: 'visible', timeout: 5000 });
      const box = page.locator('.ilc-card-active .ilc-reply-input');
      await box.fill('');
      await box.click();
      await page.keyboard.type('@');
      await page.waitForSelector('.ilc-at-newsession', { timeout: 5000 });
      const firstIsAction = await page.evaluate(() => document.querySelector('.ilc-at-list .ilc-at-item')?.classList.contains('ilc-at-newsession'));
      check('打出 @ 时第一项就是「用新会话回答」', firstIsAction === true);
      await page.keyboard.press('Enter');
      await sleep(400);
      const v = await box.inputValue();
      check('回车即创建自动命名的新会话并 @', /\[@新会话1\]\(agent:[0-9a-f]{8}\?notify\)/.test(v), v);
      const reg2 = JSON.parse(fs.readFileSync(path.join(WORK, 'vault', '_os', 'comment-agents.json'), 'utf8'));
      check('新会话1 已注册为自动启动成员', reg2.agents.some((a) => a.name === '新会话1' && a.autoStart));
      await box.fill('');
      await page.keyboard.press('Escape');
      await sleep(150);
    }

    // ── @ a name that does not exist → create a session member → sending auto-starts it
    await page.locator('.ilc-card').nth(1).click();
    await page.waitForSelector('.ilc-card-active .ilc-reply-input', { state: 'visible', timeout: 5000 });
    const newTa = page.locator('.ilc-card-active .ilc-reply-input');
    await newTa.fill('');
    await newTa.click();
    await page.keyboard.type('@新人甲');
    await page.waitForSelector('.ilc-at-create', { timeout: 5000 });
    const createItems = await page.locator('.ilc-at-create').count();
    check('无匹配名字时出现「创建新会话」项（且只有一个下拉）', createItems === 1 && ((await page.locator('.ilc-at-create').first().textContent())?.includes('新人甲') ?? false), `items=${createItems}`);
    await page.keyboard.press('Enter');
    await sleep(400);
    const newVal = await newTa.inputValue();
    const newShort = newVal.match(/\[@新人甲\]\(agent:([0-9a-f]{8})\?notify\)/)?.[1] ?? '';
    check('创建后自动插入结构化 @', newShort.length === 8, newVal);
    const reg = JSON.parse(fs.readFileSync(path.join(WORK, 'vault', '_os', 'comment-agents.json'), 'utf8'));
    const newAgent = reg.agents.find((a) => a.name === '新人甲');
    check('注册表登记为自动启动成员', !!newAgent && newAgent.autoStart === true && newAgent.harness === 'claude' && newAgent.sessionId.startsWith(newShort), JSON.stringify(newAgent));
    await page.keyboard.type(' 请你看看这段');
    await page.locator('.ilc-card-active .ilc-reply-submit').click();
    await sleep(3500); // vault modify → delivery (1.5s debounce) → auto-start
    const launchLog = path.join(WORK, 'launch.log');
    const launches = fs.existsSync(launchLog) ? fs.readFileSync(launchLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const mine = launches.find((l) => l.sessionId === newAgent?.sessionId);
    check('发送后自动启动该会话（新会话 → --session-id）', !!mine && mine.mode === 'new' && mine.shell.includes(`--session-id '${newAgent.sessionId}'`), mine ? mine.shell.slice(0, 120) : `launches=${launches.length}`);
    const promptTxt = mine?.promptFile && fs.existsSync(mine.promptFile) ? fs.readFileSync(mine.promptFile, 'utf8') : '';
    check('首条消息 = 信 + 回复指南', promptTxt.includes('请你看看这段') && promptTxt.includes('{>>新人甲|'), `len=${promptTxt.length}`);
    const newBox = path.join(WORK, 'vault', 'Agent协作空间', '信箱', newShort);
    const newLetter = fs.existsSync(newBox) ? fs.readdirSync(newBox).find((f) => f.endsWith('.md')) : null;
    check('信标为 已读（启动代标），hook 不会重复注入', !!newLetter && fs.readFileSync(path.join(newBox, newLetter), 'utf8').includes('status: 已读（启动代标）'));
    await page.locator('.ilc-card').nth(0).click();
    await sleep(300);

    // ── Same note open in two panes: cards must follow the pane the user is in
    await page.evaluate(async () => {
      const file = app.vault.getAbstractFileByPath('sample.md');
      const leaf = app.workspace.getLeaf('split', 'vertical');
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      leaf.view.editor.cm.scrollDOM.scrollTop = 0;
    });
    await sleep(900);
    const twoPanes = await page.evaluate(() => {
      const active = app.workspace.activeLeaf.view;
      const cm = active.editor.cm;
      const card = document.querySelector('.ilc-card');
      const from = Number(card.dataset.annotationId.replace('ann-', ''));
      const c = cm.coordsAtPos(from + 3);
      return { panes: app.workspace.getLeavesOfType('markdown').length, card: card.getBoundingClientRect().top, text: c?.top ?? null };
    });
    check('同一笔记开两个窗格时卡片跟随当前窗格', twoPanes.panes === 2 && twoPanes.text !== null && Math.abs(twoPanes.card - twoPanes.text) <= 6, JSON.stringify(twoPanes));
    await page.evaluate(() => {
      const leaves = app.workspace.getLeavesOfType('markdown');
      leaves[leaves.length - 1].detach();
      app.workspace.setActiveLeaf(app.workspace.getLeavesOfType('markdown')[0], { focus: true });
    });
    await sleep(600);

    // ── Mailbox hook: install into (isolated) ~/.claude/settings.json, then drive the script
    const hook = await page.evaluate(async () => {
      const p = app.plugins.plugins['inline-comments'];
      const res = await p.installHooks();
      const st = await p.hookStatus();
      return { ...res, ...st };
    });
    const settingsJson = JSON.parse(fs.readFileSync(hook.settingsPath, 'utf8'));
    const ours = (ev) => (settingsJson.hooks?.[ev] ?? []).filter((e) => e.hooks?.some((h) => h.command.includes('ilc-mailbox-hook.sh'))).length;
    check('hook 写入隔离 HOME 的 settings.json（三事件各一条）', ours('UserPromptSubmit') === 1 && ours('Stop') === 1 && ours('SessionStart') === 1, JSON.stringify(Object.keys(settingsJson.hooks ?? {})));
    check('保留原有其它 hook 与设置', settingsJson.theme === 'dark' && (settingsJson.hooks.Stop ?? []).some((e) => e.hooks?.[0]?.command === 'echo other-tool'));
    check('安装前备份了原文件', !!hook.backup && fs.existsSync(hook.backup), hook.backup ?? '');
    await page.evaluate(async () => app.plugins.plugins['inline-comments'].installHooks());
    const againSettings = JSON.parse(fs.readFileSync(hook.settingsPath, 'utf8'));
    check('重复安装幂等（不重复追加）', (againSettings.hooks.Stop ?? []).filter((e) => e.hooks?.some((h) => h.command.includes('ilc-mailbox-hook.sh'))).length === 1);
    check('hook 脚本已写出且可执行', hook.scriptExists && (fs.statSync(hook.scriptPath).mode & 0o111) !== 0, hook.scriptPath);

    // Drive the script like Claude Code would: 费宝 (44444444…) has one unread letter from the sweep above
    const mailboxRoot = path.join(WORK, 'vault', 'Agent协作空间', '信箱');
    const runHook = (event, extra = '') => spawnSync('bash', [hook.scriptPath, '--root', mailboxRoot], {
      input: `{"session_id":"44444444-0000-1111","hook_event_name":"${event}","cwd":"/tmp"${extra}}`, encoding: 'utf8',
    });
    const r1 = runHook('UserPromptSubmit');
    check('UserPromptSubmit：信 + 回复指南注入 stdout', r1.status === 0 && r1.stdout.includes('留言内容') && r1.stdout.includes('reply:') && r1.stdout.includes('费宝'), `status=${r1.status} len=${r1.stdout.length}`);
    const letterFile = fs.readdirSync(path.join(mailboxRoot, '44444444')).find((f) => f.endsWith('.md'));
    const marked = fs.readFileSync(path.join(mailboxRoot, '44444444', letterFile), 'utf8').includes('status: 已读（hook代标）');
    check('递交后信标为 已读（hook代标）', marked);
    const r2 = runHook('UserPromptSubmit');
    check('再次触发不重复注入', r2.status === 0 && r2.stdout.trim() === '', `len=${r2.stdout.length}`);
    // Stop with a fresh unread letter → exit 2 + stderr (Claude keeps working)
    fs.writeFileSync(path.join(mailboxRoot, '44444444', '2026-09-03-0000-来自comment-scanner-普通-文档留言-test.md'), '---\nfrom: comment-scanner\nto: 44444444-0000-1111\nto_name: 费宝\nurgency: 普通\nwake: true\nstatus: 未读\ncreated: 2026-09-03 00:00\n---\n- 文档：sample.md\n- 留言内容：Stop 测试\n');
    const r3 = runHook('Stop');
    check('Stop：有未读时 exit 2 并把信写到 stderr', r3.status === 2 && r3.stderr.includes('Stop 测试'), `status=${r3.status}`);
    const r4 = runHook('Stop', ',"stop_hook_active":true');
    check('stop_hook_active 时不再拦截（防循环）', r4.status === 0);

    // Optional: prove Claude Code itself receives the letter (needs claude CLI + login)
    if (process.env.ILC_E2E_LIVE) {
      const sid = crypto.randomUUID();
      const box = path.join(mailboxRoot, sid.slice(0, 8));
      fs.mkdirSync(box, { recursive: true });
      fs.writeFileSync(path.join(box, '2026-09-03-0001-来自comment-scanner-普通-文档留言-live.md'), `---\nfrom: comment-scanner\nto: ${sid}\nto_name: 测试员\nurgency: 普通\nwake: true\nstatus: 未读\ncreated: 2026-09-03 00:01\n---\n- 文档：sample.md\n- 划线原文：今天入职\n- 留言内容：暗号是 菠萝蜜 [@测试员](agent:${sid.slice(0, 8)}?notify)\n- 留言者：yyt｜2026-09-03\n`);
      const settings = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook.command }] }] } });
      // A clean login environment: drop any harness-scoped tokens / nesting markers from this process
      const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE)/.test(k)));
      const live = spawnSync('claude', ['-p', '你刚才收到了几封留言？留言里的暗号是什么？只用一句话回答。', '--session-id', sid, '--settings', settings, '--output-format', 'text'], { encoding: 'utf8', timeout: 150000, cwd: WORK, env: { ...cleanEnv, ILC_HOME: path.join(WORK, 'home') } });
      check('【真机】claude -p 通过 hook 收到留言并复述暗号', (live.stdout ?? '').includes('菠萝蜜'), `status=${live.status} out=${(live.stdout ?? '').slice(0, 120).replace(/\n/g, ' ')} err=${(live.stderr ?? '').slice(0, 120)}`);
    }

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
    check('@ 下拉 = 「用新会话回答」+ 4 位样例 + 新会话1 + 新人甲', dd.items === 7 && dd.names[0]?.text === '用新会话回答', `items=${dd.items} first=${dd.names[0]?.text}`);
    check('列表第一项常驻「用新会话回答」', dd.names[0]?.text === '用新会话回答');
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
    check('弹窗列出现有成员', (modal.members ?? 0) === 6, `members=${modal.members}`);
    check('弹窗发现本机会话（这台机器上有 claude 在跑）', (modal.sessionRows ?? 0) > 0, `sessions=${modal.sessionRows}`);
    const titled = await page.evaluate(() => [...document.querySelectorAll('.ilc-members-session .ilc-members-title')].filter((t) => !/^[0-9a-f]{8}$/.test(t.textContent ?? '')).length);
    check('绝大多数会话解析出标题/目录（大首行也能抽出）', titled >= (modal.sessionRows ?? 0) * 0.8, `titled=${titled}/${modal.sessionRows}`);
    const firstId = await page.evaluate(() => document.querySelector('.ilc-members-session .ilc-members-sub')?.textContent?.match(/[0-9a-f]{8}$/)?.[0] ?? '');
    await page.locator('.ilc-members-search').fill(firstId);
    await sleep(150);
    const filteredRows = await page.evaluate((q) => [...document.querySelectorAll('.ilc-members-session')].map((r) => (r.textContent ?? '').toLowerCase().includes(q)), firstId);
    check('会话列表可按短 id 搜索', firstId.length === 8 && filteredRows.length >= 1 && filteredRows.length < (modal.sessionRows ?? 0) && filteredRows.some(Boolean), `q=${firstId} rows=${filteredRows.length}/${modal.sessionRows}`);
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

    // ── File-explorer unread badge (red count on the document's row), and the master switch
    await sleep(700); // recount + badge repaint after the click above
    const badgeSel = '.nav-file-title[data-path="sample.md"] .ilc-unread-badge';
    const badgeText = await page.locator(badgeSel).textContent().catch(() => null);
    const headerUnread = Number((headerAfter ?? '').match(/(\d+)\s*未读/)?.[1] ?? 0);
    check('目录里文档行有红色角标，数字等于面板未读数', badgeText !== null && Number(badgeText) === headerUnread, `badge=${badgeText} header=${headerUnread}`);
    const badgeStyle = await page.evaluate((sel) => { const b = document.querySelector(sel); if (!b) return null; const cs = getComputedStyle(b); return { bg: cs.backgroundColor, color: cs.color, r: cs.borderRadius }; }, badgeSel);
    check('角标是红底白字圆角', !!badgeStyle && /rgb\(2[0-9]{2}, [0-9]{1,2}, [0-9]{1,2}\)|rgb\(2[0-9]{2}, [0-9]{2,3}, [0-9]{2,3}\)/.test(badgeStyle.bg) && badgeStyle.color === 'rgb(255, 255, 255)' && parseFloat(badgeStyle.r) >= 8, JSON.stringify(badgeStyle));
    const setUnread = async (on) => page.evaluate(async (v) => {
      const p = app.plugins.plugins['inline-comments'];
      p.settings.enableUnreadSignal = v; await p.saveSettings();
      if (v) await p.unreadTracker.recompute(); else await p.unreadTracker.clear();
      p.explorerBadge.render(); await p.getPanel()?.refresh();
    }, on);
    await setUnread(false); await sleep(300);
    const offState = await page.evaluate(() => ({
      badges: document.querySelectorAll('.ilc-unread-badge').length,
      readBtns: document.querySelectorAll('.ilc-read-btn').length,
      dots: document.querySelectorAll('.ilc-entry-unread').length,
      header: document.querySelector('.ilc-panel-header')?.textContent ?? '',
    }));
    check('关闭「未读通知」后：无角标、无「标为已读」、无红点、面板头无未读数', offState.badges === 0 && offState.readBtns === 0 && offState.dots === 0 && !/未读/.test(offState.header), JSON.stringify(offState));
    await setUnread(true); await sleep(700);
    const backOn = await page.locator(badgeSel).count();
    check('重新开启后角标回来', backOn === 1, `badges=${backOn}`);

    // ── Suggestions: a `suggest` entry shows old → new with 采纳 / 不采纳; accepting rewrites the passage
    const sug = page.locator('.ilc-suggest-suggest').first();
    const sugSeen = await sug.count();
    const sugText = sugSeen ? await sug.evaluate((b) => ({ old: b.querySelector('.ilc-suggest-old')?.textContent, neu: b.querySelector('.ilc-suggest-new')?.textContent })) : null;
    check('建议条目渲染为 原文 → 替换文', !!sugText && sugText.old === '需老板在场做' && sugText.neu === '需老板到场做', JSON.stringify(sugText));
    const hasActs = (await page.locator('.ilc-suggest-accept').count()) === 1 && (await page.locator('.ilc-suggest-decline').count()) === 1;
    check('待处理建议有「采纳 / 不采纳」', hasActs);
    const toggle = await page.locator('.ilc-suggest-toggle input').count();
    check('回复框有「作为修改建议」开关', toggle >= 1, `toggles=${toggle}`);
    await page.locator('.ilc-suggest-accept').click();
    await sleep(900);
    const after = await page.evaluate(() => app.vault.adapter.read('sample.md'));
    check('采纳后原文被替换、条目标为 accepted（同一次写入）', after.includes('{==需老板到场做==}') && after.includes('|accepted: 需老板到场做<<}') && !after.includes('{==需老板在场做==}'), after.match(/\{==需老板.{0,3}做==\}[^\n]{0,120}/)?.[0] ?? 'n/a');
    const hlNow = await page.evaluate(() => [...document.querySelectorAll('.cm-editor .ilc-highlight')].map((e) => e.textContent));
    check('编辑器里的高亮显示新原文', hlNow.some((t) => t === '需老板到场做'), hlNow.join(' | '));
    const pendingLeft = await page.locator('.ilc-suggest-accept').count();
    check('采纳后按钮消失、条目显示「已采纳」', pendingLeft === 0 && (await page.locator('.ilc-suggest-accepted').count()) === 1);

    // ── Long threads are clipped (unless focused); 「展开全部」 lifts the clamp
    await page.evaluate(() => { const p = app.plugins.plugins['inline-comments'].getPanel(); p.activeAnnotationId = null; });
    await page.evaluate(() => app.plugins.plugins['inline-comments'].getPanel().refresh());
    await sleep(700);
    const clampInfo = await page.evaluate(() => {
      const w = document.querySelector('.ilc-card:not(.ilc-card-active) .ilc-thread-wrap.is-clamped');
      if (!w) return null;
      const card = w.closest('.ilc-card');
      return { id: card.dataset.annotationId, visibleH: w.getBoundingClientRect().height, fullH: w.scrollHeight, btn: card.querySelector('.ilc-expand-btn')?.textContent ?? null };
    });
    check('超长线程被折叠到 ~260px 并有「展开全部」', !!clampInfo && clampInfo.visibleH <= 262 && clampInfo.fullH > 320 && /展开全部 \d+ 条/.test(clampInfo.btn ?? ''), JSON.stringify(clampInfo));
    await page.locator(`.ilc-card[data-annotation-id="${clampInfo?.id}"] .ilc-expand-btn`).click();
    await sleep(250);
    const expandedNow = await page.evaluate((id) => { const c = document.querySelector(`.ilc-card[data-annotation-id="${id}"]`); return { clamped: !!c?.querySelector('.ilc-thread-wrap.is-clamped'), btn: !!c?.querySelector('.ilc-expand-btn'), h: c?.querySelector('.ilc-thread-wrap')?.getBoundingClientRect().height }; }, clampInfo?.id);
    check('点「展开全部」后该卡片展开、按钮消失', !expandedNow.clamped && !expandedNow.btn && expandedNow.h > 320, JSON.stringify(expandedNow));

    // ── Resolve / reopen
    const noteCard = page.locator('.ilc-card', { hasText: '能同桌很暖' }).first();
    await noteCard.locator('.ilc-resolve-btn').evaluate((b) => b.click()); // zero-width until hover, like ⋯
    await sleep(900);
    const resolvedDoc = await page.evaluate(() => app.vault.adapter.read('sample.md'));
    const resolvedCard = await page.locator('.ilc-card-resolved', { hasText: '能同桌很暖' }).count();
    const headerTog = await page.locator('.ilc-resolved-toggle').textContent().catch(() => null);
    check('标为已解决：文件追加 resolve 标记、卡片折叠、面板头出现「已解决 1」', /\{==能同桌很暖==\}[^\n]*\|resolve: <<\}/.test(resolvedDoc) && resolvedCard === 1 && headerTog === '已解决 1', `card=${resolvedCard} toggle=${headerTog}`);
    const hlResolved = await page.locator('.cm-editor .ilc-hl-resolved').count();
    check('已解决的划线在编辑器里变淡（ilc-hl-resolved）', hlResolved >= 1, `n=${hlResolved}`);
    await page.locator('.ilc-resolved-toggle').click();
    await sleep(600);
    const hiddenNow = await page.locator('.ilc-card', { hasText: '能同桌很暖' }).count();
    check('点「已解决」开关可隐藏已解决卡片', hiddenNow === 0, `cards=${hiddenNow}`);
    await page.locator('.ilc-resolved-toggle').click();
    await sleep(600);
    await page.locator('.ilc-card-resolved .ilc-reopen-btn').first().evaluate((b) => b.click());
    await sleep(900);
    const reopenedDoc = await page.evaluate(() => app.vault.adapter.read('sample.md'));
    check('重新打开：resolve 标记被删除、卡片恢复', !/能同桌很暖==\}[^\n]*resolve:/.test(reopenedDoc) && (await page.locator('.ilc-card-resolved').count()) === 0);

    // ── Reading view: raw markup hidden, same highlight + badge, cards aligned to the rendered spans
    await page.evaluate(async () => { const leaf = app.workspace.getLeavesOfType('markdown')[0]; const st = leaf.getViewState(); st.state = { ...st.state, mode: 'preview' }; await leaf.setViewState(st, { focus: true }); });
    await sleep(1200);
    const rv = await page.evaluate(() => {
      const pv = document.querySelector('.markdown-preview-view');
      const rawParas = [...pv.querySelectorAll('p')].filter((p) => /\{>>|<<\}|\{==/.test(p.innerText)).map((p) => p.innerText.slice(0, 30));
      const spans = [...pv.querySelectorAll('.ilc-highlight')].map((s) => s.textContent);
      const badges = pv.querySelectorAll('.ilc-badge').length;
      return { rawParas, spans, badges, mode: app.workspace.getLeavesOfType('markdown')[0].view.getMode() };
    });
    // The fixture's 5th paragraph is a deliberately malformed nested annotation; everything else must be clean
    check('阅读视图：原始评论标记不再露出（畸形段除外）', rv.mode === 'preview' && rv.rawParas.every((p) => p.includes('畸形')), JSON.stringify(rv.rawParas));
    check('阅读视图：每条评论变成同款高亮 + 角标', rv.spans.length >= 4 && rv.badges === rv.spans.length && rv.spans.includes('今天入职'), JSON.stringify(rv.spans));
    await sleep(400);
    const rvAlign = await page.evaluate(() => {
      const span = document.querySelector('.markdown-preview-view [data-ann-id]');
      const card = document.querySelector(`.ilc-card[data-annotation-id="${span?.dataset.annId}"]`);
      return { id: span?.dataset.annId ?? null, text: Math.round(span?.getBoundingClientRect().top ?? -1), card: Math.round(card?.getBoundingClientRect().top ?? -1) };
    });
    check('阅读视图：首张卡片与渲染后的划线在屏幕上对齐（±6px）', Math.abs(rvAlign.text - rvAlign.card) <= 6, `text=${rvAlign.text} card=${rvAlign.card}`);
    await page.locator('.markdown-preview-view .ilc-badge').first().click();
    await sleep(300);
    const rvActive = await page.evaluate(() => document.querySelector('.ilc-card-active')?.dataset.annotationId ?? null);
    check('阅读视图：点角标激活对应卡片', rvActive !== null && rvActive === rvAlign.id, `active=${rvActive} expected=${rvAlign.id}`);
    await page.evaluate(async () => { const leaf = app.workspace.getLeavesOfType('markdown')[0]; const st = leaf.getViewState(); st.state = { ...st.state, mode: 'source' }; await leaf.setViewState(st, { focus: true }); });
    await sleep(600);

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
