import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { MarkdownView, Plugin, PluginSettingTab, App, Setting, Notice } from 'obsidian';
import type { TFile } from 'obsidian';
import { buildAgentReplyPrompt, cleanReplyText } from './src/agentReply.ts';
import { buildCommentExtension, type ICommentHost, type AnnotationPosition } from './src/editor/cmExtension.ts';
import { CommentPanel, VIEW_TYPE_COMMENTS } from './src/views/CommentPanel.ts';
import { HistoryModal } from './src/views/HistoryModal.ts';
import { GlobalThreadModal } from './src/modal/GlobalThreadModal.ts';
import { appendReply, parseAnnotations } from './src/parser.ts';
import type { CommentEntry, CommentTypeConfig, AIAgentConfig, DeletedRecord } from './src/types.ts';
import { BUILTIN_TYPE_IDS, typeBgColor } from './src/types.ts';
import { UnreadTracker } from './src/unreadTracker.ts';
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
  { id: 'agree',     emoji: '🟢', label: '认同',   color: '#4CAF50' },
  { id: 'disagree',  emoji: '🔴', label: '不认同', color: '#F44336' },
  { id: 'question',  emoji: '🟡', label: '疑问',   color: '#FF9800' },
  { id: 'important', emoji: '🔵', label: '重要',   color: '#2196F3' },
  { id: 'note',      emoji: '⚪', label: '备注',   color: '#9E9E9E' },
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
}

const DEFAULT_SETTINGS: ILCSettings = {
  authorName:     'user',
  avatarBg:       '#7C4DFF',
  commentTypes:   DEFAULT_COMMENT_TYPES,
  aiAgents:       DEFAULT_AI_AGENTS,
  defaultAIAgent: 'claude',
  globalThreadEngine: 'claude',
  enableUnreadSignal: true,
};

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class InlineCommentsPlugin extends Plugin implements ICommentHost {
  settings: ILCSettings = DEFAULT_SETTINGS;
  private runningGlobalThreads = new Set<string>();
  private runningAgentReplies = new Set<string>();
  unreadTracker!: UnreadTracker;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.injectTypeStyles();

    // Register sidebar view
    this.registerView(VIEW_TYPE_COMMENTS, (leaf) => new CommentPanel(leaf, this));

    // Register CodeMirror 6 extension
    this.registerEditorExtension(buildCommentExtension(this));

    // Command: add inline comment → opens draft card in sidebar
    this.addCommand({
      id: 'add-inline-comment',
      name: '添加划线评论',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'k' }],
      editorCallback: async (editor) => {
        const sel = editor.getSelection();
        if (!sel) return;

        const from = editor.posToOffset(editor.getCursor('from'));

        await this.activatePanel();

        const panel = this.getPanel();
        if (!panel) return;

        panel.showDraftCard(sel, from, (markup: string) => {
          editor.replaceSelection(markup);
        });
      },
    });

    // Command: open/reveal comments panel
    this.addCommand({
      id: 'open-comments-panel',
      name: '打开评论面板',
      callback: async () => {
        await this.activatePanel();
      },
    });

    // Command: open deletion history
    this.addCommand({
      id: 'open-comment-history',
      name: '查看评论删除历史',
      callback: () => {
        new HistoryModal(this.app, this).open();
      },
    });

    // Command: document-level AI conversation block
    this.addCommand({
      id: 'start-or-continue-global-thread',
      name: '开始/继续文档对话',
      callback: () => {
        this.openGlobalThreadModal();
      },
    });

    // Ribbon icon
    this.addRibbonIcon('message-square', '评论面板', async () => {
      await this.activatePanel();
    });

    // Settings tab
    this.addSettingTab(new ILCSettingTab(this.app, this));

    // Unread reply tracker
    this.unreadTracker = new UnreadTracker(
      this.app,
      this.manifest.dir ?? '.obsidian/plugins/obsidian-inline-comments',
      () => this.settings.enableUnreadSignal,
    );
    this.unreadTracker.init();

    this.registerEvent(
      this.app.vault.on('modify', () => {
        this.unreadTracker.scheduleRecompute();
      }),
    );
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_COMMENTS);
    document.getElementById('ilc-type-styles')?.remove();
  }

  /** Called by CM6 extension when editor cursor enters an annotation */
  onEditorCursorInAnnotation(annotationId: string): void {
    this.getPanel()?.highlightCard(annotationId);
  }

  /** Called by CM6 extension when annotation positions change */
  onPositionsUpdated(positions: AnnotationPosition[]): void {
    this.getPanel()?.syncPositions(positions);
  }

  /** Called by CM6 extension when the editor scrolls */
  onEditorScroll(scrollTop: number): void {
    this.getPanel()?.syncEditorScroll(scrollTop);
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
      new Notice('请先打开一篇 Markdown 笔记');
      return;
    }

    new GlobalThreadModal(this.app, async (message) => {
      await this.continueGlobalThread(file, message);
    }).open();
  }

  private async continueGlobalThread(file: TFile, message: string): Promise<void> {
    if (this.runningGlobalThreads.has(file.path)) {
      new Notice('文档对话正在进行中');
      return;
    }

    const absolutePath = this.getAbsoluteFilePath(file);
    if (!absolutePath) {
      new Notice('文档对话需要桌面文件系统路径，当前 vault adapter 不支持');
      return;
    }

    this.runningGlobalThreads.add(file.path);

    const date = todayIsoDate();
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
      if (!expectedBlock) throw new Error('无法创建文档对话块');

      await this.app.vault.modify(file, contentWithUserMessage);
      new Notice(`文档对话：正在请求 ${aiName}...`);

      await this.runGlobalThreadEngine(engine, absolutePath, aiName, date);

      const after = await this.app.vault.adapter.read(file.path);
      const afterBlock = parseGlobalThreadBlock(after);
      this.refreshActiveMarkdownView(file, after, contentWithUserMessage);

      if (!afterBlock) {
        new Notice('文档对话：AI 执行完成，但全局对话块未解析成功，请检查', 10000);
        return;
      }

      const onlyThreadChanged = hasOnlyGlobalThreadBlockChanged(
        contentWithUserMessage,
        after,
      );
      const appendedReply = afterBlock.entries.length > expectedBlock.entries.length;

      if (!onlyThreadChanged) {
        new Notice('文档对话：AI 已返回，但检测到块外内容变化，请检查文档', 10000);
      } else if (!appendedReply) {
        new Notice('文档对话：AI 已返回，但未检测到新增回复', 10000);
      } else {
        new Notice('文档对话：AI 回复已写回');
      }
    } catch (error) {
      const messageText = formatProcessError(error);
      console.error('ILC: global thread engine failed:', messageText);
      new Notice(`文档对话：AI 应答失败：${messageText}`, 10000);
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
    const lockKey = `${file.path}:${annotationFrom}`;
    if (this.runningAgentReplies.has(lockKey)) {
      new Notice('评论回应正在进行中');
      return;
    }

    const registeredAgent = this.getRegisteredAgentSession(agentName);
    if (!registeredAgent) {
      new Notice('未找到已注册会话: ' + agentName);
      return;
    }
    if (registeredAgent.resumeType !== 'claude-resume') {
      new Notice('暂不支持会话类型: ' + registeredAgent.resumeType);
      return;
    }

    const absolutePath = this.getAbsoluteFilePath(file);
    if (!absolutePath) {
      new Notice('评论回应需要桌面文件系统路径，当前 vault adapter 不支持');
      return;
    }

    this.runningAgentReplies.add(lockKey);

    const cwd = getParentDir(absolutePath);
    const date = todayIsoDate();
    let before = '';

    try {
      before = await this.app.vault.read(file);
      const annotation = parseAnnotations(before).find(
        (item) => item.from === annotationFrom,
      );
      if (!annotation) {
        new Notice('评论回应：未找到目标评论块', 10000);
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

      new Notice(`评论回应：正在请求 ${registeredAgent.agent.name}...`);
      const replyOutput = await runHeadlessCommandCapture(
        'claude',
        ['--print', '--resume', registeredAgent.sessionId, '-p', prompt],
        cwd,
      );
      const replyText = cleanReplyText(replyOutput);

      if (!replyText) {
        new Notice('评论回应：Agent 未返回内容', 10000);
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
        new Notice('评论回应：文档已变更，请重试', 10000);
        return;
      }
      const after = appendReply(before, annotationFrom, reply);
      await this.app.vault.modify(file, after);
      this.refreshActiveMarkdownView(file, after, before, '评论回应');
      await this.appendAgentReplyLog(
        cwd,
        registeredAgent.agent.name,
        file,
        annotation.highlightText,
      );
      new Notice('评论回应：AI 回复已写回');
    } catch (error) {
      const messageText = formatProcessError(error);
      console.error('ILC: agent reply failed:', messageText);
      new Notice(`评论回应：AI 应答失败：${messageText}`, 10000);
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
      const logDir = join(
        documentDir,
        '.agent-threads',
        safePathSegment(agentName),
      );
      await fsp.mkdir(logDir, { recursive: true });
      const highlightSummary = buildLogField(highlightText).slice(0, 20);
      const line = [
        localMinuteTimestamp(),
        buildLogField(file.name),
        highlightSummary,
        '已回复',
      ].join(' | ');
      await fsp.appendFile(join(logDir, 'log.md'), `${line}\n`, 'utf8');
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
    contextLabel = '文档对话',
  ): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) return;

    const current = view.editor.getValue();
    if (current === latestContent) return;
    if (current === expectedBeforeAI) {
      view.editor.setValue(latestContent);
      return;
    }

    new Notice(`${contextLabel}：当前编辑器已有新改动，未强制刷新视图`, 8000);
  }

  /** Inject dynamic CSS for custom (non-builtin) type IDs */
  injectTypeStyles(): void {
    let el = document.getElementById('ilc-type-styles');
    if (!el) {
      el = document.createElement('style');
      el.id = 'ilc-type-styles';
      document.head.appendChild(el);
    }

    const custom = this.settings.commentTypes.filter(
      (t) => !BUILTIN_TYPE_IDS.has(t.id),
    );

    el.textContent = custom
      .map((t) => {
        const bg = typeBgColor(t.color);
        const id = CSS.escape(t.id);
        return `.ilc-hl-${id} { background: ${bg}; }\n.ilc-card-${id} { border-left: 3px solid ${t.color}; }`;
      })
      .join('\n');
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
    this.injectTypeStyles();
  }
}

function todayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
    execFile(
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
    execFile(
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
    containerEl.createEl('h2', { text: 'Inline Comments 设置' });

    // ── Author ──
    new Setting(containerEl)
      .setName('默认署名')
      .setDesc('添加评论时使用的作者名')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.authorName)
          .onChange(async (value) => {
            this.plugin.settings.authorName = value.trim() || 'user';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('头像颜色')
      .setDesc('评论头像的背景色')
      .addColorPicker((cp) =>
        cp
          .setValue(this.plugin.settings.avatarBg)
          .onChange(async (value) => {
            this.plugin.settings.avatarBg = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Comment types ──
    containerEl.createEl('h3', { text: '评论类型' });
    containerEl.createEl('p', {
      text: '每个类型对应一个快捷标签。内置类型（agree/disagree 等）颜色由样式表控制；自定义类型会根据颜色自动生成样式。',
      cls: 'setting-item-description',
    });

    const typesEl = containerEl.createEl('div', { cls: 'ilc-settings-list' });
    this.renderTypesList(typesEl);

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText('+ 添加类型').onClick(async () => {
        this.plugin.settings.commentTypes.push({
          id: 'custom',
          emoji: '💬',
          label: '自定义',
          color: '#9C27B0',
        });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    // ── AI agents ──
    containerEl.createEl('h3', { text: 'AI 助手' });
    containerEl.createEl('p', {
      text: '当评论作者名与此处配置的 AI 名称匹配时，会显示对应的头像和颜色。',
      cls: 'setting-item-description',
    });

    const agentsEl = containerEl.createEl('div', { cls: 'ilc-settings-list' });
    this.renderAgentsList(agentsEl);

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText('+ 添加 AI 助手').onClick(async () => {
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
      .setName('默认 AI 助手')
      .setDesc('点击「请 AI 回应」时，默认请求哪个 AI')
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
      .setName('文档对话引擎')
      .setDesc('「开始/继续文档对话」命令调用的 headless 引擎')
      .addDropdown((drop) => {
        drop.addOption('claude', 'Claude CLI');
        drop.addOption('glm', 'GLM 脚本');
        drop.setValue(this.plugin.settings.globalThreadEngine);
        drop.onChange(async (value) => {
          this.plugin.settings.globalThreadEngine =
            value === 'glm' ? 'glm' : 'claude';
          await this.plugin.saveSettings();
        });
        return drop;
      });

    // ── Unread signal ──
    new Setting(containerEl)
      .setName('产出未读信号')
      .setDesc('产出 unread-replies.json 供目录树红点插件使用')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableUnreadSignal)
          .onChange(async (value) => {
            this.plugin.settings.enableUnreadSignal = value;
            await this.plugin.saveSettings();
            if (value) this.plugin.unreadTracker.recompute();
          }),
      );
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
        attr: { type: 'text', value: type.id, title: '类型 ID（写入 Markdown）', placeholder: 'id' },
      }) as HTMLInputElement;
      idIn.addEventListener('change', async () => {
        type.id = idIn.value.trim().replace(/\s+/g, '_') || 'custom';
        await this.plugin.saveSettings();
      });

      const labelIn = row.createEl('input', {
        cls: 'ilc-settings-input-label',
        attr: { type: 'text', value: type.label, title: '显示标签', placeholder: '标签' },
      }) as HTMLInputElement;
      labelIn.addEventListener('change', async () => {
        type.label = labelIn.value.trim() || type.id;
        await this.plugin.saveSettings();
      });

      const colorIn = row.createEl('input', {
        cls: 'ilc-settings-input-color',
        attr: { type: 'color', value: type.color, title: '颜色' },
      }) as HTMLInputElement;
      colorIn.addEventListener('change', async () => {
        type.color = colorIn.value;
        await this.plugin.saveSettings();
      });

      const delBtn = row.createEl('button', {
        cls: 'ilc-settings-del-btn',
        text: '×',
        attr: { title: '删除' },
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
        attr: { type: 'text', value: agent.name, title: '显示名称', placeholder: '名称' },
      }) as HTMLInputElement;
      nameIn.addEventListener('change', async () => {
        agent.name = nameIn.value.trim() || 'Agent';
        await this.plugin.saveSettings();
      });

      const charIn = row.createEl('input', {
        cls: 'ilc-settings-input-emoji',
        attr: { type: 'text', value: agent.avatarChar, title: '头像字符（1个字符）', maxlength: '2' },
      }) as HTMLInputElement;
      charIn.addEventListener('change', async () => {
        agent.avatarChar = charIn.value.trim().charAt(0).toUpperCase() || 'A';
        preview.textContent = agent.avatarChar;
        await this.plugin.saveSettings();
      });

      const colorIn = row.createEl('input', {
        cls: 'ilc-settings-input-color',
        attr: { type: 'color', value: agent.avatarBg, title: '头像背景色' },
      }) as HTMLInputElement;
      colorIn.addEventListener('change', async () => {
        agent.avatarBg = colorIn.value;
        preview.style.background = agent.avatarBg;
        await this.plugin.saveSettings();
      });

      const sessionIn = row.createEl('input', {
        cls: 'ilc-settings-input-session',
        attr: {
          type: 'text',
          value: agent.sessionId ?? '',
          title: '会话 ID',
          placeholder: 'claude session id（填了才能 @它回应）',
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
          attr: { title: '会话类型' },
        });
      }

      const delBtn = row.createEl('button', {
        cls: 'ilc-settings-del-btn',
        text: '×',
        attr: { title: '删除' },
      });
      delBtn.addEventListener('click', async () => {
        this.plugin.settings.aiAgents.splice(i, 1);
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }
}
