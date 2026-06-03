import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type { Annotation, CommentEntry } from '../types.ts';
import { COMMENT_TYPE_META } from '../types.ts';
import { parseAnnotations, appendReply, buildAnnotationMarkup } from '../parser.ts';
import type InlineCommentsPlugin from '../../main.ts';

export const VIEW_TYPE_COMMENTS = 'ilc-comments-panel';

interface DraftState {
  highlightText:  string;
  selectedType:   string;
  typeChanged:    boolean; // user explicitly clicked a type chip
  wantsAIReply:   boolean;
  onPost:         (markup: string) => void;
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

    // Default to first available type
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

    // Click-away: dismiss only when nothing useful was done
    this.clickAwayHandler = (e: MouseEvent) => {
      if (this.draftZone.contains(e.target as Node)) return;
      // Only auto-dismiss if empty input AND no type was explicitly selected
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

  // ── Refresh: only touches cardsZone ─────────────────────────────────────────

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
    const types = this.plugin.settings.commentTypes;

    const card = this.draftZone.createEl('div', {
      cls: `ilc-card ilc-card-draft ilc-card-${d.selectedType}`,
    });

    // ── Preview ──
    const previewBar = card.createEl('div', { cls: 'ilc-draft-preview' });
    previewBar.createEl('span', {
      cls: 'ilc-draft-preview-text',
      text: d.highlightText.slice(0, 50) + (d.highlightText.length > 50 ? '…' : ''),
    });

    // ── Type chips ──
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

    // ── Author row ──
    const authorRow = card.createEl('div', { cls: 'ilc-draft-author-row' });
    const avatar = authorRow.createEl('div', { cls: 'ilc-draft-avatar' });
    avatar.textContent = this.plugin.settings.authorName.charAt(0).toUpperCase();
    authorRow.createEl('span', {
      cls: 'ilc-draft-author-name',
      text: this.plugin.settings.authorName,
    });
    // Selected type badge
    const selectedMeta = types.find((t) => t.id === d.selectedType);
    const typeBadge = authorRow.createEl('span', {
      cls: 'ilc-draft-type-badge',
      text: selectedMeta ? selectedMeta.emoji + ' ' + selectedMeta.label : d.selectedType,
    });

    // ── Input ──
    const inputWrapper = card.createEl('div', { cls: 'ilc-draft-input-wrapper' });
    const input = inputWrapper.createEl('textarea', {
      cls: 'ilc-draft-input',
      attr: { placeholder: '添加评论（可选）…', rows: '2' },
    });
    this.draftInputEl = input;

    // ── Actions (hidden until type selected or input has content) ──
    const actionRow = card.createEl('div', { cls: 'ilc-draft-actions ilc-hidden' });

    // AI reply toggle
    const hasAgents = this.plugin.settings.aiAgents.length > 0;
    if (hasAgents) {
      const toggleRow = card.createEl('div', { cls: 'ilc-draft-ai-toggle' });
      const checkbox = toggleRow.createEl('input', {
        attr: { type: 'checkbox', id: 'ilc-ai-toggle' },
      }) as HTMLInputElement;
      toggleRow.createEl('label', {
        attr: { for: 'ilc-ai-toggle' },
        text: `请 ${this.plugin.getDefaultAIAgentName()} 回应`,
      });
      checkbox.addEventListener('change', () => {
        d.wantsAIReply = checkbox.checked;
      });
    }

    const cancelBtn = actionRow.createEl('button', { cls: 'ilc-draft-cancel', text: 'Cancel' });
    const postBtn   = actionRow.createEl('button', { cls: 'ilc-draft-post mod-cta', text: 'Post' });

    input.addEventListener('input', () => {
      updateActions();
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
    // Allow empty text — a selected type alone is a valid reaction
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

    // Append pending entry if AI response requested
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
    const replyRow   = card.createEl('div', { cls: 'ilc-reply-row' });
    const replyBtn   = replyRow.createEl('button', { cls: 'ilc-reply-btn', text: '+ 回复' });
    const inputRow   = card.createEl('div', { cls: 'ilc-reply-input-row ilc-hidden' });
    const input      = inputRow.createEl('textarea', {
      cls: 'ilc-reply-input',
      attr: { placeholder: '写下回复…', rows: '2' },
    });
    const submitBtn  = inputRow.createEl('button', { cls: 'ilc-reply-submit mod-cta', text: '发送' });
    const cancelBtn  = inputRow.createEl('button', { cls: 'ilc-reply-cancel', text: '取消' });

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
        date:   today,
        type:   'reply',
        text,
      };
      const currentContent = await this.app.vault.read(file);
      const newContent = appendReply(currentContent, ann.from, reply);
      await this.app.vault.modify(file, newContent);
    });

    return card;
  }

  private renderCommentEntry(container: HTMLElement, comment: CommentEntry): void {
    // Look up type meta from settings first, then built-in fallback
    const typeConfig = this.plugin.settings.commentTypes.find((t) => t.id === comment.type);
    const builtinMeta = COMMENT_TYPE_META[comment.type];
    const emoji = typeConfig?.emoji ?? builtinMeta?.emoji ?? '💬';
    const label = typeConfig?.label ?? builtinMeta?.label ?? comment.type;

    const entry = container.createEl('div', {
      cls: `ilc-entry ilc-entry-${comment.type}`,
    });

    // pending: special rendering
    if (comment.type === 'pending') {
      entry.addClass('ilc-entry-pending');
      const pendingRow = entry.createEl('div', { cls: 'ilc-pending-row' });
      pendingRow.createEl('span', { cls: 'ilc-pending-spinner', text: '⏳' });
      pendingRow.createEl('span', {
        cls: 'ilc-pending-label',
        text: `等待 ${comment.author} 回应…`,
      });
      return;
    }

    const header = entry.createEl('div', { cls: 'ilc-entry-header' });

    // Author avatar — check AI agent config first
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

    // Body (omit if empty — pure reaction)
    if (comment.text) {
      entry.createEl('div', { cls: 'ilc-entry-body', text: comment.text });
    }
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
