import { MarkdownView, Plugin, PluginSettingTab, App, Setting, Notice } from 'obsidian';
import { buildCommentExtension, type ICommentHost } from './src/editor/cmExtension.ts';
import { CommentPanel, VIEW_TYPE_COMMENTS } from './src/views/CommentPanel.ts';
import type { CommentTypeConfig, AIAgentConfig } from './src/types.ts';
import { BUILTIN_TYPE_IDS, typeBgColor } from './src/types.ts';

// ─── Default type chips ────────────────────────────────────────────────────────

export const DEFAULT_COMMENT_TYPES: CommentTypeConfig[] = [
  { id: 'agree',     emoji: '🟢', label: '认同',   color: '#4CAF50' },
  { id: 'disagree',  emoji: '🔴', label: '不认同', color: '#F44336' },
  { id: 'question',  emoji: '🟡', label: '疑问',   color: '#FF9800' },
  { id: 'important', emoji: '🔵', label: '重要',   color: '#2196F3' },
  { id: 'note',      emoji: '⚪', label: '备注',   color: '#9E9E9E' },
];

export const DEFAULT_AI_AGENTS: AIAgentConfig[] = [
  { id: 'claude', name: 'Claude', avatarChar: 'C', avatarBg: '#7B61FF' },
  { id: 'codex',  name: 'Codex',  avatarChar: 'X', avatarBg: '#10A37F' },
  { id: 'gemini', name: 'Gemini', avatarChar: 'G', avatarBg: '#4285F4' },
];

// ─── Settings ─────────────────────────────────────────────────────────────────

interface ILCSettings {
  authorName:     string;
  commentTypes:   CommentTypeConfig[];
  aiAgents:       AIAgentConfig[];
  defaultAIAgent: string; // id of the default AI agent to request
}

const DEFAULT_SETTINGS: ILCSettings = {
  authorName:     'user',
  commentTypes:   DEFAULT_COMMENT_TYPES,
  aiAgents:       DEFAULT_AI_AGENTS,
  defaultAIAgent: 'claude',
};

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class InlineCommentsPlugin extends Plugin implements ICommentHost {
  settings: ILCSettings = DEFAULT_SETTINGS;

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

        await this.activatePanel();

        const panel = this.getPanel();
        if (!panel) return;

        panel.showDraftCard(sel, (markup: string) => {
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

    // Ribbon icon
    this.addRibbonIcon('message-square', '评论面板', async () => {
      await this.activatePanel();
    });

    // Settings tab
    this.addSettingTab(new ILCSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_COMMENTS);
    document.getElementById('ilc-type-styles')?.remove();
  }

  /** Called by CM6 extension when editor cursor enters an annotation */
  onEditorCursorInAnnotation(annotationId: string): void {
    this.getPanel()?.highlightCard(annotationId);
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

  /** Name of the default AI agent to request responses from */
  getDefaultAIAgentName(): string {
    const agent = this.settings.aiAgents.find(
      (a) => a.id === this.settings.defaultAIAgent,
    );
    return agent?.name ?? 'Claude';
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
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.injectTypeStyles();
  }
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
    const agentNames = this.plugin.settings.aiAgents.map((a) => a.id);
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
