import { MarkdownView, Plugin, PluginSettingTab, App, Setting } from 'obsidian';
import { buildCommentExtension, type ICommentHost } from './src/editor/cmExtension.ts';
import { CommentPanel, VIEW_TYPE_COMMENTS } from './src/views/CommentPanel.ts';
import { AddCommentModal } from './src/modal/AddCommentModal.ts';
import { buildAnnotationMarkup } from './src/parser.ts';

// ─── Settings ─────────────────────────────────────────────────────────────────

interface ILCSettings {
  authorName: string;
}

const DEFAULT_SETTINGS: ILCSettings = {
  authorName: 'user',
};

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class InlineCommentsPlugin extends Plugin implements ICommentHost {
  settings: ILCSettings = DEFAULT_SETTINGS;
  private panel: CommentPanel | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register sidebar view
    this.registerView(
      VIEW_TYPE_COMMENTS,
      (leaf) => {
        this.panel = new CommentPanel(leaf, this);
        return this.panel;
      },
    );

    // Register CodeMirror 6 extension
    this.registerEditorExtension(buildCommentExtension(this));

    // Command: add inline comment
    this.addCommand({
      id: 'add-inline-comment',
      name: '添加划线评论',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'k' }],
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (!sel) {
          return;
        }

        new AddCommentModal(
          this.app,
          sel,
          (entry) => {
            const markup = buildAnnotationMarkup(sel, [entry]);
            editor.replaceSelection(markup);
          },
          this.settings.authorName,
        ).open();
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
  }

  /** Called by CM6 extension when editor cursor enters an annotation */
  onEditorCursorInAnnotation(annotationId: string): void {
    this.panel?.highlightCard(annotationId);
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
  }
}
