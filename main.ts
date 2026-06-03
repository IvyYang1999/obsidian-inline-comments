import { MarkdownView, Plugin, PluginSettingTab, App, Setting } from 'obsidian';
import { buildCommentExtension, type ICommentHost } from './src/editor/cmExtension.ts';
import { CommentPanel, VIEW_TYPE_COMMENTS } from './src/views/CommentPanel.ts';

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

  async onload(): Promise<void> {
    await this.loadSettings();

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

        // Ensure panel is open
        await this.activatePanel();

        // Get the panel instance and show draft card
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
