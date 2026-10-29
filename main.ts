import { getLocale, setLocale, t } from './src/i18n.ts';
import { nodeCp, nodeCrypto, nodeFsp, nodeOs, nodePath } from './src/node.ts';
import { MarkdownView, Platform, Plugin, PluginSettingTab, App, Setting, Notice, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { Editor } from 'obsidian';
import { buildAgentReplyPrompt, cleanReplyText } from './src/agentReply.ts';
import { buildCommentExtension, type ICommentHost, type AnnotationPosition } from './src/editor/cmExtension.ts';
import { readingPostProcessor } from './src/readingView.ts';
import { CommentPanel, VIEW_TYPE_COMMENTS } from './src/views/CommentPanel.ts';
import { HistoryModal } from './src/views/HistoryModal.ts';
import { MembersModal } from './src/views/MembersModal.ts';
import { GlobalThreadModal } from './src/modal/GlobalThreadModal.ts';
import { appendReply, parseAnnotations } from './src/parser.ts';
import type { CommentEntry, CommentTypeConfig, AIAgentConfig, DeletedRecord } from './src/types.ts';
import { BUILTIN_TYPE_IDS, typeBgColor } from './src/types.ts';
import { AgentSuggest } from './src/AgentSuggest.ts';
import { UnreadTracker } from './src/unreadTracker.ts';
import { ExplorerBadge } from './src/explorerBadge.ts';
import { DEFAULT_MAILBOX_ROOT } from './src/mentionDelivery.ts';
import { MentionDelivery } from './src/mentionDeliveryService.ts';
import { getHookStatus, installClaudeHooks, uninstallClaudeHooks, type HookStatus } from './src/hookInstaller.ts';
import { HOOK_SCRIPT_NAME } from './src/hookScript.ts';
import { buildLaunchPlan, buildLaunchPrompt, launchInTerminal, openExternalUrl, runningClaudeIds, sessionFileExists, writePromptFile } from './src/sessionLauncher.ts';
import type { Candidate } from './src/mentionDelivery.ts';
import { renderAgentRegistrySection } from './src/settings/agentRegistrySection.ts';
import { type HarnessDef, detectHarnesses, harnessDef, headlessArgs, looksUnauthenticated, resumeShell, runHeadless } from './src/harnesses.ts';
import { readRegistry, setAgentThread } from './src/registry.ts';
import { claudeInboxHolds, claudeInboxQueued, findClaudeInbox, sendToClaudeInbox } from './src/claudeInbox.ts';
import { DeliveryLog, type DeliveryLine } from './src/deliveryStatus.ts';
import type { DeliveredMention } from './src/mentionDeliveryService.ts';
import { SUGGESTED_HOTKEY, bindSuggestedHotkey, boundHotkeys, formatHotkey, openHotkeySettings, sameHotkey } from './src/hotkeys.ts';
import { localIsoDate } from './src/localDate.ts';
import {
  GLOBAL_THREAD_END_MARKER,
  GLOBAL_THREAD_START_MARKER,
  appendGlobalThreadEntry,
  hasOnlyGlobalThreadBlockChanged,
  parseGlobalThreadBlock,
  type GlobalThreadEngine,
} from './src/globalThread.ts';

// ─── Default type chips ────────────────────────────────────────────────────────

export const DEFAULT_COMMENT_TYPES: CommentTypeConfig[] = [
  { id: 'agree',     emoji: '🟢', label: '认同',   color: '#6FA287' },
  { id: 'disagree',  emoji: '🔴', label: '不认同', color: '#C96C6C' },
  { id: 'question',  emoji: '🟡', label: '疑问',   color: '#D4A24C' },
  { id: 'important', emoji: '🔵', label: '重要',   color: '#6A8FCF' },
  { id: 'note',      emoji: '⚪', label: '备注',   color: '#9AA0A6' },
];

export const DEFAULT_AI_AGENTS: AIAgentConfig[] = [
  { id: 'claude', name: 'Claude', avatarChar: 'C', avatarBg: '#7B61FF', resumeType: 'claude-resume' },
  { id: 'codex',  name: 'Codex',  avatarChar: 'X', avatarBg: '#10A37F', resumeType: 'claude-resume' },
  { id: 'gemini', name: 'Gemini', avatarChar: 'G', avatarBg: '#4285F4', resumeType: 'claude-resume' },
];

// ─── Settings ─────────────────────────────────────────────────────────────────

interface ILCSettings {
  authorName:     string;
  avatarBg:       string; // user avatar background color
  commentTypes:   CommentTypeConfig[];
  aiAgents:       AIAgentConfig[];
  defaultAIAgent: string; // id of the default AI agent to request
  globalThreadEngine: GlobalThreadEngine;
  enableUnreadSignal: boolean;
  /** Panel background: follow sidebar (theme default), follow editor, or a custom color */
  panelBackground: 'sidebar' | 'editor' | 'custom';
  panelBackgroundColor: string;
  /** Deliver `[@名字](agent:id?notify)` mentions as mailbox letters (in-plugin scanner) */
  enableMentionDelivery: boolean;
  /** Vault-relative mailbox root; letters go to <root>/<短id>/ */
  mailboxRoot: string;
  /** Show resolved threads in the panel (collapsed) or hide them */
  showResolved: boolean;
  /** UI language: follow Obsidian, or force zh / en */
  language: 'auto' | 'zh' | 'en';
}

const DEFAULT_SETTINGS: ILCSettings = {
  authorName:     'user',
  avatarBg:       '#7C4DFF',
  commentTypes:   DEFAULT_COMMENT_TYPES,
  aiAgents:       DEFAULT_AI_AGENTS,
  defaultAIAgent: 'claude',
  globalThreadEngine: 'claude',
  enableUnreadSignal: true,
  panelBackground: 'sidebar',
  panelBackgroundColor: '#f4f4f2',
  enableMentionDelivery: true,
  mailboxRoot: DEFAULT_MAILBOX_ROOT,
  showResolved: true,
  language: 'auto',
};

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class InlineCommentsPlugin extends Plugin implements ICommentHost {
  settings: ILCSettings = DEFAULT_SETTINGS;
  private runningGlobalThreads = new Set<string>();
  /** Per-member chain of headless runs (Codex / Gemini), keyed by sessionId */
  private headlessRuns = new Map<string, Promise<void>>();
  private runningAgentReplies = new Set<string>();
  unreadTracker!: UnreadTracker;
  explorerBadge!: ExplorerBadge;
  mentionDelivery!: MentionDelivery;
  deliveryLog!: DeliveryLog;

  async onload(): Promise<void> {
    await this.loadSettings();
    setLocale(this.settings.language);

    // Register sidebar view
    this.registerView(VIEW_TYPE_COMMENTS, (leaf) => new CommentPanel(leaf, this));

    // Register CodeMirror 6 extension
    this.registerEditorExtension(buildCommentExtension(this));

    // Reading view: same highlight + badge, raw comment markup hidden
    this.registerMarkdownPostProcessor(readingPostProcessor(this));
    // Mode switches (source ↔ reading) re-anchor everything
    this.registerEvent(this.app.workspace.on('layout-change', () => void this.getPanel()?.refresh()));

    // Command: add inline comment → opens draft card in sidebar
    this.addCommand({
      id: 'add-inline-comment',
      name: t('添加划线评论'),
      editorCallback: (editor) => this.addCommentFromSelection(editor),
    });

    // Right-click on a selection → 添加划线评论 (no hotkey needed)
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) =>
          item
            .setTitle(t('添加划线评论'))
            .setIcon('message-square')
            .setSection('selection')
            .onClick(() => this.addCommentFromSelection(editor)),
        );
      }),
    );

    // Command: open/reveal comments panel
    this.addCommand({
      id: 'open-comments-panel',
      name: t('打开评论面板'),
      callback: async () => {
        await this.activatePanel();
      },
    });

    // Command: open deletion history
    this.addCommand({
      id: 'open-comment-history',
      name: t('查看评论删除历史'),
      callback: () => {
        new HistoryModal(this.app, this).open();
      },
    });

    // Command: deliver pending @ mentions now (full sweep)
    this.addCommand({
      id: 'deliver-mentions-now',
      name: t('投递未送达的 @ 留言（全库扫描）'),
      callback: () => void this.mentionDelivery.sweep(true),
    });

    // Command: manage @-mention members
    this.addCommand({
      id: 'manage-comment-members',
      name: t('管理评论 @ 成员'),
      callback: () => new MembersModal(this.app).open(),
    });

    // Command: document-level AI conversation block
    this.addCommand({
      id: 'start-or-continue-global-thread',
      name: t('开始/继续文档对话'),
      callback: () => {
        this.openGlobalThreadModal();
      },
    });

    // Ribbon icon
    this.addRibbonIcon('message-square', t('评论面板'), async () => {
      await this.activatePanel();
    });

    // Editor @-mention suggest (body text)
    this.registerEditorSuggest(new AgentSuggest(this.app, this));

    // Settings tab
    this.addSettingTab(new ILCSettingTab(this.app, this));

    // Unread reply tracker
    this.unreadTracker = new UnreadTracker(
      this.app,
      this.pluginDir(),
      () => this.settings.enableUnreadSignal,
      () => this.settings.authorName,
    );
    this.unreadTracker.init();

    // Red unread badge on file-explorer rows (driven by the tracker's counts)
    this.explorerBadge = new ExplorerBadge(this.app, () => this.settings.enableUnreadSignal);
    this.unreadTracker.onChange((counts) => this.explorerBadge.setCounts(counts));
    this.app.workspace.onLayoutReady(() => this.explorerBadge.attach());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.explorerBadge.attach()));

    // Where each @ letter is, for the line under the comment
    this.deliveryLog = new DeliveryLog(this.app, `${this.pluginDir()}/delivery-status.json`);
    await this.deliveryLog.load();
    this.deliveryLog.onChange((r) => this.getPanel()?.updateDelivery(r));
    if (Platform.isDesktop) this.app.workspace.onLayoutReady(() => void this.refreshHookState().then(() => this.getPanel()?.updateDelivery()));

    // @ mention → mailbox letter (replaces the external cron scanner)
    this.mentionDelivery = new MentionDelivery(
      this.app,
      () => ({ enabled: this.settings.enableMentionDelivery, mailboxRoot: this.settings.mailboxRoot }),
      (msg) => new Notice(msg),
      (c, relPath, letterPath, mention) => void this.onLetter(c, relPath, letterPath, mention),
    );
    this.mentionDelivery.init();

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        this.unreadTracker.scheduleRecompute(file);
        this.mentionDelivery.schedule(file);
        void this.onLetterChanged(file);
      }),
    );
  }

  // ── Mailbox hook (Claude Code) ────────────────────────────────────────────────

  /** Absolute vault path (desktop adapters only) */
  vaultBasePath(): string | null {
    const base = (this.app.vault.adapter as any)?.basePath;
    return typeof base === 'string' ? base : null;
  }

  mailboxRootAbs(): string | null {
    const base = this.vaultBasePath();
    return base ? nodePath().join(base, this.settings.mailboxRoot) : null;
  }

  hookScriptPath(): string | null {
    const base = this.vaultBasePath();
    const dir = this.pluginDir();
    return base ? nodePath().join(base, dir, 'hooks', HOOK_SCRIPT_NAME) : null;
  }

  async hookStatus(): Promise<HookStatus | null> {
    if (!Platform.isDesktop) return null;
    const script = this.hookScriptPath();
    const root = this.mailboxRootAbs();
    if (!script || !root) return null;
    try { return await getHookStatus(script, root, getLocale()); } catch { return null; }
  }

  /** Write the hook script and register it in ~/.claude/settings.json (idempotent, backed up) */
  async installHooks(): Promise<{ backup?: string; settingsPath: string } | null> {
    if (!Platform.isDesktop) { new Notice(t('唤醒 hook 只能在桌面端安装')); return null; }
    const script = this.hookScriptPath();
    const root = this.mailboxRootAbs();
    if (!script || !root) { new Notice(t('仅桌面端支持安装唤醒 hook')); return null; }
    const res = await installClaudeHooks(script, root, getLocale());
    new Notice(t('唤醒 hook 已安装到 {0}{1}', [res.settingsPath, res.backup ? '（原文件已备份）' : '']));
    await this.refreshHookState();
    this.getPanel()?.updateDelivery();
    return res;
  }

  async uninstallHooks(): Promise<void> {
    if (!Platform.isDesktop) return;
    await uninstallClaudeHooks();
    new Notice(t('唤醒 hook 已移除'));
    await this.refreshHookState();
    this.getPanel()?.updateDelivery();
  }

  /** macOS notification (best-effort, desktop only) */
  notifyDesktop(title: string, body: string): void {
    if (!Platform.isDesktop) return;
    if (process.platform !== 'darwin') return;
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      nodeCp().execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
    } catch { /* ignore */ }
  }

  /** Open a terminal that resumes (or starts) the given session in its directory (macOS) */
  async resumeInTerminal(sessionId: string, cwd?: string, harness?: string, threadId?: string): Promise<void> {
    if (!Platform.isDesktop) { new Notice(t('在终端恢复会话只支持桌面端')); return; }
    const dir = cwd || this.vaultBasePath() || process.cwd();
    const h = harnessDef(harness);
    const plan = h && h.mode === 'headless'
      ? { mode: 'resume' as const, sessionId, cwd: dir, shell: resumeShell(h.id, dir, threadId ?? sessionId) }
      : buildLaunchPlan({ sessionId, cwd: dir, exists: await sessionFileExists(sessionId) });
    const r = await launchInTerminal(plan);
    if (r === 'unsupported') new Notice(t('仅 macOS 支持在终端启动会话'));
  }

  /** One click: bind ⌘⇧K to 添加划线评论 as the user's own hotkey (refused if another command holds it) */
  bindAddCommentHotkey(): void {
    const key = formatHotkey(SUGGESTED_HOTKEY, Platform.isMacOS);
    const res = bindSuggestedHotkey(this.app);
    if (res.ok) new Notice(t('已设置：按 {0} 添加划线评论', [key]));
    else {
      new Notice(res.conflict ? t('{0} 已被「{1}」占用，请换一个', [key, res.conflict]) : t('没能自动设置，请自己选一个快捷键'));
      this.openAddCommentHotkeySettings();
    }
    void this.getPanel()?.refresh();
  }

  /** Settings → Hotkeys, filtered to 添加划线评论 */
  openAddCommentHotkeySettings(): void {
    if (!openHotkeySettings(this.app, t('添加划线评论'))) new Notice(t('请在 设置 → 快捷键 里搜「添加划线评论」'));
  }

  /**
   * A letter was written for member `c`. A Claude Code session that is running
   * (in the Claude app or a terminal) gets it right away through its inbox;
   * otherwise the user is notified and auto-start members are started or answered.
   * Each step is recorded, so the card under the comment can say where the letter is.
   */
  private async onLetter(c: Candidate, relPath: string, letterPath: string, mention?: DeliveredMention): Promise<void> {
    const harness = harnessDef(c.harness);
    const key = mention?.key;
    if (mention) {
      this.deliveryLog.record({
        key: mention.key, doc: relPath, highlight: mention.highlight, text: mention.text, shortId: c.shortId,
        name: c.name, sessionId: c.sessionId, harness: c.harness, letter: letterPath, state: 'sending',
      });
    }
    const inbox = harness?.id === 'claude' ? await this.handToClaudeInbox(c, letterPath) : 'closed';
    if (inbox === 'handed') { this.logDelivery(key, { state: 'handed', route: 'inbox' }); return; }
    const file = relPath.split('/').pop();
    if (inbox === 'held') {
      this.logDelivery(key, { state: 'mailbox', reason: 'held' });
      this.notifyDesktop(t('评论区有新留言给 {0}', [c.name]), t('{0} · Claude Code 没让留言直接送进它的会话（跳过权限确认的会话不收）；它下一次说话/收尾时会看到', [file]));
      return; // running already: nothing to start
    }
    if (harness?.mode === 'headless' && !c.autoStart) this.logDelivery(key, { state: 'mailbox', reason: 'not-autostart' });
    // headless members answer right away and say so themselves
    if (!(c.autoStart && harness?.mode === 'headless')) {
      this.notifyDesktop(t('评论区有新留言给 {0}', [c.name]), t('{0} · 它下一次说话/收尾时会看到', [file]));
    }
    await this.maybeAutoStart(c, letterPath, key);
    // nothing took it: it waits in the mailbox
    if (key && this.deliveryLog.byKey(key)?.state === 'sending') this.logDelivery(key, { state: 'mailbox' });
  }

  private logDelivery(key: string | undefined, patch: Parameters<DeliveryLog['update']>[1]): void {
    if (key) this.deliveryLog.update(key, patch);
  }

  /** Whether the wake hook is installed for this vault (cached for the cards) */
  hookInstalled = false;

  async refreshHookState(): Promise<boolean> {
    const st = await this.hookStatus();
    this.hookInstalled = !!st?.installed && !st.stale;
    return this.hookInstalled;
  }

  /** The card's button under an @: retry the letter, install the hook, sign the CLI in, or open the session */
  async deliveryAction(key: string, action: DeliveryLine['action']): Promise<void> {
    const rec = this.deliveryLog.byKey(key);
    if (!rec || !action) return;
    if (action === 'hook') { await this.installHooks(); return; }
    if (action === 'login') { await this.openHarnessLogin(rec.harness); return; }
    const c = await this.mentionDelivery.candidate(rec.shortId);
    if (!c) { new Notice(t('找不到成员「{0}」了', [rec.name])); return; }
    if (action === 'open') { await this.openMemberSession(c); return; }
    try {
      const raw = await this.app.vault.adapter.read(rec.letter);
      await this.app.vault.adapter.write(rec.letter, raw.replace(/^status: .*$/m, 'status: 未读'));
    } catch {
      new Notice(t('这封信已经不在信箱里了'));
      return;
    }
    await this.onLetter(c, rec.doc, rec.letter, { key: rec.key, highlight: rec.highlight, text: rec.text });
  }

  /** Show the member's session: its chat in the Claude app, else a terminal that resumes it */
  async openMemberSession(c: Pick<Candidate, 'name' | 'sessionId' | 'harness' | 'cwd' | 'threadId'>): Promise<void> {
    if (harnessDef(c.harness)?.id === 'claude') {
      const inbox = Platform.isDesktop ? await findClaudeInbox(c.sessionId) : null;
      if (inbox?.hostSessionId) { await openExternalUrl(`claude://code/continue?session=${inbox.hostSessionId}`); return; }
      if (inbox) { new Notice(t('「{0}」开在终端里，去那个窗口看看', [c.name])); return; }
    }
    await this.resumeInTerminal(c.sessionId, c.cwd, c.harness, c.threadId);
  }

  /** Open a terminal where the user signs the Codex / Gemini CLI in */
  async openHarnessLogin(harness: string | undefined): Promise<void> {
    const h = harnessDef(harness);
    if (!h || h.mode !== 'headless' || !Platform.isDesktop) return;
    const bin = (await detectHarnesses()).bins[h.id] ?? h.bin;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const shell = h.id === 'codex' ? `${q(bin)} login` : q(bin);
    const r = await launchInTerminal({ mode: 'new', sessionId: '', cwd: this.vaultBasePath() || process.cwd(), shell });
    if (r === 'unsupported') new Notice(t('请在终端里运行 {0} 登录', [h.id === 'codex' ? 'codex login' : 'gemini']));
  }

  /** The wake hook marks a letter it handed over: tell the card */
  private async onLetterChanged(file: TFile): Promise<void> {
    const rec = this.deliveryLog.byLetter(file.path);
    if (!rec || rec.state === 'handed') return;
    try {
      if ((await this.app.vault.adapter.read(file.path)).includes('status: 已读（hook代标）')) this.deliveryLog.update(rec.key, { state: 'handed', route: 'hook' });
    } catch { /* letter gone */ }
  }

  /**
   * Put the letter into the member's running Claude Code session. 'held': the
   * session runs but would not take it (bypass permissions), or did not queue it,
   * so the letter stays unread in the mailbox. 'closed': no running session.
   */
  private async handToClaudeInbox(c: Candidate, letterPath: string): Promise<'handed' | 'held' | 'closed'> {
    if (!Platform.isDesktop) return 'closed';
    const inbox = await findClaudeInbox(c.sessionId);
    if (!inbox) return 'closed';
    if (await claudeInboxHolds(inbox)) return 'held';
    const adapter = this.app.vault.adapter;
    let raw: string;
    try { raw = await adapter.read(letterPath); } catch { return 'handed'; }
    if (!raw.includes('status: 未读')) return 'handed'; // the hook already handed it over
    const handed = 'status: 已读（已送进会话）';
    await adapter.write(letterPath, raw.replace('status: 未读', handed));
    const body = raw.split('\n---\n').slice(1).join('\n---\n');
    const cwd = inbox.cwd || c.cwd || this.vaultBasePath() || process.cwd();
    const prompt = buildLaunchPrompt(c.name, body, localIsoDate(), getLocale(), this.vaultDirFor(cwd));
    const msgId = nodeCrypto().randomUUID();
    if (await sendToClaudeInbox(inbox, prompt, msgId) === 'unreachable') {
      await this.restoreUnread(letterPath, handed);
      return 'closed';
    }
    if (!await claudeInboxQueued(inbox.sessionId, prompt, msgId)) {
      await this.restoreUnread(letterPath, handed);
      return 'held';
    }
    new Notice(t('留言已送进「{0}」的会话（{1}）', [c.name, inbox.desktop ? t('Claude 客户端') : t('终端')]));
    return 'handed';
  }

  /**
   * A letter was delivered to a member that asked to be auto-started: if its
   * session is not running, start (new) or resume (known) it in a terminal with
   * the letter as the first message. The letter is marked as handed over so the
   * hook does not inject it a second time.
   */
  async maybeAutoStart(c: Candidate, letterPath: string, key?: string): Promise<void> {
    if (!Platform.isDesktop) return; // letters are still written; a desktop session picks them up
    const harness = harnessDef(c.harness);
    if (!c.autoStart || !harness) return;
    if (harness.mode === 'headless') {
      // One run at a time per member: the next letter resumes the session the previous run created
      this.logDelivery(key, { state: 'handed', route: 'background' });
      const next = (this.headlessRuns.get(c.sessionId) ?? Promise.resolve()).then(() => this.answerHeadless(c, harness, letterPath, key));
      this.headlessRuns.set(c.sessionId, next);
      void next.finally(() => { if (this.headlessRuns.get(c.sessionId) === next) this.headlessRuns.delete(c.sessionId); });
      return;
    }
    const started = 'status: 已读（启动代标）';
    try {
      const running = await runningClaudeIds();
      if (running.has(c.sessionId.toLowerCase())) return;
      const adapter = this.app.vault.adapter;
      const raw = await adapter.read(letterPath);
      if (!raw.includes('status: 未读')) return; // already handed over by the hook
      await adapter.write(letterPath, raw.replace('status: 未读', started));
      const body = raw.split('\n---\n').slice(1).join('\n---\n');
      const cwd = c.cwd || this.vaultBasePath() || process.cwd();
      const prompt = buildLaunchPrompt(c.name, body, localIsoDate(), getLocale(), this.vaultDirFor(cwd));
      const promptFile = await writePromptFile(c.sessionId, prompt);
      const exists = await sessionFileExists(c.sessionId);
      const plan = buildLaunchPlan({ sessionId: c.sessionId, cwd, promptFile, exists });
      const r = await launchInTerminal(plan);
      if (r === 'unsupported') {
        // nothing was started: the letter waits in the mailbox
        await this.restoreUnread(letterPath, started);
        new Notice(t('「{0}」未在运行，且当前平台不支持自动启动', [c.name]));
        return;
      }
      this.logDelivery(key, { state: 'handed', route: 'terminal' });
      if (r === 'launched') new Notice(t('已在终端{0}会话「{1}」，留言已交给它', [plan.mode === 'new' ? '启动' : '恢复', c.name]));
    } catch (err) {
      console.error('[ilc] auto-start failed', err);
      await this.restoreUnread(letterPath, started);
      this.logDelivery(key, { state: 'failed', reason: 'error', detail: shortError(err) });
      new Notice(t('自动启动「{0}」失败：{1}', [c.name, String((err as Error)?.message ?? err)]));
    }
  }

  /** The vault folder, when a session working in `cwd` cannot reach notes by their vault-relative path */
  private vaultDirFor(cwd: string): string | undefined {
    const vault = this.vaultBasePath();
    return vault && nodePath().resolve(cwd) !== nodePath().resolve(vault) ? vault : undefined;
  }

  /**
   * Codex / Gemini: answer one letter with a headless run that resumes the
   * member's session (or starts it). The reply lands in the note like any other;
   * failures are reported and the letter goes back to unread.
   */
  private async answerHeadless(c: Candidate, harness: HarnessDef, letterPath: string, key?: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    let raw: string;
    try { raw = await adapter.read(letterPath); } catch { return; }
    if (!raw.includes('status: 未读')) return;
    const handed = `status: 已读（已交给 ${harness.label}）`;
    try {
      const { bins, path } = await detectHarnesses();
      const bin = bins[harness.id];
      if (!bin) {
        this.logDelivery(key, { state: 'failed', reason: 'missing-cli' });
        new Notice(t('本机没找到 {0}，「{1}」没法回复', [harness.label, c.name]));
        return;
      }
      await adapter.write(letterPath, raw.replace('status: 未读', handed));
      this.logDelivery(key, { state: 'handed', route: 'background' });

      // Read the thread id now, not from the candidate: the previous run may have just stored it
      const threadId = (await readRegistry(this.app)).agents.find((a) => a.sessionId === c.sessionId)?.threadId;
      const vault = this.vaultBasePath();
      const cwd = c.cwd || vault || process.cwd();
      const rel = vault ? nodePath().relative(cwd, vault) : '';
      const extraDir = vault && (rel.startsWith('..') || nodePath().isAbsolute(rel)) ? vault : undefined;
      const body = raw.split('\n---\n').slice(1).join('\n---\n');
      const prompt = buildLaunchPrompt(c.name, body, localIsoDate(), getLocale(), this.vaultDirFor(cwd));
      const logFile = nodePath().join(nodeOs().tmpdir(), 'ilc-runs', `${c.shortId}.log`);

      new Notice(t('「{0}」（{1}）正在回复…', [c.name, harness.label]));
      const res = await runHeadless(harness.id, {
        bin, path, cwd, logFile, sessionId: c.sessionId,
        args: headlessArgs(harness.id, { sessionId: c.sessionId, threadId, extraDir }, prompt),
        stdin: harness.id === 'codex' ? prompt : undefined,
      });
      if (res.threadId && res.threadId !== threadId) await setAgentThread(this.app, c.sessionId, res.threadId);
      if (res.ok) return; // the reply shows up in the panel when the note changes

      console.error('[ilc] headless run failed', harness.id, res.error, logFile);
      await this.restoreUnread(letterPath, handed);
      const unauthenticated = looksUnauthenticated(res.error);
      this.logDelivery(key, unauthenticated ? { state: 'failed', reason: 'not-logged-in' } : { state: 'failed', reason: 'error', detail: shortError(res.error) });
      new Notice(unauthenticated
        ? t('「{0}」没回复：{1} 还没登录。先在终端运行 {2} 登录一次。', [c.name, harness.label, harness.bin])
        : t('「{0}」没回复：{1}（日志在 {2}）', [c.name, res.error ?? '', logFile]), 12000);
    } catch (err) {
      console.error('[ilc] headless run failed', err);
      await this.restoreUnread(letterPath, handed);
      this.logDelivery(key, { state: 'failed', reason: 'error', detail: shortError(err) });
      new Notice(t('「{0}」没回复：{1}', [c.name, String((err as Error)?.message ?? err)]));
    }
  }

  private async restoreUnread(letterPath: string, handed: string): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(letterPath);
      if (raw.includes(handed)) await this.app.vault.adapter.write(letterPath, raw.replace(handed, 'status: 未读'));
    } catch { /* letter gone */ }
  }

  /** Open the draft card for the current editor selection */
  async addCommentFromSelection(editor: Editor): Promise<void> {
    const sel = editor.getSelection();
    if (!sel) return;

    const from = editor.posToOffset(editor.getCursor('from'));

    await this.activatePanel();

    const panel = this.getPanel();
    if (!panel) return;

    const to = from + sel.length;
    panel.showDraftCard(sel, from, (markup: string) => {
      const fromPos = editor.offsetToPos(from);
      const toPos   = editor.offsetToPos(to);
      editor.replaceRange(markup, fromPos, toPos);
    });
  }

  /** Vault-relative folder of this plugin (honours a custom config dir) */
  pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  onunload(): void {
    this.explorerBadge?.detach();
    // Deliberately no detachLeavesOfType: Obsidian restores the leaf itself, and
    // detaching here would reset a panel the user moved to another sidebar.
  }

  /** Badge after a highlight was clicked → open the panel and focus the card */
  onBadgeClick(annotationId: string): void {
    void (async () => {
      await this.activatePanel();
      this.getPanel()?.highlightCard(annotationId);
    })();
  }

  /** Called by CM6 extension when editor cursor enters an annotation */
  onEditorCursorInAnnotation(annotationId: string, view?: EditorView): void {
    const panel = this.getPanel();
    if (!panel || !panel.isCurrentEditor(view)) return;
    panel.highlightCard(annotationId);
  }

  /** Called by CM6 extension when annotation positions change */
  onPositionsUpdated(positions: AnnotationPosition[], view?: EditorView): void {
    this.getPanel()?.syncPositions(positions, view);
  }

  /** Called by CM6 extension when the editor scrolls */
  onEditorScroll(scrollTop: number, view?: EditorView): void {
    this.getPanel()?.syncEditorScroll(scrollTop, view);
  }

  /** Get the active CommentPanel instance (if any) */
  getPanel(): CommentPanel | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS);
    if (leaves.length > 0) return leaves[0].view as CommentPanel;
    return null;
  }

  /** Look up an AI agent by name (for avatar rendering) */
  getAIAgent(name: string): AIAgentConfig | undefined {
    return this.settings.aiAgents.find(
      (a) => a.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private getRegisteredAgentSession(agentName: string): {
    agent: AIAgentConfig;
    sessionId: string;
    resumeType: string;
  } | null {
    const normalizedName = agentName.trim().toLowerCase();
    const agent = this.settings.aiAgents.find(
      (item) => item.name.toLowerCase() === normalizedName,
    );
    const sessionId = agent?.sessionId?.trim();
    if (!agent || !sessionId) return null;

    const resumeType =
      (agent as AIAgentConfig & { resumeType?: string }).resumeType ??
      'claude-resume';
    return { agent, sessionId, resumeType };
  }

  // ── History ────────────────────────────────────────────────────────────────

  private get historyPath(): string {
    return `${this.manifest.dir}/history.json`;
  }

  async saveDeletedComment(
    record: Omit<DeletedRecord, 'id' | 'deletedAt'>,
  ): Promise<void> {
    const full: DeletedRecord = {
      ...record,
      id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      deletedAt: new Date().toISOString(),
    };
    const history = await this.loadDeletedHistory();
    history.unshift(full);
    if (history.length > 500) history.splice(500);
    try {
      await this.app.vault.adapter.write(
        this.historyPath,
        JSON.stringify(history, null, 2),
      );
    } catch (e) {
      console.error('ILC: failed to save history', e);
    }
  }

  async loadDeletedHistory(): Promise<DeletedRecord[]> {
    try {
      const raw = await this.app.vault.adapter.read(this.historyPath);
      return JSON.parse(raw) as DeletedRecord[];
    } catch {
      return [];
    }
  }

  async clearDeletedHistory(): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.historyPath, '[]');
    } catch (e) {
      console.error('ILC: failed to clear history', e);
    }
  }

  /** Name of the default AI agent to request responses from */
  getDefaultAIAgentName(): string {
    const agent = this.settings.aiAgents.find(
      (a) => a.id === this.settings.defaultAIAgent,
    );
    return agent?.name ?? 'Claude';
  }

  private openGlobalThreadModal(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice(t('请先打开一篇 Markdown 笔记'));
      return;
    }

    new GlobalThreadModal(this.app, async (message) => {
      await this.continueGlobalThread(file, message);
    }).open();
  }

  private async continueGlobalThread(file: TFile, message: string): Promise<void> {
    if (this.runningGlobalThreads.has(file.path)) {
      new Notice(t('文档对话正在进行中'));
      return;
    }

    const absolutePath = this.getAbsoluteFilePath(file);
    if (!absolutePath) {
      new Notice(t('文档对话需要桌面文件系统路径，当前 vault adapter 不支持'));
      return;
    }

    this.runningGlobalThreads.add(file.path);

    const date = localIsoDate();
    const engine = this.settings.globalThreadEngine;
    const aiName = this.getGlobalThreadAgentName(engine);
    let contentWithUserMessage = '';

    try {
      const before = await this.app.vault.read(file);
      contentWithUserMessage = appendGlobalThreadEntry(before, {
        author: this.settings.authorName,
        date,
        text: message,
      });
      const expectedBlock = parseGlobalThreadBlock(contentWithUserMessage);
      if (!expectedBlock) throw new Error(t('无法创建文档对话块'));

      await this.app.vault.modify(file, contentWithUserMessage);
      new Notice(t('文档对话：正在请求 {0}...', [aiName]));

      await this.runGlobalThreadEngine(engine, absolutePath, aiName, date);

      const after = await this.app.vault.adapter.read(file.path);
      const afterBlock = parseGlobalThreadBlock(after);
      this.refreshActiveMarkdownView(file, after, contentWithUserMessage);

      if (!afterBlock) {
        new Notice(t('文档对话：AI 执行完成，但全局对话块未解析成功，请检查'), 10000);
        return;
      }

      const onlyThreadChanged = hasOnlyGlobalThreadBlockChanged(
        contentWithUserMessage,
        after,
      );
      const appendedReply = afterBlock.entries.length > expectedBlock.entries.length;

      if (!onlyThreadChanged) {
        new Notice(t('文档对话：AI 已返回，但检测到块外内容变化，请检查文档'), 10000);
      } else if (!appendedReply) {
        new Notice(t('文档对话：AI 已返回，但未检测到新增回复'), 10000);
      } else {
        new Notice(t('文档对话：AI 回复已写回'));
      }
    } catch (error) {
      const messageText = formatProcessError(error);
      console.error('ILC: global thread engine failed:', messageText);
      new Notice(t('文档对话：AI 应答失败：{0}', [messageText]), 10000);
    } finally {
      this.runningGlobalThreads.delete(file.path);
    }
  }

  /** Called by UI: ask a registered Agent session to reply to one annotation. */
  async requestAgentReply(
    file: TFile,
    annotationFrom: number,
    agentName: string,
  ): Promise<void> {
    if (!Platform.isDesktop) { new Notice(t('请 AI 直接回应只支持桌面端')); return; }
    const lockKey = `${file.path}:${annotationFrom}`;
    if (this.runningAgentReplies.has(lockKey)) {
      new Notice(t('评论回应正在进行中'));
      return;
    }

    const registeredAgent = this.getRegisteredAgentSession(agentName);
    if (!registeredAgent) {
      new Notice(t('未找到已注册会话: ') + agentName);
      return;
    }
    if (registeredAgent.resumeType !== 'claude-resume') {
      new Notice(t('暂不支持会话类型: ') + registeredAgent.resumeType);
      return;
    }

    const absolutePath = this.getAbsoluteFilePath(file);
    if (!absolutePath) {
      new Notice(t('评论回应需要桌面文件系统路径，当前 vault adapter 不支持'));
      return;
    }

    this.runningAgentReplies.add(lockKey);

    const cwd = getParentDir(absolutePath);
    const date = localIsoDate();
    let before = '';

    try {
      before = await this.app.vault.read(file);
      const annotation = parseAnnotations(before).find(
        (item) => item.from === annotationFrom,
      );
      if (!annotation) {
        new Notice(t('评论回应：未找到目标评论块'), 10000);
        return;
      }

      const prompt = buildAgentReplyPrompt({
        absolutePath,
        agentName: registeredAgent.agent.name,
        highlightText: annotation.highlightText,
        existingComments: annotation.comments.map((comment) => ({
          author: comment.author,
          type:   comment.type,
          text:   comment.text,
        })),
        date,
      });

      new Notice(t('评论回应：正在请求 {0}...', [registeredAgent.agent.name]));
      const replyOutput = await runHeadlessCommandCapture(
        'claude',
        ['--print', '--resume', registeredAgent.sessionId, '-p', prompt],
        cwd,
      );
      const replyText = cleanReplyText(replyOutput);

      if (!replyText) {
        new Notice(t('评论回应：Agent 未返回内容'), 10000);
        return;
      }

      const reply: CommentEntry = {
        author: registeredAgent.agent.name,
        date,
        type: 'reply',
        text: replyText,
      };
      const current = await this.app.vault.read(file);
      if (current !== before) {
        new Notice(t('评论回应：文档已变更，请重试'), 10000);
        return;
      }
      const after = appendReply(before, annotationFrom, reply);
      await this.app.vault.modify(file, after);
      this.refreshActiveMarkdownView(file, after, before, t('评论回应'));
      await this.appendAgentReplyLog(
        cwd,
        registeredAgent.agent.name,
        file,
        annotation.highlightText,
      );
      new Notice(t('评论回应：AI 回复已写回'));
    } catch (error) {
      const messageText = formatProcessError(error);
      console.error('ILC: agent reply failed:', messageText);
      new Notice(t('评论回应：AI 应答失败：{0}', [messageText]), 10000);
    } finally {
      this.runningAgentReplies.delete(lockKey);
    }
  }

  private getGlobalThreadAgentName(engine: GlobalThreadEngine): string {
    return engine === 'glm' ? 'GLM' : 'Claude';
  }

  private async runGlobalThreadEngine(
    engine: GlobalThreadEngine,
    absolutePath: string,
    aiName: string,
    date: string,
  ): Promise<void> {
    const prompt = this.buildGlobalThreadPrompt(absolutePath, aiName, date);
    const cwd = getParentDir(absolutePath);

    if (engine === 'glm') {
      await runHeadlessCommand(
        '/Users/yytyyf/Documents/main/_os/scripts/glm.sh',
        [prompt],
        cwd,
      );
      return;
    }

    await runHeadlessCommand('claude', ['-p', prompt], cwd);
  }

  private async appendAgentReplyLog(
    documentDir: string | undefined,
    agentName: string,
    file: TFile,
    highlightText: string,
  ): Promise<void> {
    if (!documentDir) return;

    try {
      const logDir = nodePath().join(
        documentDir,
        '.agent-threads',
        safePathSegment(agentName),
      );
      await nodeFsp().mkdir(logDir, { recursive: true });
      const highlightSummary = buildLogField(highlightText).slice(0, 20);
      const line = [
        localMinuteTimestamp(),
        buildLogField(file.name),
        highlightSummary,
        '已回复',
      ].join(' | ');
      await nodeFsp().appendFile(nodePath().join(logDir, 'log.md'), `${line}\n`, 'utf8');
    } catch (error) {
      console.warn('ILC: failed to append agent reply log', error);
    }
  }

  private buildGlobalThreadPrompt(
    absolutePath: string,
    aiName: string,
    date: string,
  ): string {
    return [
      '你正在为 Obsidian Markdown 文件追加文档级 AI 对话回复。',
      `文件绝对路径：${JSON.stringify(absolutePath)}`,
      '',
      '只允许修改这个全局对话块内部：',
      GLOBAL_THREAD_START_MARKER,
      GLOBAL_THREAD_END_MARKER,
      '',
      '任务：',
      '1. 读取该文件，理解正文和全局对话块里最后一条用户消息。',
      `2. 只在全局对话块末尾追加一条 ${aiName} 回复。`,
      `3. 回复首行格式必须是：> **${aiName}｜${date}**：你的回复`,
      '4. 如果回复有多行，每一行都必须以 "> " 开头，保持在 Obsidian callout 内。',
      '5. 不要修改块外任何字符；不要修改已有对话；不要修改 `{==...==}{>>...<<}` 划线评论。',
      '6. 直接编辑并保存原文件；不要创建新文件，不要输出整篇文档。',
    ].join('\n');
  }

  private getAbsoluteFilePath(file: TFile): string | null {
    const adapter = this.app.vault.adapter as unknown;
    if (!hasFullPathAdapter(adapter)) return null;
    return adapter.getFullPath(file.path);
  }

  private refreshActiveMarkdownView(
    file: TFile,
    latestContent: string,
    expectedBeforeAI: string,
    contextLabel = t('文档对话'),
  ): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) return;

    const current = view.editor.getValue();
    if (current === latestContent) return;
    if (current === expectedBeforeAI) {
      view.editor.setValue(latestContent);
      return;
    }

    new Notice(t('{0}：当前编辑器已有新改动，未强制刷新视图', [contextLabel]), 8000);
  }

  /**
   * Highlight background for a user-defined comment type, carried inline on the
   * decoration. Built-in types return null and keep using their CSS class.
   * (Plugins must not create `<style>` elements, so there is no generated sheet.)
   */
  highlightBg(typeId: string): string | null {
    if (BUILTIN_TYPE_IDS.has(typeId)) return null;
    const cfg = this.settings.commentTypes.find((t) => t.id === typeId);
    return cfg?.color ? typeBgColor(cfg.color) : null;
  }

  private async activatePanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_COMMENTS, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // Ensure arrays have defaults if missing from older saves
    if (!Array.isArray(this.settings.commentTypes) || this.settings.commentTypes.length === 0) {
      this.settings.commentTypes = DEFAULT_COMMENT_TYPES;
    }
    if (!Array.isArray(this.settings.aiAgents) || this.settings.aiAgents.length === 0) {
      this.settings.aiAgents = DEFAULT_AI_AGENTS;
    }
    if (!['claude', 'glm'].includes(this.settings.globalThreadEngine)) {
      this.settings.globalThreadEngine = 'claude';
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** First line of an error, short enough for the card */
function shortError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? '').split('\n').find((l) => l.trim()) ?? '';
  return msg.length > 80 ? `${msg.slice(0, 80)}…` : msg;
}

function localMinuteTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function buildLogField(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '｜').trim();
}

function safePathSegment(value: string): string {
  return value.replace(/[/:\\]/g, '_').trim() || 'agent';
}

function hasFullPathAdapter(
  adapter: unknown,
): adapter is { getFullPath(filePath: string): string } {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as { getFullPath?: unknown }).getFullPath === 'function'
  );
}

function getParentDir(filePath: string): string | undefined {
  const slashIndex = filePath.lastIndexOf('/');
  return slashIndex > 0 ? filePath.slice(0, slashIndex) : undefined;
}

function runHeadlessCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeCp().execFile(
      command,
      args,
      {
        cwd,
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals | string | null;
          };
          const reason = err.killed
            ? 'timeout'
            : `code=${err.code ?? 'unknown'} signal=${err.signal ?? 'none'}`;
          reject(new Error(reason));
          return;
        }
        resolve();
      },
    );
  });
}

function runHeadlessCommandCapture(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeCp().execFile(
      command,
      args,
      {
        cwd,
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals | string | null;
          };
          const reason = err.killed
            ? 'timeout'
            : `code=${err.code ?? 'unknown'} signal=${err.signal ?? 'none'}`;
          reject(new Error(reason));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function formatProcessError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'unknown';
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class ILCSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: InlineCommentsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Author ──
    new Setting(containerEl)
      .setName(t('默认署名'))
      .setDesc(t('添加评论时使用的作者名'))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorName)
          .onChange(async (value) => {
            this.plugin.settings.authorName = value.trim() || 'user';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t('头像颜色'))
      .setDesc(t('评论头像的背景色'))
      .addColorPicker((cp) =>
        cp
          .setValue(this.plugin.settings.avatarBg)
          .onChange(async (value) => {
            this.plugin.settings.avatarBg = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Hotkey (Obsidian does not let plugins ship a default one) ──
    const keys = boundHotkeys(this.app);
    const suggested = formatHotkey(SUGGESTED_HOTKEY, Platform.isMacOS);
    const hotkeySetting = new Setting(containerEl)
      .setName(t('添加评论快捷键'))
      .setDesc(keys.length > 0
        ? t('当前：{0}', [keys.map((k) => formatHotkey(k, Platform.isMacOS)).join(' / ')])
        : t('还没设置。Obsidian 不允许插件自带默认快捷键，点「设为 {0}」由你自己绑定，或自定义一个。', [suggested]));
    if (!keys.some((k) => sameHotkey(k, SUGGESTED_HOTKEY))) {
      hotkeySetting.addButton((b) => b.setButtonText(t('设为 {0}', [suggested])).onClick(() => {
        this.plugin.bindAddCommentHotkey();
        this.display();
      }));
    }
    hotkeySetting.addButton((b) => b.setButtonText(t('自定义快捷键…')).onClick(() => this.plugin.openAddCommentHotkeySettings()));

    // ── Comment types ──
    new Setting(containerEl).setName(t('评论类型')).setHeading();
    containerEl.createEl('p', {
      text: t('每个类型对应一个快捷标签。内置类型（agree/disagree 等）颜色由样式表控制；自定义类型按所选颜色着色。'),
      cls: 'setting-item-description',
    });

    const typesEl = containerEl.createEl('div', { cls: 'ilc-settings-list' });
    this.renderTypesList(typesEl);

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText(t('+ 添加类型')).onClick(async () => {
        this.plugin.settings.commentTypes.push({
          id: 'custom',
          emoji: '💬',
          label: t('自定义'),
          color: '#9C27B0',
        });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    // ── AI agents ──
    new Setting(containerEl).setName(t('AI 助手')).setHeading();
    containerEl.createEl('p', {
      text: t('当评论作者名与此处配置的 AI 名称匹配时，会显示对应的头像和颜色。'),
      cls: 'setting-item-description',
    });

    const agentsEl = containerEl.createEl('div', { cls: 'ilc-settings-list' });
    this.renderAgentsList(agentsEl);

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText(t('+ 添加 AI 助手')).onClick(async () => {
        this.plugin.settings.aiAgents.push({
          id: `agent-${Date.now()}`,
          name: 'NewAgent',
          avatarChar: 'A',
          avatarBg: '#607D8B',
        });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    // ── Default AI agent ──
    new Setting(containerEl)
      .setName(t('默认 AI 助手'))
      .setDesc(t('点击「请 AI 回应」时，默认请求哪个 AI'))
      .addDropdown((drop) => {
        for (const agent of this.plugin.settings.aiAgents) {
          drop.addOption(agent.id, agent.name);
        }
        drop.setValue(this.plugin.settings.defaultAIAgent);
        drop.onChange(async (value) => {
          this.plugin.settings.defaultAIAgent = value;
          await this.plugin.saveSettings();
        });
        return drop;
      });

    // ── Document-level thread engine ──
    new Setting(containerEl)
      .setName(t('文档对话引擎'))
      .setDesc(t('「开始/继续文档对话」命令调用的 headless 引擎'))
      .addDropdown((drop) => {
        drop.addOption('claude', 'Claude CLI');
        drop.addOption('glm', t('GLM 脚本'));
        drop.setValue(this.plugin.settings.globalThreadEngine);
        drop.onChange(async (value) => {
          this.plugin.settings.globalThreadEngine =
            value === 'glm' ? 'glm' : 'claude';
          await this.plugin.saveSettings();
        });
        return drop;
      });

    // ── Agent registry (评论互动成员) ──
    renderAgentRegistrySection(containerEl, this.app);

    // ── Language ──
    new Setting(containerEl)
      .setName(t('语言'))
      .setDesc(t('面板、设置和提示的语言。命令名和视图标题在重启 Obsidian 后更新。'))
      .addDropdown((d) =>
        d.addOptions({ auto: t('跟随 Obsidian'), zh: '中文', en: 'English' })
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            this.plugin.settings.language = v as 'auto' | 'zh' | 'en';
            await this.plugin.saveSettings();
            setLocale(this.plugin.settings.language);
            this.display();
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)) void (leaf.view as CommentPanel).refresh();
          }),
      );

    // ── Unread signal ──
    new Setting(containerEl)
      .setName(t('未读通知'))
      .setDesc(t('别人（或 AI）的回复带红点、面板顶部显示未读数、文件目录里对应文档显示红色角标，看完点「标为已读」。关闭后这些都不出现。'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableUnreadSignal)
          .onChange(async (value) => {
            this.plugin.settings.enableUnreadSignal = value;
            await this.plugin.saveSettings();
            if (value) await this.plugin.unreadTracker.recompute();
            else await this.plugin.unreadTracker.clear();
            this.plugin.explorerBadge.render();
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)) {
              void (leaf.view as CommentPanel).refresh();
            }
          }),
      );

    new Setting(containerEl)
      .setName(t('投递 @ 留言到信箱'))
      .setDesc(t('评论里带「通知对方」的 @ 会写成一封信放进对方信箱（插件内置，不再依赖 cron 脚本）。文档保存后约 1.5 秒投递；启动时全库补扫一次。'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableMentionDelivery).onChange(async (v) => {
          this.plugin.settings.enableMentionDelivery = v;
          await this.plugin.saveSettings();
        }),
      );
    const hookSetting = new Setting(containerEl)
      .setName(t('唤醒 hook（Claude Code）'))
      .setDesc(t('装进 ~/.claude/settings.json 的三条 hook：会话说话前 / 收尾时 / 恢复时自动把新留言递给它并附回复方法。只添加自己的条目，安装前自动备份原文件。'));
    void (async () => {
      const st = await this.plugin.hookStatus();
      if (!st) { hookSetting.setDesc(t('仅桌面端可用。')); return; }
      hookSetting.setDesc(t('{0} · {1}', [st.installed ? (st.stale ? '已安装（路径已变，建议重装）' : '已安装') : '未安装', st.settingsPath]));
      hookSetting.addButton((b) =>
        b.setButtonText(st.installed ? t('重新安装') : t('安装')).setCta().onClick(async () => {
          await this.plugin.installHooks();
          this.display();
        }),
      );
      if (st.installed) {
        hookSetting.addButton((b) =>
          b.setButtonText(t('移除')).onClick(async () => {
            await this.plugin.uninstallHooks();
            this.display();
          }),
        );
      }
    })();

    new Setting(containerEl)
      .setName(t('信箱根目录'))
      .setDesc(t('vault 内相对路径，信放在 <根目录>/<会话短 id>/ 下。默认 {0}。', [DEFAULT_MAILBOX_ROOT]))
      .addText((t) =>
        t.setPlaceholder(DEFAULT_MAILBOX_ROOT).setValue(this.plugin.settings.mailboxRoot).onChange(async (v) => {
          const clean = v.trim().replace(/^\/+|\/+$/g, '');
          this.plugin.settings.mailboxRoot = clean.includes('..') ? DEFAULT_MAILBOX_ROOT : clean || DEFAULT_MAILBOX_ROOT;
          await this.plugin.saveSettings();
        }),
      )
      .addButton((b) => b.setButtonText(t('立即全库投递')).onClick(() => void this.plugin.mentionDelivery.sweep(true)));

    const bgSetting = new Setting(containerEl)
      .setName(t('面板背景'))
      .setDesc(t('评论面板的底色：跟随侧栏＝主题侧栏色；跟随正文＝与编辑区同色；自定义＝右侧取色。'))
      .addDropdown((d) =>
        d
          .addOptions({ sidebar: t('跟随侧栏'), editor: t('跟随正文'), custom: t('自定义颜色') })
          .setValue(this.plugin.settings.panelBackground)
          .onChange(async (value) => {
            this.plugin.settings.panelBackground = value as ILCSettings['panelBackground'];
            await this.plugin.saveSettings();
            this.plugin.getPanel()?.applyPanelBackground();
            this.display();
          }),
      );
    if (this.plugin.settings.panelBackground === 'custom') {
      bgSetting.addColorPicker((c) =>
        c
          .setValue(this.plugin.settings.panelBackgroundColor)
          .onChange(async (value) => {
            this.plugin.settings.panelBackgroundColor = value;
            await this.plugin.saveSettings();
            this.plugin.getPanel()?.applyPanelBackground();
          }),
      );
    }
  }

  private renderTypesList(container: HTMLElement): void {
    container.empty();
    this.plugin.settings.commentTypes.forEach((type, i) => {
      const row = container.createEl('div', { cls: 'ilc-settings-row' });

      const emojiIn = row.createEl('input', {
        cls: 'ilc-settings-input-emoji',
        attr: { type: 'text', value: type.emoji, title: 'emoji' },
      }) as HTMLInputElement;
      emojiIn.addEventListener('change', async () => {
        type.emoji = emojiIn.value.trim() || '💬';
        await this.plugin.saveSettings();
      });

      const idIn = row.createEl('input', {
        cls: 'ilc-settings-input-id',
        attr: { type: 'text', value: type.id, title: t('类型 ID（写入 Markdown）'), placeholder: 'id' },
      }) as HTMLInputElement;
      idIn.addEventListener('change', async () => {
        type.id = idIn.value.trim().replace(/\s+/g, '_') || 'custom';
        await this.plugin.saveSettings();
      });

      const labelIn = row.createEl('input', {
        cls: 'ilc-settings-input-label',
        attr: { type: 'text', value: type.label, title: t('显示标签'), placeholder: t('标签') },
      }) as HTMLInputElement;
      labelIn.addEventListener('change', async () => {
        type.label = labelIn.value.trim() || type.id;
        await this.plugin.saveSettings();
      });

      const colorIn = row.createEl('input', {
        cls: 'ilc-settings-input-color',
        attr: { type: 'color', value: type.color, title: t('颜色') },
      }) as HTMLInputElement;
      colorIn.addEventListener('change', async () => {
        type.color = colorIn.value;
        await this.plugin.saveSettings();
      });

      const delBtn = row.createEl('button', {
        cls: 'ilc-settings-del-btn',
        text: '×',
        attr: { title: t('删除') },
      });
      delBtn.addEventListener('click', async () => {
        this.plugin.settings.commentTypes.splice(i, 1);
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }

  private renderAgentsList(container: HTMLElement): void {
    container.empty();
    this.plugin.settings.aiAgents.forEach((agent, i) => {
      const row = container.createEl('div', { cls: 'ilc-settings-row' });

      const preview = row.createEl('div', {
        cls: 'ilc-settings-avatar-preview',
        text: agent.avatarChar,
        attr: { style: `background: ${agent.avatarBg};` },
      });

      const nameIn = row.createEl('input', {
        cls: 'ilc-settings-input-label',
        attr: { type: 'text', value: agent.name, title: t('显示名称'), placeholder: t('名称') },
      }) as HTMLInputElement;
      nameIn.addEventListener('change', async () => {
        agent.name = nameIn.value.trim() || 'Agent';
        await this.plugin.saveSettings();
      });

      const charIn = row.createEl('input', {
        cls: 'ilc-settings-input-emoji',
        attr: { type: 'text', value: agent.avatarChar, title: t('头像字符（1个字符）'), maxlength: '2' },
      }) as HTMLInputElement;
      charIn.addEventListener('change', async () => {
        agent.avatarChar = charIn.value.trim().charAt(0).toUpperCase() || 'A';
        preview.textContent = agent.avatarChar;
        await this.plugin.saveSettings();
      });

      const colorIn = row.createEl('input', {
        cls: 'ilc-settings-input-color',
        attr: { type: 'color', value: agent.avatarBg, title: t('头像背景色') },
      }) as HTMLInputElement;
      colorIn.addEventListener('change', async () => {
        agent.avatarBg = colorIn.value;
        preview.setCssStyles({ background: agent.avatarBg });
        await this.plugin.saveSettings();
      });

      const sessionIn = row.createEl('input', {
        cls: 'ilc-settings-input-session',
        attr: {
          type: 'text',
          value: agent.sessionId ?? '',
          title: t('会话 ID'),
          placeholder: t('claude session id（填了才能 @它回应）'),
        },
      }) as HTMLInputElement;
      sessionIn.addEventListener('change', async () => {
        const val = sessionIn.value.trim();
        agent.sessionId = val || undefined;
        agent.resumeType = val ? 'claude-resume' : undefined;
        await this.plugin.saveSettings();
      });

      if (agent.sessionId) {
        row.createEl('span', {
          cls: 'ilc-settings-session-tag',
          text: 'claude-resume',
          attr: { title: t('会话类型') },
        });
      }

      const delBtn = row.createEl('button', {
        cls: 'ilc-settings-del-btn',
        text: '×',
        attr: { title: t('删除') },
      });
      delBtn.addEventListener('click', async () => {
        this.plugin.settings.aiAgents.splice(i, 1);
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }
}
