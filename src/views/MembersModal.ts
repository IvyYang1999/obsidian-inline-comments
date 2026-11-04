import { statusLabel, t } from '../i18n.ts';
import { App, Menu, Modal, Notice, Platform, setIcon } from 'obsidian';
import { loadRoster, memberReach, type RosterEntry } from '../atSelector.ts';
import { levelHint, type Reach } from '../reach.ts';
import { readRegistry, removeAgent, upsertAgent, validateName } from '../registry.ts';
import { discoverLocalSessions, shortCwd, timeAgo, type LocalSession } from '../sessionDiscovery.ts';
import { DEFAULT_MAILBOX_ROOT } from '../mentionDelivery.ts';
import { harnessDef } from '../harnesses.ts';
import { claudeInboxHolds, findClaudeSession } from '../claudeInbox.ts';
import { canOpenTerminal } from '../sessionLauncher.ts';

const STATUS_CLS: Record<string, string> = { '在线': 'online', '闲置': 'idle', '离线': 'offline' };
const LEVEL_CLS: Record<Reach['level'], string> = { now: 'online', later: 'idle', none: 'offline' };

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 52%)`;
}

/**
 * 「评论 @ 成员」— one place that explains what @ does, lists who can be
 * mentioned, and lets the user add sessions found on this machine.
 */
export class MembersModal extends Modal {
  private membersEl!: HTMLElement;
  private sessionsEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private sessions: LocalSession[] = [];
  private registrySnapshot: { joined: Map<string, string>; left: Map<string, string> } = { joined: new Map(), left: new Map() };
  /** Open Claude sessions that would hold a letter (they skip permission prompts), by lower-case id */
  private holding = new Set<string>();
  /** Claude sessions that run without a cross-session inbox, by lower-case id */
  private noInbox = new Set<string>();
  /** Of those, the ones whose socket file was deleted (they had an inbox) */
  private inboxGone = new Set<string>();

  constructor(app: App) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    modalEl.addClass('ilc-members-modal-shell');
    contentEl.addClass('ilc-members-modal');

    contentEl.createEl('h2', { text: t('评论 @ 成员') });
    contentEl.createEl('p', {
      cls: 'ilc-members-intro',
      text: t('成员是这台电脑上的一个 AI 会话（Claude Code 或 Codex）。把它加进来，以后在评论里 @ 它，它就会读到这条评论，把回复写回这里。'),
    });

    // ── Members
    const s1 = contentEl.createEl('section', { cls: 'ilc-members-section' });
    const h1 = s1.createEl('div', { cls: 'ilc-members-section-head' });
    h1.createEl('h3', { text: t('可以 @ 的成员') });
    this.membersEl = s1.createEl('div', { cls: 'ilc-members-list' });

    // ── Local sessions
    const s2 = contentEl.createEl('section', { cls: 'ilc-members-section' });
    const h2 = s2.createEl('div', { cls: 'ilc-members-section-head' });
    h2.createEl('h3', { text: t('这台电脑上的会话') });
    const tools = h2.createEl('div', { cls: 'ilc-members-tools' });
    this.searchEl = tools.createEl('input', {
      cls: 'ilc-members-search',
      attr: { type: 'search', placeholder: t('搜索会话'), title: t('按标题、目录或短 id 搜'), spellcheck: 'false' },
    }) as HTMLInputElement;
    this.searchEl.addEventListener('input', () => this.renderSessionRows());
    const refresh = tools.createEl('button', { cls: 'ilc-members-refresh', text: t('刷新') });
    s2.createEl('p', {
      cls: 'ilc-members-hint',
      text: t('最近 48 小时用过的 Claude Code / Codex 会话。选一个，起个名字（2–12 个字），点「加入」。在这个 vault 里工作的排在前面。'),
    });
    this.sessionsEl = s2.createEl('div', { cls: 'ilc-members-sessions' });
    refresh.addEventListener('click', () => void this.renderSessions());

    // ── Advanced: how letters travel, the wake hook, other ways to join — folded, a first member needs none of it
    const s3 = contentEl.createEl('details', { cls: 'ilc-members-section ilc-members-section-muted ilc-members-advanced' });
    const summary = s3.createEl('summary', { text: t('高级：投递、唤醒 hook、其他加入方式') });
    const status = s3.createEl('div', { cls: 'ilc-members-hint ilc-members-delivery' });
    void this.renderDeliveryStatus(status, summary);
    s3.createEl('h3', { text: t('其他加入方式') });
    const ul = s3.createEl('ul');
    ul.createEl('li', { text: t('在任意 Claude Code / Codex 会话里输入 /comment-join，会话会自己起名并加入。') });
    ul.createEl('li', { text: t('公司花名册「在场」里的成员会自动出现，状态来自在场板。') });

    await Promise.all([this.renderMembers(), this.renderSessions()]);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private get plugin(): any {
    return (this.app as any).plugins?.plugins?.['inline-comments'];
  }

  /** "投递 … · 唤醒 hook …" line with an install button when needed */
  private async renderDeliveryStatus(el: HTMLElement, summary?: HTMLElement): Promise<void> {
    el.empty();
    summary?.querySelector('.ilc-members-advanced-flag')?.remove();
    const plugin = this.plugin;
    const root: string = plugin?.settings?.mailboxRoot || DEFAULT_MAILBOX_ROOT;
    const enabled: boolean = plugin?.settings?.enableMentionDelivery ?? true;
    const exists = await this.app.vault.adapter.exists(root);
    el.createEl('span', {
      text: enabled
        ? t('投递：已开启 · 信箱 {0}{1}', [root, exists ? '' : '（首次投信时自动创建）'])
        : t('投递：已关闭（设置里可开启）'),
    });
    const st = await plugin?.hookStatus?.();
    if (!st) return;
    el.appendText(t(' · 唤醒 hook：'));
    if (st.installed && !st.stale) {
      el.createEl('span', { cls: 'ilc-members-ok', text: t('已安装') });
      el.setAttribute('title', t('会话说话前 / 收尾时 / 恢复时自动收到留言 · {0}', [st.settingsPath]));
      return;
    }
    el.createEl('span', { cls: 'ilc-members-warn', text: st.installed ? t('需要重装') : t('未安装') });
    // Folded away, but not hidden: the summary says the hook needs attention
    summary?.createEl('span', { cls: 'ilc-members-advanced-flag', text: st.installed ? t(' · 唤醒 hook 需要重装') : t(' · 唤醒 hook 未安装') });
    const btn = el.createEl('button', { cls: 'ilc-members-join', text: st.installed ? t('重装') : t('安装') });
    btn.setAttribute('title', t('写入 {0}（只加自己的条目，先备份）', [st.settingsPath]));
    btn.addEventListener('click', async () => {
      await plugin.installHooks();
      await this.renderDeliveryStatus(el, summary);
    });
    el.createEl('div', {
      cls: 'ilc-members-warn-hint',
      text: t('没有 hook 时信照样会投到信箱，但会话不会自动看到，得它自己去读。'),
    });
  }

  // ── Members list ─────────────────────────────────────────────────────────────

  private async renderMembers(): Promise<void> {
    const el = this.membersEl;
    el.empty();
    const entries = (await loadRoster(this.app)).filter((e) => !e.isAction);
    if (entries.length === 0) {
      el.createEl('div', { cls: 'ilc-members-empty', text: t('还没有成员。在下面选一个会话，起个名字，点「加入」。') });
      return;
    }
    const reach = await memberReach(this.app, entries);
    for (const e of entries) this.renderMemberRow(el, e, reach.get(e.name));
  }

  private renderMemberRow(container: HTMLElement, e: RosterEntry, reach?: Reach): void {
    const statusCls = reach ? LEVEL_CLS[reach.level] : STATUS_CLS[e.status];
    const row = container.createEl('div', { cls: `ilc-members-row ilc-at-status-${statusCls}` });

    const avatar = row.createEl('span', { cls: 'ilc-at-avatar', text: e.name.charAt(0) });
    avatar.setCssStyles({ background: avatarColor(e.name) });
    const dot = avatar.createEl('span', { cls: `ilc-at-dot ilc-at-dot-${statusCls}` });
    if (reach) dot.setAttribute('title', levelHint(reach.level));

    const main = row.createEl('div', { cls: 'ilc-members-main' });
    const line1 = main.createEl('div', { cls: 'ilc-members-line' });
    line1.createEl('span', { cls: 'ilc-at-name', text: e.name });
    if (e.harness) line1.createEl('span', { cls: 'ilc-at-source', text: harnessDef(e.harness)?.label ?? e.harness });
    const headless = e.autoStart && harnessDef(e.harness)?.mode === 'headless';
    if (e.autoStart) {
      const tag = line1.createEl('span', { cls: 'ilc-at-source ilc-at-source-muted', text: t('自动启动') });
      tag.setAttribute('title', headless
        ? t('有留言时，插件在后台接着这个会话回复')
        : canOpenTerminal()
          ? t('有留言且它没在运行时，插件会在终端里启动/恢复这个会话并把留言交给它')
          : t('有留言且它没在运行时，卡片上会给你一条启动命令，到终端里运行就把留言交给它'));
    }
    const status = reach?.text ?? statusLabel(e.status);
    line1.createEl('span', { cls: 'ilc-members-status', text: status, attr: { title: status } });
    const line2 = main.createEl('div', { cls: 'ilc-members-sub' });
    line2.appendText(e.source === 'registry' ? t('自己加入的会话') : t('花名册在编'));
    if (e.role) line2.appendText(` · ${e.role.replace(/^@/, '')}`);
    line2.appendText(` · ${e.shortId}`);
    line2.setAttribute('title', line2.textContent ?? '');

    if (reach?.fix) {
      const fix = reach.fix;
      const btn = row.createEl('button', { cls: 'ilc-members-resume', text: fix === 'hook' ? t('安装 hook') : t('去登录') });
      btn.addEventListener('click', async () => {
        if (fix === 'hook') await this.plugin?.installHooks?.();
        else await this.plugin?.openHarnessLogin?.(e.harness);
        await this.renderMembers();
      });
    }
    // Opening its session and removing it are occasional: behind ⋯, so the row keeps one button at most
    const canOpen = headless && !!e.threadId;
    if (canOpen || e.source === 'registry') {
      const more = row.createEl('button', { cls: 'clickable-icon ilc-members-more', attr: { 'aria-label': t('更多操作') } });
      setIcon(more, 'more-horizontal');
      more.addEventListener('click', (ev) => {
        const menu = new Menu();
        if (canOpen) {
          menu.addItem((item) => item.setTitle(t('在终端里接着聊')).setIcon('terminal')
            .onClick(() => this.plugin?.resumeInTerminal?.(e.sessionId, e.cwd, e.harness, e.threadId)));
        }
        if (e.source === 'registry') {
          if (canOpen) menu.addSeparator();
          menu.addItem((item) => item.setTitle(t('移除')).setIcon('user-minus').setWarning(true).onClick(async () => {
            await removeAgent(this.app, e.name);
            new Notice(t('已移除「{0}」', [e.name]));
            await Promise.all([this.renderMembers(), this.renderSessions()]);
          }));
        }
        menu.showAtMouseEvent(ev);
      });
    }
  }

  // ── Local sessions ───────────────────────────────────────────────────────────

  private async renderSessions(): Promise<void> {
    const el = this.sessionsEl;
    el.empty();
    if (!Platform.isDesktop) {
      el.createEl('div', { cls: 'ilc-members-empty', text: t('仅桌面端支持自动发现。') });
      return;
    }
    el.createEl('div', { cls: 'ilc-members-empty', text: t('正在查找…') });

    let sessions: LocalSession[] = [];
    try {
      sessions = await discoverLocalSessions();
    } catch (err) {
      el.empty();
      el.createEl('div', { cls: 'ilc-members-empty', text: t('查找失败：{0}', [String((err as Error)?.message ?? err)]) });
      return;
    }
    // A chat open in the Claude app is running even when its command line does not say which session it is
    this.holding = new Set();
    this.noInbox = new Set();
    this.inboxGone = new Set();
    await Promise.all(sessions.filter((s) => s.harness === 'claude').map(async (s) => {
      const { running, inbox, socketGone } = await findClaudeSession(s.sessionId);
      if (!running) return;
      s.running = true;
      if (!inbox) {
        this.noInbox.add(s.sessionId.toLowerCase());
        if (socketGone) this.inboxGone.add(s.sessionId.toLowerCase());
      } else if (await claudeInboxHolds(inbox)) this.holding.add(s.sessionId.toLowerCase());
    }));
    const registry = await readRegistry(this.app);
    this.registrySnapshot = {
      joined: new Map(registry.agents.map((a) => [a.sessionId.toLowerCase(), a.name])),
      left: new Map((registry.left ?? []).map((a) => [a.sessionId.toLowerCase(), a.name])),
    };
    this.sessions = sessions;
    this.renderSessionRows();
  }

  /** Render the discovered sessions through the search filter: this vault's first, the rest folded */
  private renderSessionRows(): void {
    const el = this.sessionsEl;
    el.empty();
    if (this.sessions.length === 0) {
      el.createEl('div', { cls: 'ilc-members-list' }).createEl('div', { cls: 'ilc-members-empty', text: t('最近 48 小时没有发现 Claude Code / Codex 会话。') });
      return;
    }
    const q = (this.searchEl?.value ?? '').trim().toLowerCase();
    const hit = (s: LocalSession) =>
      !q || [s.title, s.cwd, s.shortId, s.sessionId, s.harness, this.registrySnapshot.joined.get(s.sessionId.toLowerCase())]
        .some((v) => v && v.toLowerCase().includes(q));
    const rows = this.sessions.filter(hit);
    if (rows.length === 0) {
      el.createEl('div', { cls: 'ilc-members-list' }).createEl('div', { cls: 'ilc-members-empty', text: t('没有匹配「{0}」的会话', [q]) });
      return;
    }
    const { joined, left } = this.registrySnapshot;
    const render = (list: HTMLElement, s: LocalSession) => this.renderSessionRow(list, s, joined.get(s.sessionId.toLowerCase()), left.get(s.sessionId.toLowerCase()));
    // A session working in (or above) this vault is the likely one to add; others are other projects
    const vault: string | null = this.plugin?.vaultBasePath?.() ?? null;
    const inVault = (cwd?: string) => !!vault && !!cwd && (cwd === vault || cwd.startsWith(`${vault}/`) || vault.startsWith(`${cwd}/`));
    const here = rows.filter((s) => inVault(s.cwd));
    const elsewhere = rows.filter((s) => !inVault(s.cwd));
    if (here.length > 0) {
      el.createEl('div', { cls: 'ilc-members-subhead', text: t('在这个 vault 里工作的会话') });
      const list = el.createEl('div', { cls: 'ilc-members-list' });
      for (const s of here) render(list, s);
    }
    if (elsewhere.length === 0) return;
    const box = el.createEl('details', { cls: 'ilc-members-elsewhere' });
    box.open = here.length === 0 || !!q;
    box.createEl('summary', {
      cls: 'ilc-members-subhead',
      text: here.length > 0 ? t('其他文件夹里的会话（{0}）', [elsewhere.length]) : t('这个 vault 里没有会话，下面是其他文件夹里的（{0}）', [elsewhere.length]),
    });
    const list = box.createEl('div', { cls: 'ilc-members-list' });
    for (const s of elsewhere) render(list, s);
  }

  private renderSessionRow(container: HTMLElement, s: LocalSession, joinedAs?: string, leftAs?: string): void {
    const row = container.createEl('div', { cls: `ilc-members-row ilc-members-session ${s.running ? 'is-running' : ''}` });

    const dot = row.createEl('span', { cls: `ilc-members-dot ${s.running ? 'is-on' : ''}` });
    dot.setAttribute('title', s.running ? t('正在运行') : t('最近活跃'));

    const main = row.createEl('div', { cls: 'ilc-members-main' });
    const line1 = main.createEl('div', { cls: 'ilc-members-line' });
    line1.createEl('span', { cls: 'ilc-at-source', text: harnessDef(s.harness)?.label ?? s.harness });
    const title = s.title ?? shortCwd(s.cwd) ?? s.shortId;
    line1.createEl('span', { cls: 'ilc-members-title', text: title, attr: { title: s.title ?? s.cwd ?? s.shortId } });
    const line2 = main.createEl('div', { cls: 'ilc-members-sub' });
    const bits = [s.running ? t('运行中') : timeAgo(s.lastActive), shortCwd(s.cwd), s.shortId].filter(Boolean);
    line2.setText(bits.join(' · '));
    if (s.cwd) line2.setAttribute('title', s.cwd);
    // A joined session says how it gets letters in its member row above; saying it again here doubled it
    if (joinedAs) { /* status shown with the member */ } else if (this.inboxGone.has(s.sessionId.toLowerCase())) {
      const warn = main.createEl('div', { cls: 'ilc-members-sub ilc-members-holds', text: t('它的收信口文件不见了：@ 它要等它下次说话；重开这个会话就能直接送到') });
      warn.setAttribute('title', t('会话开着，但 Claude Code 放收信口的临时文件夹被清理掉了（有的系统会定期清理临时文件）。Claude Code 只在会话启动时建收信口，所以要重开这个会话。'));
    } else if (this.noInbox.has(s.sessionId.toLowerCase())) {
      const warn = main.createEl('div', { cls: 'ilc-members-sub ilc-members-holds', text: t('它的 Claude Code 没开收信口：@ 它要等它下次说话') });
      warn.setAttribute('title', t('Claude Code 按账号逐步开放会话之间的收信口，有的会话启动后才打开，旧版本没有。重开这个会话或更新 Claude Code 后再看。'));
    } else if (this.holding.has(s.sessionId.toLowerCase())) {
      const warn = main.createEl('div', { cls: 'ilc-members-sub ilc-members-holds', text: t('它跳过了权限确认：@ 它要等它下次说话；换个权限模式就能直接送到（不用重开）') });
      warn.setAttribute('title', t('Claude Code 不让别的程序直接往跳过权限确认的会话里送消息。在那个会话里切到别的权限模式即可，立刻生效。'));
    }

    const action = row.createEl('div', { cls: 'ilc-members-action' });
    if (joinedAs) {
      action.createEl('span', { cls: 'ilc-members-joined', text: t('已加入 · {0}', [joinedAs]) });
      if (!s.running && s.harness === 'claude') {
        const resume = action.createEl('button', { cls: 'ilc-members-resume', text: t('在终端恢复') });
        resume.setAttribute('title', canOpenTerminal()
          ? t('打开终端运行 claude --resume，恢复的是这个会话本身；它一启动就会收到未读留言')
          : t('复制 claude --resume 命令，到终端里运行，恢复的是这个会话本身；它一启动就会收到未读留言'));
        resume.addEventListener('click', () => this.plugin?.resumeInTerminal?.(s.sessionId, s.cwd));
      }
      return;
    }
    // The rule is in the box before anyone types; a wrong name is said under the row, not in a toast
    const input = action.createEl('input', {
      cls: 'ilc-members-name',
      attr: { type: 'text', placeholder: t('名字（2–12 个字）'), maxlength: '12', value: leftAs ?? '' },
    }) as HTMLInputElement;
    const btn = action.createEl('button', { cls: 'ilc-members-join mod-cta', text: t('加入') });
    const error = main.createEl('div', { cls: 'ilc-members-sub ilc-members-name-error ilc-hidden' });
    const fail = (msg: string) => {
      error.setText(msg);
      error.removeClass('ilc-hidden');
      input.addClass('is-invalid');
      input.focus();
    };
    input.addEventListener('input', () => { error.addClass('ilc-hidden'); input.removeClass('is-invalid'); });
    const submit = async () => {
      const err = validateName(input.value);
      if (err) { fail(err); return; }
      const name = input.value.trim();
      btn.disabled = true;
      try {
        const res = await upsertAgent(this.app, { name, sessionId: s.sessionId, harness: s.harness });
        if (!res.ok) { fail(res.error); return; }
      } catch (e) {
        fail(t('没能加入：{0}', [String((e as Error)?.message ?? e)]));
        return;
      } finally {
        btn.disabled = false;
      }
      new Notice(t('「{0}」已加入：在评论里输入 @{0} 就能点名它', [name]));
      await Promise.all([this.renderMembers(), this.renderSessions()]);
      // First member ever → offer the hook right away so the loop closes
      const st = await this.plugin?.hookStatus?.();
      if (st && !st.installed && s.harness === 'claude') {
        new Notice(t('提示：装上「唤醒 hook」后，这个会话下一次说话时就会自动看到你的留言（在弹窗底部的「高级」里安装）'), 8000);
      }
    };
    btn.addEventListener('click', () => void submit());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
  }
}
