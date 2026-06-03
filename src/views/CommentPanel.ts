import { ItemView, MarkdownView, Menu, TFile, WorkspaceLeaf } from 'obsidian';
import type { Annotation, CommentEntry } from '../types.ts';
import { COMMENT_TYPE_META } from '../types.ts';
import {
  parseAnnotations,
  appendReply,
  buildAnnotationMarkup,
  deleteAnnotation,
  deleteCommentEntry,
} from '../parser.ts';
import { HistoryModal } from './HistoryModal.ts';
import type InlineCommentsPlugin from '../../main.ts';

export const VIEW_TYPE_COMMENTS = 'ilc-comments-panel';

interface DraftState {
  highlightText:  string;
  selectedType:   string;
  typeChanged:    boolean;
  wantsAIReply:   boolean;
  onPost:         (markup: string) => void;
}

export class CommentPanel extends ItemView {
  private annotations: Annotation[] = [];
  private activeAnnotationId: string | null = null;
  private cardEls: Map<string, HTMLElement> = new Map();

  private draftZone!: HTMLElement;
  private cardsZone!: HTMLElement;

  private draft: DraftState | null = null;
  private draftInputEl: HTMLTextAreaElement | null = null;
  private clickAwayHandler: ((e: MouseEvent) => void) | null = null;

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

    this.draftZone = container.createEl('div', { cls: 'ilc-draft-zone' });
    this.cardsZone = container.createEl('div', { cls: 'ilc-cards-zone' });

    await this.refresh();

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

    const defaultType = this.plugin.settings.commentTypes[0]?.id ?? 'note';
    this.draft = {
      highlightText,
      selectedType: defaultType,
      typeChanged: false,
      wantsAIReply: false,
      onPost,
    };

    this.renderDraftCardEl();
    setTimeout(() => this.draftInputEl?.focus(), 60);

    this.clickAwayHandler = (e: MouseEvent) => {
      if (this.draftZone.contains(e.target as Node)) return;
      if (!this.draftInputEl?.value.trim() && !this.draft?.typeChanged) {
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

  // ── Refresh ──────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (!this.cardsZone) return;

    this.cardsZone.empty();
    this.cardEls.clear();

    const file = this.app.workspace.getActiveFile();
    const newPath = file?.path ?? null;

    if (newPath !== this.currentFilePath) {
      this.cancelDraft();
      this.currentFilePath = newPath;
    }

    if (!file || file.extension !== 'md') {
      this.cardsZone.createEl('div', {
        cls: 'ilc-empty',
        text: '请打开一篇 Markdown 笔记',
      });
      this.renderPanelFooter();
      return;
    }

    const content = await this.app.vault.read(file);
    this.annotations = parseAnnotations(content);

    if (this.annotations.length === 0 && !this.draft) {
      this.cardsZone.createEl('div', {
        cls: 'ilc-empty',
        text: '暂无评论。选中文字后按 ⌘⇧K 添加。',
      });
    }

    for (const ann of this.annotations) {
      const card = this.renderCard(this.cardsZone, ann, file);
      this.cardEls.set(ann.id, card);
    }

    this.renderPanelFooter();
  }

  private renderPanelFooter(): void {
    const footer = this.cardsZone.createEl('div', { cls: 'ilc-panel-footer' });
    const histBtn = footer.createEl('button', {
      cls: 'ilc-history-link',
      text: '🕐 删除历史',
    });
    histBtn.addEventListener('click', () => {
      new HistoryModal(this.app, this.plugin).open();
    });
  }

  // ── Draft card ────────────────────────────────────────────────────────────────

  private renderDraftCardEl(): void {
    this.draftZone.empty();
    const d = this.draft!;
    const types = this.plugin.settings.commentTypes;

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

    const updateActions = () => {
      const hasContent = (this.draftInputEl?.value.trim() ?? '') !== '';
      d.typeChanged || hasContent
        ? actionRow.removeClass('ilc-hidden')
        : actionRow.addClass('ilc-hidden');
    };

    for (const type of types) {
      const btn = typeRow.createEl('button', {
        cls: `ilc-draft-type-btn ilc-draft-type-${type.id}`,
        attr: { title: type.label },
      });
      btn.createEl('span', { cls: 'ilc-draft-type-emoji', text: type.emoji });
      btn.createEl('span', { cls: 'ilc-draft-type-label', text: type.label });

      if (type.id === d.selectedType) {
        btn.addClass('ilc-draft-type-active');
        activeBtn = btn;
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeBtn?.removeClass('ilc-draft-type-active');
        types.forEach((t) => card.removeClass(`ilc-card-${t.id}`));
        d.selectedType = type.id;
        d.typeChanged = true;
        card.addClass(`ilc-card-${type.id}`);
        btn.addClass('ilc-draft-type-active');
        activeBtn = btn;
        typeBadge.textContent = type.emoji + ' ' + type.label;
        updateActions();
      });
    }

    // Author row
    const authorRow = card.createEl('div', { cls: 'ilc-draft-author-row' });
    const avatar = authorRow.createEl('div', { cls: 'ilc-draft-avatar' });
    avatar.textContent = this.plugin.settings.authorName.charAt(0).toUpperCase();
    authorRow.createEl('span', {
      cls: 'ilc-draft-author-name',
      text: this.plugin.settings.authorName,
    });
    const selectedMeta = types.find((t) => t.id === d.selectedType);
    const typeBadge = authorRow.createEl('span', {
      cls: 'ilc-draft-type-badge',
      text: selectedMeta ? selectedMeta.emoji + ' ' + selectedMeta.label : d.selectedType,
    });

    // Input
    const inputWrapper = card.createEl('div', { cls: 'ilc-draft-input-wrapper' });
    const input = inputWrapper.createEl('textarea', {
      cls: 'ilc-draft-input',
      attr: { placeholder: '添加评论（可选）…', rows: '2' },
    });
    this.draftInputEl = input;

    // Actions
    const actionRow = card.createEl('div', { cls: 'ilc-draft-actions ilc-hidden' });

    // AI reply toggle
    if (this.plugin.settings.aiAgents.length > 0) {
      const toggleRow = card.createEl('div', { cls: 'ilc-draft-ai-toggle' });
      const checkbox = toggleRow.createEl('input', {
        attr: { type: 'checkbox', id: 'ilc-ai-toggle' },
      }) as HTMLInputElement;
      toggleRow.createEl('label', {
        attr: { for: 'ilc-ai-toggle' },
        text: `请 ${this.plugin.getDefaultAIAgentName()} 回应`,
      });
      checkbox.addEventListener('change', () => { d.wantsAIReply = checkbox.checked; });
    }

    const cancelBtn = actionRow.createEl('button', { cls: 'ilc-draft-cancel', text: 'Cancel' });
    const postBtn   = actionRow.createEl('button', { cls: 'ilc-draft-post mod-cta', text: 'Post' });

    input.addEventListener('input', () => { updateActions(); });
    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.submitDraft(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); this.cancelDraft(); }
    });
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); this.cancelDraft(); });
    postBtn.addEventListener('click', (e) => { e.stopPropagation(); this.submitDraft(input.value); });
  }

  private submitDraft(inputValue: string): void {
    if (!this.draft) return;
    if (!this.draft.typeChanged && !inputValue.trim()) return;

    const today = new Date().toISOString().split('T')[0];
    const entries: CommentEntry[] = [
      {
        author: this.plugin.settings.authorName,
        date:   today,
        type:   this.draft.selectedType,
        text:   inputValue.trim(),
      },
    ];

    if (this.draft.wantsAIReply) {
      entries.push({
        author: this.plugin.getDefaultAIAgentName(),
        date:   today,
        type:   'pending',
        text:   '',
      });
    }

    const markup = buildAnnotationMarkup(this.draft.highlightText, entries);
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

  // ── Annotation cards ──────────────────────────────────────────────────────────

  private renderCard(container: HTMLElement, ann: Annotation, file: TFile): HTMLElement {
    const card = container.createEl('div', { cls: 'ilc-card' });
    card.dataset.annotationId = ann.id;
    const firstType = ann.comments[0]?.type ?? 'note';
    card.addClass(`ilc-card-${firstType}`);

    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.ilc-reply-input-row')) return;
      this.jumpToAnnotation(ann);
    });

    // Preview with card-level ⋯ menu
    const preview = card.createEl('div', { cls: 'ilc-card-preview' });
    preview.createEl('span', {
      cls: 'ilc-card-preview-text',
      text: ann.highlightText.slice(0, 60) + (ann.highlightText.length > 60 ? '…' : ''),
    });
    const cardMoreBtn = preview.createEl('button', {
      cls: 'ilc-more-btn',
      attr: { title: '更多操作', 'aria-label': '更多操作' },
    });
    cardMoreBtn.textContent = '⋯';
    cardMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle('删除整条评论')
          .setIcon('trash-2')
          .onClick(() => this.deleteWholeAnnotation(ann, file)),
      );
      menu.showAtMouseEvent(e);
    });

    // Thread — pass ann + index + file for per-entry menus
    const thread = card.createEl('div', { cls: 'ilc-thread' });
    ann.comments.forEach((comment, i) => {
      this.renderCommentEntry(thread, comment, ann, i, file);
    });

    // Reply
    const replyRow  = card.createEl('div', { cls: 'ilc-reply-row' });
    const replyBtn  = replyRow.createEl('button', { cls: 'ilc-reply-btn', text: '+ 回复' });
    const inputRow  = card.createEl('div', { cls: 'ilc-reply-input-row ilc-hidden' });
    const input     = inputRow.createEl('textarea', {
      cls: 'ilc-reply-input',
      attr: { placeholder: '写下回复…', rows: '2' },
    });
    const submitBtn = inputRow.createEl('button', { cls: 'ilc-reply-submit mod-cta', text: '发送' });
    const cancelBtn = inputRow.createEl('button', { cls: 'ilc-reply-cancel', text: '取消' });

    replyBtn.addEventListener('click', (e) => { e.stopPropagation(); replyRow.addClass('ilc-hidden'); inputRow.removeClass('ilc-hidden'); input.focus(); });
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); inputRow.addClass('ilc-hidden'); replyRow.removeClass('ilc-hidden'); input.value = ''; });
    submitBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = input.value.trim();
      if (!text) return;
      const today = new Date().toISOString().split('T')[0];
      const reply: CommentEntry = { author: this.plugin.settings.authorName, date: today, type: 'reply', text };
      const currentContent = await this.app.vault.read(file);
      await this.app.vault.modify(file, appendReply(currentContent, ann.from, reply));
    });

    return card;
  }

  private renderCommentEntry(
    container: HTMLElement,
    comment: CommentEntry,
    ann: Annotation,
    entryIndex: number,
    file: TFile,
  ): void {
    const typeConfig  = this.plugin.settings.commentTypes.find((t) => t.id === comment.type);
    const builtinMeta = COMMENT_TYPE_META[comment.type];
    const emoji = typeConfig?.emoji ?? builtinMeta?.emoji ?? '💬';

    const entry = container.createEl('div', { cls: `ilc-entry ilc-entry-${comment.type}` });

    // pending: special rendering
    if (comment.type === 'pending') {
      entry.addClass('ilc-entry-pending');
      const row = entry.createEl('div', { cls: 'ilc-pending-row' });
      row.createEl('span', { cls: 'ilc-pending-spinner', text: '⏳' });
      row.createEl('span', { cls: 'ilc-pending-label', text: `等待 ${comment.author} 回应…` });
      // Allow deleting pending entries too
      const moreBtn = row.createEl('button', { cls: 'ilc-more-btn ilc-entry-more-btn', text: '⋯', attr: { title: '删除' } });
      moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showEntryMenu(e, ann, entryIndex, file); });
      return;
    }

    const header = entry.createEl('div', { cls: 'ilc-entry-header' });

    // Avatar
    const agentConfig = this.plugin.getAIAgent(comment.author);
    const avatarEl = header.createEl('div', { cls: 'ilc-entry-avatar' });
    if (agentConfig) {
      avatarEl.textContent = agentConfig.avatarChar;
      avatarEl.style.background = agentConfig.avatarBg;
      avatarEl.addClass('ilc-entry-avatar-ai');
    } else {
      avatarEl.textContent = comment.author.charAt(0).toUpperCase();
    }

    header.createEl('span', { cls: 'ilc-entry-author', text: comment.author });
    header.createEl('span', { cls: 'ilc-entry-emoji',  text: emoji });
    header.createEl('span', { cls: 'ilc-entry-date',   text: comment.date });

    // ⋯ button (appears on hover)
    const moreBtn = header.createEl('button', { cls: 'ilc-more-btn ilc-entry-more-btn', text: '⋯', attr: { title: '更多操作' } });
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showEntryMenu(e, ann, entryIndex, file); });

    if (comment.text) {
      entry.createEl('div', { cls: 'ilc-entry-body', text: comment.text });
    }
  }

  // ── Delete helpers ────────────────────────────────────────────────────────────

  private showEntryMenu(e: MouseEvent, ann: Annotation, entryIndex: number, file: TFile): void {
    const menu = new Menu();
    const isLast = ann.comments.length === 1;
    menu.addItem((item) =>
      item
        .setTitle(isLast ? '删除整条评论' : '删除此条')
        .setIcon('trash-2')
        .onClick(() => this.deleteEntry(ann, entryIndex, file)),
    );
    if (!isLast) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle('删除整条评论')
          .setIcon('trash-2')
          .onClick(() => this.deleteWholeAnnotation(ann, file)),
      );
    }
    menu.showAtMouseEvent(e);
  }

  private async deleteWholeAnnotation(ann: Annotation, file: TFile): Promise<void> {
    await this.plugin.saveDeletedComment({
      filePath:          file.path,
      highlightText:     ann.highlightText,
      entries:           ann.comments,
      wasFullAnnotation: true,
    });
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, deleteAnnotation(content, ann.from));
  }

  private async deleteEntry(ann: Annotation, entryIndex: number, file: TFile): Promise<void> {
    const entry = ann.comments[entryIndex];
    if (!entry) return;
    await this.plugin.saveDeletedComment({
      filePath:          file.path,
      highlightText:     ann.highlightText,
      entries:           [entry],
      wasFullAnnotation: ann.comments.length === 1,
    });
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, deleteCommentEntry(content, ann.from, entryIndex));
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

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
