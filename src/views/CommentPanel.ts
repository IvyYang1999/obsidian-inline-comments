import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type { Annotation, CommentEntry, CommentType } from '../types.ts';
import { COMMENT_TYPE_META } from '../types.ts';
import { parseAnnotations, appendReply, buildAnnotationMarkup } from '../parser.ts';
import type InlineCommentsPlugin from '../../main.ts';

export const VIEW_TYPE_COMMENTS = 'ilc-comments-panel';

interface DraftState {
  highlightText: string;
  selectedType: CommentType;
  onPost: (markup: string) => void;
}

export class CommentPanel extends ItemView {
  private annotations: Annotation[] = [];
  private activeAnnotationId: string | null = null;
  private cardEls: Map<string, HTMLElement> = new Map();

  // Two separate zones so refresh() never touches the draft area
  private draftZone!: HTMLElement;
  private cardsZone!: HTMLElement;

  private draft: DraftState | null = null;
  private draftInputEl: HTMLTextAreaElement | null = null;
  private clickAwayHandler: ((e: MouseEvent) => void) | null = null;

  // Track which file we're showing so we cancel draft on file change
  private currentFilePath: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: InlineCommentsPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_COMMENTS; }
  getDisplayText(): string { return '评论'; }
  getIcon(): string { return 'message-square'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.addClass('ilc-panel');

    // Two fixed zones — draft zone comes first and is never cleared by refresh()
    this.draftZone = container.createEl('div', { cls: 'ilc-draft-zone' });
    this.cardsZone = container.createEl('div', { cls: 'ilc-cards-zone' });

    await this.refresh();

    // active-leaf-change: refresh cards but do NOT cancel draft
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
    this.cancelDraft();
    this.containerEl.children[1].empty();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  showDraftCard(highlightText: string, onPost: (markup: string) => void): void {
    this.cancelDraft();

    this.draft = { highlightText, selectedType: 'note', onPost };

    // Render into draftZone (separate from cardsZone, never cleared by refresh)
    this.renderDraftCardEl();

    setTimeout(() => this.draftInputEl?.focus(), 60);

    // Click-away: dismiss only when input is empty
    this.clickAwayHandler = (e: MouseEvent) => {
      if (this.draftZone.contains(e.target as Node)) return;
      if (!this.draftInputEl?.value.trim()) {
        this.cancelDraft();
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', this.clickAwayHandler!);
    }, 150);
  }

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

  // ── Refresh: only touches cardsZone ─────────────────────────────────────────

  async refresh(): Promise<void> {
    // Guard: zones might not exist yet if called before onOpen completes
    if (!this.cardsZone) return;

    this.cardsZone.empty();
    this.cardEls.clear();

    const file = this.app.workspace.getActiveFile();
    const newPath = file?.path ?? null;

    // File changed → cancel pending draft
    if (newPath !== this.currentFilePath) {
      this.cancelDraft();
      this.currentFilePath = newPath;
    }

    if (!file || file.extension !== 'md') {
      this.cardsZone.createEl('div', {
        cls: 'ilc-empty',
        text: '请打开一篇 Markdown 笔记',
      });
      return;
    }

    const content = await this.app.vault.read(file);
    this.annotations = parseAnnotations(content);

    if (this.annotations.length === 0 && !this.draft) {
      this.cardsZone.createEl('div', {
        cls: 'ilc-empty',
        text: '暂无评论。选中文字后按 ⌘⇧K 添加。',
      });
      return;
    }

    for (const ann of this.annotations) {
      const card = this.renderCard(this.cardsZone, ann, file);
      this.cardEls.set(ann.id, card);
    }
  }

  // ── Draft card ───────────────────────────────────────────────────────────────

  private renderDraftCardEl(): void {
    this.draftZone.empty();
    const d = this.draft!;
    const types: CommentType[] = ['agree', 'disagree', 'question', 'important', 'note'];

    const card = this.draftZone.createEl('div', {
      cls: `ilc-card ilc-card-draft ilc-card-${d.selectedType}`,
    });

    // Preview
    const previewBar = card.createEl('div', { cls: 'ilc-draft-preview' });
    previewBar.createEl('span', {
      cls: 'ilc-draft-preview-text',
      text: d.highlightText.slice(0, 50) + (d.highlightText.length > 50 ? '…' : ''),
    });

    // Type chips
    const typeRow = card.createEl('div', { cls: 'ilc-draft-type-row' });
    let activeBtn: HTMLElement | null = null;

    for (const type of types) {
      const meta = COMMENT_TYPE_META[type];
      const btn = typeRow.createEl('button', {
        cls: `ilc-draft-type-btn ilc-draft-type-${type}`,
        attr: { title: meta.label },
      });
      btn.createEl('span', { text: meta.emoji });
      btn.createEl('span', { cls: 'ilc-draft-type-label', text: meta.label });

      if (type === d.selectedType) {
        btn.addClass('ilc-draft-type-active');
        activeBtn = btn;
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeBtn?.removeClass('ilc-draft-type-active');
        types.forEach((t) => card.removeClass(`ilc-card-${t}`));
        d.selectedType = type;
        card.addClass(`ilc-card-${type}`);
        btn.addClass('ilc-draft-type-active');
        activeBtn = btn;
      });
    }

    // Author
    const authorRow = card.createEl('div', { cls: 'ilc-draft-author-row' });
    const avatar = authorRow.createEl('div', { cls: 'ilc-draft-avatar' });
    avatar.textContent = this.plugin.settings.authorName.charAt(0).toUpperCase();
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

    // Actions (hidden until input has content)
    const actionRow = card.createEl('div', { cls: 'ilc-draft-actions ilc-hidden' });
    const cancelBtn = actionRow.createEl('button', { cls: 'ilc-draft-cancel', text: 'Cancel' });
    const postBtn = actionRow.createEl('button', { cls: 'ilc-draft-post mod-cta', text: 'Post' });

    input.addEventListener('input', () => {
      input.value.trim()
        ? actionRow.removeClass('ilc-hidden')
        : actionRow.addClass('ilc-hidden');
    });

    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.submitDraft(input.value);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelDraft();
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
    this.draftZone?.empty();
    this.draftInputEl = null;
    this.draft = null;
  }

  // ── Annotation cards ─────────────────────────────────────────────────────────

  private renderCard(container: HTMLElement, ann: Annotation, file: TFile): HTMLElement {
    const card = container.createEl('div', { cls: 'ilc-card' });
    card.dataset.annotationId = ann.id;
    const firstType = ann.comments[0]?.type ?? 'note';
    card.addClass(`ilc-card-${firstType}`);

    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.ilc-reply-input-row')) return;
      this.jumpToAnnotation(ann);
    });

    // Preview
    const preview = card.createEl('div', { cls: 'ilc-card-preview' });
    preview.createEl('span', {
      cls: 'ilc-card-preview-text',
      text: ann.highlightText.slice(0, 60) + (ann.highlightText.length > 60 ? '…' : ''),
    });

    // Thread
    const thread = card.createEl('div', { cls: 'ilc-thread' });
    for (const comment of ann.comments) {
      this.renderCommentEntry(thread, comment);
    }

    // Reply
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
