import { t } from '../i18n.ts';
import { App, Modal, Setting } from 'obsidian';
import type { CommentEntry, CommentType } from '../types.ts';
import { COMMENT_TYPE_META } from '../types.ts';

type OnSubmit = (entry: CommentEntry) => void;

export class AddCommentModal extends Modal {
  private selectedType: CommentType = 'note';
  private commentText = '';
  private authorName: string;

  constructor(
    app: App,
    private highlightText: string,
    private onSubmit: OnSubmit,
    defaultAuthor = 'user',
  ) {
    super(app);
    this.authorName = defaultAuthor;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ilc-add-modal');

    // Title
    contentEl.createEl('h3', { text: t('添加评论') });

    // Preview of selected text
    const preview = contentEl.createEl('div', { cls: 'ilc-modal-preview' });
    preview.createEl('span', { cls: 'ilc-modal-preview-label', text: t('选中文字：') });
    preview.createEl('span', {
      cls: 'ilc-modal-preview-text',
      text: `"${this.highlightText.slice(0, 80)}${this.highlightText.length > 80 ? '…' : ''}"`,
    });

    // Type selector
    contentEl.createEl('p', { cls: 'ilc-modal-section-label', text: t('类型') });
    const typeRow = contentEl.createEl('div', { cls: 'ilc-type-row' });

    const types: CommentType[] = ['agree', 'disagree', 'question', 'important', 'note'];
    let activeBtn: HTMLButtonElement | null = null;

    const selectType = (type: CommentType, btn: HTMLButtonElement) => {
      activeBtn?.removeClass('ilc-type-btn-active');
      this.selectedType = type;
      btn.addClass('ilc-type-btn-active');
      activeBtn = btn;
    };

    for (const type of types) {
      const meta = COMMENT_TYPE_META[type];
      const btn = typeRow.createEl('button', {
        cls: `ilc-type-btn ilc-type-btn-${type}`,
        text: `${meta.emoji} ${t(meta.label)}`,
      });
      btn.addEventListener('click', () => selectType(type, btn));
      if (type === this.selectedType) {
        btn.addClass('ilc-type-btn-active');
        activeBtn = btn;
      }
    }

    // Comment text area
    new Setting(contentEl)
      .setName(t('评论内容'))
      .addTextArea((ta) => {
        ta.setPlaceholder(t('写下你的想法…'));
        ta.onChange((v) => { this.commentText = v; });
        // Focus and allow Enter to submit via Ctrl/Cmd+Enter
        window.setTimeout(() => ta.inputEl.focus(), 50);
        ta.inputEl.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            this.doSubmit();
          }
        });
      });

    // Author
    new Setting(contentEl)
      .setName(t('署名'))
      .addText((t) => {
        t.setValue(this.authorName);
        t.onChange((v) => { this.authorName = v; });
      });

    // Submit button
    const footer = contentEl.createEl('div', { cls: 'ilc-modal-footer' });
    const submitBtn = footer.createEl('button', {
      cls: 'mod-cta',
      text: t('确认'),
    });
    submitBtn.addEventListener('click', () => this.doSubmit());

    const cancelBtn = footer.createEl('button', { text: t('取消') });
    cancelBtn.addEventListener('click', () => this.close());
  }

  private doSubmit(): void {
    if (!this.commentText.trim()) return;
    const today = new Date().toISOString().split('T')[0];
    this.onSubmit({
      author: this.authorName.trim() || 'user',
      date: today,
      type: this.selectedType,
      text: this.commentText.trim(),
    });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
