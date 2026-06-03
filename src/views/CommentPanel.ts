import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type { Annotation, CommentEntry, CommentType } from '../types.ts';
import { COMMENT_TYPE_META } from '../types.ts';
import { parseAnnotations, appendReply, buildAnnotationMarkup } from '../parser.ts';
import type InlineCommentsPlugin from '../../main.ts';

export const VIEW_TYPE_COMMENTS = 'ilc-comments-panel';

// ─── Draft state ──────────────────────────────────────────────────────────────

interface DraftState {
  highlightText: string;
  selectedType: CommentType;
  onPost: (markup: string) => void;
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export class CommentPanel extends ItemView {
  private annotations: Annotation[] = [];
  private activeAnnotationId: string | null = null;
  private cardEls: Map<string, HTMLElement> = new Map();

  private draft: DraftState | null = null;
  private draftCardEl: HTMLElement | null = null;
  private draftInputEl: HTMLTextAreaElement | null = null;
  private clickAwayHandler: ((e: MouseEvent) => void) | null = null;

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
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.cancelDraft();
        this.refresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        const active = this.app.workspace.getActiveFile();
        if (active && file.path === active.path) this.refresh();
      }),
    );
  }

  async onClose(): Promise<void> {
    this.cancelDraft();
    this.containerEl.children[1].empty();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Show a draft card at the top of the panel (called from command) */
  showDraftCard(highlightText: string, onPost: (markup: string) => void): void {
    this.cancelDraft(); // dismiss any existing draft

    this.draft = {
      highlightText,
      selectedType: 'note',
      onPost,
    };

    const container = this.containerEl.children[1] as HTMLElement;
    this.draftCardEl = this.renderDraftCardEl(container);
    // Insert before all other cards
    container.insertBefore(this.draftCardEl, container.firstChild);

    // Focus the input
    setTimeout(() => this.draftInputEl?.focus(), 50);

    // Click-away: dismiss draft when clicking outside (only if input is empty)
    this.clickAwayHandler = (e: MouseEvent) => {
      if (!this.draftCardEl) return;
      if (this.draftCardEl.contains(e.target as Node)) return;
      if (!this.draftInputEl?.value.trim()) {
        this.cancelDraft();
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', this.clickAwayHandler!);
    }, 100);
  }

  /** Called by CM6 extension when editor cursor is inside an annotation */
  highlightCard(annotationId: string): void {
    if (this.activeAnnotationId === annotationId) return;
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

  // ── Refresh (saved annotations) ─────────────────────────────────────────────

  async refresh(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;

    // Preserve the draft card element before emptying
    const savedDraftEl = this.draftCardEl;
    container.empty();
    container.addClass('ilc-panel');
    this.cardEls.clear();

    // Re-attach draft card if one exists
    if (savedDraftEl && this.draft) {
      container.appendChild(savedDraftEl);
    }

    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      if (!savedDraftEl) {
        container.createEl('div', { cls: 'ilc-empty', text: '请打开一篇 Markdown 笔记' });
      }
      return;
    }

    const content = await this.app.vault.read(file);
    this.annotations = parseAnnotations(content);

    if (this.annotations.length === 0 && !this.draft) {
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

  // ── Draft card rendering ─────────────────────────────────────────────────────

  private renderDraftCardEl(container: HTMLElement): HTMLElement {
    const card = container.createEl('div', { cls: 'ilc-card ilc-card-draft' });

    // Preview bar (top): colored accent will come from CSS + type class
    const previewBar = card.createEl('div', { cls: 'ilc-draft-preview' });
    const previewText = previewBar.createEl('span', {
      cls: 'ilc-draft-preview-text',
      text: this.draft!.highlightText.slice(0, 50) +
        (this.draft!.highlightText.length > 50 ? '…' : ''),
    });
    void previewText;

    // Type selector row
    const typeRow = card.createEl('div', { cls: 'ilc-draft-type-row' });
    const types: CommentType[] = ['agree', 'disagree', 'question', 'important', 'note'];
    let activeBtnEl: HTMLElement | null = null;

    for (const type of types) {
      const meta = COMMENT_TYPE_META[type];
      const btn = typeRow.createEl('button', {
        cls: `ilc-draft-type-btn ilc-draft-type-${type}`,
        attr: { title: meta.label },
      });
      btn.createEl('span', { text: meta.emoji });
      btn.createEl('span', { cls: 'ilc-draft-type-label', text: meta.label });

      if (type === this.draft!.selectedType) {
        btn.addClass('ilc-draft-type-active');
        card.addClass(`ilc-card-${type}`);
        activeBtnEl = btn;
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeBtnEl?.removeClass('ilc-draft-type-active');
        // Remove old color class from card
        types.forEach((t) => card.removeClass(`ilc-card-${t}`));
        this.draft!.selectedType = type;
        btn.addClass('ilc-draft-type-active');
        card.addClass(`ilc-card-${type}`);
        activeBtnEl = btn;
      });
    }

    // Author row
    const authorRow = card.createEl('div', { cls: 'ilc-draft-author-row' });
    const avatarEl = authorRow.createEl('div', { cls: 'ilc-draft-avatar' });
    avatarEl.textContent = this.plugin.settings.authorName.charAt(0).toUpperCase();
    authorRow.createEl('span', {
      cls: 'ilc-draft-author-name',
      text: this.plugin.settings.authorName,
    });

    // Input
    const inputWrapper = card.createEl('div', { cls: 'ilc-draft-input-wrapper' });
    const input = inputWrapper.createEl('textarea', {
      cls: 'ilc-draft-input',
      attr: { placeholder: '添加评论…', rows: '2' },
    });
    this.draftInputEl = input;

    // Action row (hidden until input has content)
    const actionRow = card.createEl('div', { cls: 'ilc-draft-actions ilc-hidden' });
    const cancelBtn = actionRow.createEl('button', {
      cls: 'ilc-draft-cancel',
      text: 'Cancel',
    });
    const postBtn = actionRow.createEl('button', {
      cls: 'ilc-draft-post mod-cta',
      text: 'Post',
    });

    // Show/hide actions based on input content
    input.addEventListener('input', () => {
      if (input.value.trim()) {
        actionRow.removeClass('ilc-hidden');
      } else {
        actionRow.addClass('ilc-hidden');
      }
    });

    // Ctrl/Cmd+Enter to submit
    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.submitDraft(input.value);
      }
    });

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cancelDraft();
    });

    postBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.submitDraft(input.value);
    });

    return card;
  }

  private submitDraft(inputValue: string): void {
    if (!this.draft) return;
    const text = inputValue.trim();
    if (!text) return;

    const today = new Date().toISOString().split('T')[0];
    const entry: CommentEntry = {
      author: this.plugin.settings.authorName,
      date: today,
      type: this.draft.selectedType,
      text,
    };
    const markup = buildAnnotationMarkup(this.draft.highlightText, [entry]);
    this.draft.onPost(markup);
    this.cancelDraft();
  }

  private cancelDraft(): void {
    if (this.clickAwayHandler) {
      document.removeEventListener('mousedown', this.clickAwayHandler);
      this.clickAwayHandler = null;
    }
    if (this.draftCardEl) {
      this.draftCardEl.remove();
      this.draftCardEl = null;
    }
    this.draftInputEl = null;
    this.draft = null;
  }

  // ── Saved annotation card rendering ─────────────────────────────────────────

  private renderCard(container: HTMLElement, ann: Annotation, file: TFile): HTMLElement {
    const card = container.createEl('div', { cls: 'ilc-card' });
    card.dataset.annotationId = ann.id;

    const firstType = ann.comments[0]?.type ?? 'note';
    card.addClass(`ilc-card-${firstType}`);

    // Click card header area → jump to editor
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.ilc-reply-input-row')) return;
      this.jumpToAnnotation(ann);
    });

    // Preview
    const preview = card.createEl('div', { cls: 'ilc-card-preview' });
    preview.createEl('span', {
      cls: 'ilc-card-preview-text',
      text: ann.highlightText.slice(0, 60) +
        (ann.highlightText.length > 60 ? '…' : ''),
    });

    // Thread
    const thread = card.createEl('div', { cls: 'ilc-thread' });
    for (const comment of ann.comments) {
      this.renderCommentEntry(thread, comment);
    }

    // Reply controls
    const replyRow = card.createEl('div', { cls: 'ilc-reply-row' });
    const replyBtn = replyRow.createEl('button', { cls: 'ilc-reply-btn', text: '+ 回复' });

    const inputRow = card.createEl('div', { cls: 'ilc-reply-input-row ilc-hidden' });
    const input = inputRow.createEl('textarea', {
      cls: 'ilc-reply-input',
      attr: { placeholder: '写下回复…', rows: '2' },
    });
    const submitBtn = inputRow.createEl('button', { cls: 'ilc-reply-submit mod-cta', text: '发送' });
    const cancelBtn = inputRow.createEl('button', { cls: 'ilc-reply-cancel', text: '取消' });

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
    });

    return card;
  }

  private renderCommentEntry(container: HTMLElement, comment: CommentEntry): void {
    const meta = COMMENT_TYPE_META[comment.type] ?? COMMENT_TYPE_META.note;
    const entry = container.createEl('div', { cls: `ilc-entry ilc-entry-${comment.type}` });
    const header = entry.createEl('div', { cls: 'ilc-entry-header' });
    header.createEl('span', { cls: 'ilc-entry-emoji', text: meta.emoji });
    header.createEl('span', { cls: 'ilc-entry-author', text: comment.author });
    header.createEl('span', { cls: 'ilc-entry-date', text: comment.date });
    entry.createEl('div', { cls: 'ilc-entry-body', text: comment.text });
  }

  private jumpToAnnotation(ann: Annotation): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    const pos = editor.offsetToPos(ann.from + 3);
    editor.setCursor(pos);
    editor.scrollIntoView({ from: pos, to: pos }, true);
    const card = this.cardEls.get(ann.id);
    if (card) {
      card.addClass('ilc-card-flash');
      setTimeout(() => card.removeClass('ilc-card-flash'), 600);
    }
  }
}
