import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type { Annotation, CommentEntry, CommentType } from '../types.ts';
import { COMMENT_TYPE_META } from '../types.ts';
import { parseAnnotations, appendReply } from '../parser.ts';
import type InlineCommentsPlugin from '../../main.ts';

export const VIEW_TYPE_COMMENTS = 'ilc-comments-panel';

export class CommentPanel extends ItemView {
  private annotations: Annotation[] = [];
  private activeAnnotationId: string | null = null;
  private cardEls: Map<string, HTMLElement> = new Map();

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: InlineCommentsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_COMMENTS; }
  getDisplayText(): string { return '评论'; }
  getIcon(): string { return 'message-square'; }

  async onOpen(): Promise<void> {
    await this.refresh();

    // Re-render when active file changes or is modified
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.refresh()),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        const active = this.app.workspace.getActiveFile();
        if (active && file.path === active.path) this.refresh();
      }),
    );
  }

  async onClose(): Promise<void> {
    this.containerEl.children[1].empty();
  }

  /** Called by CM6 extension when editor cursor is inside an annotation */
  highlightCard(annotationId: string): void {
    if (this.activeAnnotationId === annotationId) return;

    // Remove previous active
    if (this.activeAnnotationId) {
      this.cardEls.get(this.activeAnnotationId)?.removeClass('ilc-card-active');
    }

    this.activeAnnotationId = annotationId;
    const el = this.cardEls.get(annotationId);
    if (el) {
      el.addClass('ilc-card-active');
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async refresh(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('ilc-panel');
    this.cardEls.clear();

    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      container.createEl('div', {
        cls: 'ilc-empty',
        text: '请打开一篇 Markdown 笔记',
      });
      return;
    }

    const content = await this.app.vault.read(file);
    this.annotations = parseAnnotations(content);

    if (this.annotations.length === 0) {
      container.createEl('div', {
        cls: 'ilc-empty',
        text: '暂无评论。选中文字后按 ⌘⇧K 添加。',
      });
      return;
    }

    for (const ann of this.annotations) {
      const card = this.renderCard(container, ann, file);
      this.cardEls.set(ann.id, card);
    }
  }

  private renderCard(
    container: HTMLElement,
    ann: Annotation,
    file: TFile,
  ): HTMLElement {
    const card = container.createEl('div', { cls: 'ilc-card' });
    card.dataset.annotationId = ann.id;

    // Click card → jump editor to annotation position
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.ilc-reply-input-row')) return;
      this.jumpToAnnotation(ann);
    });

    // ── Highlight preview ────────────────────────────────────────────────────
    const firstType = ann.comments[0]?.type ?? 'note';
    card.addClass(`ilc-card-${firstType}`);

    const preview = card.createEl('div', { cls: 'ilc-card-preview' });
    preview.createEl('span', {
      cls: 'ilc-card-preview-text',
      text: `"${ann.highlightText.slice(0, 60)}${ann.highlightText.length > 60 ? '…' : ''}"`,
    });

    // ── Comment thread ───────────────────────────────────────────────────────
    const thread = card.createEl('div', { cls: 'ilc-thread' });

    for (const comment of ann.comments) {
      this.renderCommentEntry(thread, comment);
    }

    // ── Reply button ─────────────────────────────────────────────────────────
    const replyRow = card.createEl('div', { cls: 'ilc-reply-row' });
    const replyBtn = replyRow.createEl('button', {
      cls: 'ilc-reply-btn',
      text: '+ 回复',
    });

    const inputRow = card.createEl('div', { cls: 'ilc-reply-input-row ilc-hidden' });
    const input = inputRow.createEl('textarea', {
      cls: 'ilc-reply-input',
      attr: { placeholder: '写下回复…', rows: '2' },
    });
    const submitBtn = inputRow.createEl('button', {
      cls: 'ilc-reply-submit mod-cta',
      text: '发送',
    });
    const cancelBtn = inputRow.createEl('button', {
      cls: 'ilc-reply-cancel',
      text: '取消',
    });

    replyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      replyRow.addClass('ilc-hidden');
      inputRow.removeClass('ilc-hidden');
      input.focus();
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      inputRow.addClass('ilc-hidden');
      replyRow.removeClass('ilc-hidden');
      input.value = '';
    });

    submitBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = input.value.trim();
      if (!text) return;

      const today = new Date().toISOString().split('T')[0];
      const reply: CommentEntry = {
        author: this.plugin.settings.authorName,
        date: today,
        type: 'reply',
        text,
      };

      const currentContent = await this.app.vault.read(file);
      const newContent = appendReply(currentContent, ann.from, reply);
      await this.app.vault.modify(file, newContent);
      // refresh is triggered by vault.modify event
    });

    return card;
  }

  private renderCommentEntry(container: HTMLElement, comment: CommentEntry): void {
    const meta = COMMENT_TYPE_META[comment.type] ?? COMMENT_TYPE_META.note;
    const entry = container.createEl('div', { cls: `ilc-entry ilc-entry-${comment.type}` });

    // Header: emoji + author + date
    const header = entry.createEl('div', { cls: 'ilc-entry-header' });
    header.createEl('span', { cls: 'ilc-entry-emoji', text: meta.emoji });
    header.createEl('span', { cls: 'ilc-entry-author', text: comment.author });
    header.createEl('span', { cls: 'ilc-entry-date', text: comment.date });

    // Body
    entry.createEl('div', { cls: 'ilc-entry-body', text: comment.text });
  }

  private jumpToAnnotation(ann: Annotation): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const editor = view.editor;
    const pos = editor.offsetToPos(ann.from + 3); // +3 to skip {==, land on text
    editor.setCursor(pos);
    editor.scrollIntoView({ from: pos, to: pos }, true);

    // Flash the card
    const card = this.cardEls.get(ann.id);
    if (card) {
      card.addClass('ilc-card-flash');
      setTimeout(() => card.removeClass('ilc-card-flash'), 600);
    }
  }
}
