import { ItemView, MarkdownView, Menu, TFile, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
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
import type { AnnotationPosition } from '../editor/cmExtension.ts';
import { parseAtMention } from '../agentReply.ts';
import type InlineCommentsPlugin from '../../main.ts';
import { attachAtSelector } from '../atSelector.ts';
import { computeReadKey } from '../unreadTracker.ts';

export const VIEW_TYPE_COMMENTS = 'ilc-comments-panel';

// ─── Layout types ────────────────────────────────────────────────────────────

interface LayoutItem {
  id: string;
  idealTop: number;
  el: HTMLElement;
  height: number;
  actualTop: number;
}

interface DraftState {
  highlightText:  string;
  from:           number;
  selectedType:   string;
  typeChanged:    boolean;
  onPost:         (markup: string) => void;
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export class CommentPanel extends ItemView {
  private annotations: Annotation[] = [];
  private activeAnnotationId: string | null = null;
  private cardEls: Map<string, HTMLElement> = new Map();

  private cardsZone!: HTMLElement;
  private panelContainer!: HTMLElement;

  private draft: DraftState | null = null;
  private draftEl: HTMLElement | null = null;
  private draftInputEl: HTMLTextAreaElement | null = null;
  private clickAwayHandler: ((e: MouseEvent) => void) | null = null;

  private currentFilePath: string | null = null;

  /** Latest positions received from CM6 */
  private lastPositions: AnnotationPosition[] = [];
  /** Flag to prevent scroll loop */
  private syncingScroll = false;
  /** Temporarily ignore editor scroll sync (e.g. during jumpToAnnotation) */
  private ignoreEditorScrollUntil = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: InlineCommentsPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_COMMENTS; }
  getDisplayText(): string { return '评论'; }
  getIcon(): string { return 'message-square'; }

  async onOpen(): Promise<void> {
    this.panelContainer = this.containerEl.children[1] as HTMLElement;
    this.panelContainer.addClass('ilc-panel');

    this.cardsZone = this.panelContainer.createEl('div', { cls: 'ilc-cards-zone' });

    // History button in the view header (top-right clock icon)
    this.addAction('clock', '删除历史', () => {
      new HistoryModal(this.app, this.plugin).open();
    });

    await this.refresh();

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        // Only refresh if the active file actually changed
        const newFile = this.app.workspace.getActiveFile();
        if (newFile?.path !== this.currentFilePath) {
          this.refresh();
        }
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
    this.panelContainer.empty();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  showDraftCard(highlightText: string, from: number, onPost: (markup: string) => void): void {
    this.cancelDraft();

    const defaultType = this.plugin.settings.commentTypes[0]?.id ?? 'note';
    this.draft = {
      highlightText,
      from,
      selectedType: defaultType,
      typeChanged: false,
      onPost,
    };

    this.renderDraftCardEl();
    // Scroll panel to show the draft card
    setTimeout(() => {
      this.draftInputEl?.focus();
      if (this.draftEl) {
        const cardTop = this.draftEl.offsetTop;
        const panelHeight = this.panelContainer.clientHeight;
        this.panelContainer.scrollTo({ top: Math.max(0, cardTop - panelHeight / 4), behavior: 'smooth' });
      }
    }, 80);

    this.clickAwayHandler = (e: MouseEvent) => {
      if (this.draftEl?.contains(e.target as Node)) return;
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

    // Deactivate previous
    if (this.activeAnnotationId) {
      const prevEl = this.cardEls.get(this.activeAnnotationId);
      if (prevEl) {
        prevEl.removeClass('ilc-card-active');
      }
    }

    this.activeAnnotationId = annotationId;
    const el = this.cardEls.get(annotationId);
    if (el) {
      el.addClass('ilc-card-active');
      // Pause editor scroll sync so it doesn't fight our scroll
      this.ignoreEditorScrollUntil = Date.now() + 400;
      // Scroll panel so the card is visible
      const cardTop = el.offsetTop;
      const panelHeight = this.panelContainer.clientHeight;
      const scrollTarget = cardTop - panelHeight / 4;
      this.panelContainer.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' });
      // Re-layout because focused card may have different height (reply input shown)
      setTimeout(() => this.layoutCards(), 50);
    }
  }

  /** Receive annotation positions from CM6 */
  syncPositions(positions: AnnotationPosition[]): void {
    this.lastPositions = positions;
    this.layoutCards();
  }

  /** Sync panel scroll with editor scroll */
  syncEditorScroll(scrollTop: number): void {
    // Skip if we're in a user-initiated scroll (e.g. after clicking a card)
    if (Date.now() < this.ignoreEditorScrollUntil) return;
    this.syncingScroll = true;
    this.panelContainer.scrollTop = scrollTop;
    requestAnimationFrame(() => { this.syncingScroll = false; });
  }

  // ── Refresh ──────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (!this.cardsZone) return;

    // Preserve draft element if it exists
    const hadDraft = !!this.draft;

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
    }

    for (const ann of this.annotations) {
      const card = this.renderCard(this.cardsZone, ann, file);
      this.cardEls.set(ann.id, card);
    }

    // Re-add draft element into cardsZone
    if (hadDraft && this.draft) {
      this.renderDraftCardEl();
    }

    // Compute positions directly from the editor (don't wait for async CM6 callback)
    this.computePositionsFromEditor();
    this.layoutCards();
  }

  // ── Position computation ─────────────────────────────────────────────────────

  /** Directly read annotation positions from the CM6 EditorView */
  private computePositionsFromEditor(): void {
    try {
      const mdView = this.findMarkdownView();
      if (!mdView) return;
      // Access the underlying CM6 EditorView
      const cmEditor = (mdView as any).editor?.cm as EditorView | undefined;
      if (!cmEditor) return;

      const scrollerRect = cmEditor.scrollDOM.getBoundingClientRect();
      const positions: AnnotationPosition[] = [];
      const editor = mdView.editor;

      for (const ann of this.annotations) {
        const hlStart = ann.from + 3; // skip {==
        const coords = cmEditor.coordsAtPos(hlStart);

        let topInEditor: number;
        if (coords) {
          topInEditor = coords.top - scrollerRect.top + cmEditor.scrollDOM.scrollTop;
        } else {
          // Annotation is outside the rendered viewport — estimate from line number
          const pos = editor.offsetToPos(ann.from);
          topInEditor = pos.line * 24; // rough estimate: 24px per line
        }

        positions.push({
          annotationId: ann.id,
          topInEditor,
          from: ann.from,
        });
      }

      if (positions.length > 0) {
        this.lastPositions = positions;
      }
    } catch {
      // Editor may not be ready yet, will get positions via async callback later
    }
  }

  // ── Layout engine ────────────────────────────────────────────────────────────

  private layoutCards(): void {
    const items: LayoutItem[] = [];

    // Build position map from last known positions
    const posMap = new Map<string, number>();
    for (const p of this.lastPositions) {
      posMap.set(p.annotationId, p.topInEditor);
    }

    // Determine if we have any position data at all
    const hasPositionData = this.lastPositions.length > 0;

    // Add annotation cards — always include all, estimate position if missing
    let lastKnownTop = 0;
    for (const ann of this.annotations) {
      const cardEl = this.cardEls.get(ann.id);
      if (!cardEl) continue;

      let idealTop: number;
      if (hasPositionData) {
        // Use CM6 position if available; estimate from document order if not
        idealTop = posMap.get(ann.id) ?? lastKnownTop;
      } else {
        // No position data: stack sequentially
        idealTop = lastKnownTop;
      }
      lastKnownTop = idealTop + (cardEl.offsetHeight || 100) + 8;

      items.push({
        id: ann.id,
        idealTop,
        el: cardEl,
        height: cardEl.offsetHeight || 100,
        actualTop: 0,
      });
    }

    // Add draft card if present
    if (this.draft && this.draftEl) {
      const draftIdealTop = this.getDraftIdealTop();
      items.push({
        id: '__draft__',
        idealTop: draftIdealTop,
        el: this.draftEl,
        height: this.draftEl.offsetHeight || 200,
        actualTop: 0,
      });
    }

    if (items.length === 0) return;

    // Sort by idealTop (preserves document order when positions are correct)
    items.sort((a, b) => a.idealTop - b.idealTop);

    // Greedy collision resolution with max gap cap
    const GAP = 8;
    const MAX_GAP = 40; // don't let cards drift too far apart
    let nextAvailable = 8;

    for (const item of items) {
      // Use idealTop but cap the gap from previous card
      const capped = Math.min(item.idealTop, nextAvailable + MAX_GAP);
      item.actualTop = Math.max(capped, nextAvailable);
      nextAvailable = item.actualTop + item.height + GAP;
    }

    // Set cardsZone min-height
    const lastItem = items[items.length - 1];
    if (lastItem) {
      this.cardsZone.style.minHeight = `${lastItem.actualTop + lastItem.height + 60}px`;
    }

    // Apply positions
    for (const item of items) {
      item.el.style.top = `${item.actualTop}px`;
    }
  }

  private getDraftIdealTop(): number {
    if (!this.draft) return 0;

    // Get the pixel position of the selection directly from CM6
    try {
      const mdView = this.findMarkdownView();
      if (mdView) {
        const cmEditor = (mdView as any).editor?.cm as EditorView | undefined;
        if (cmEditor) {
          const coords = cmEditor.coordsAtPos(this.draft.from);
          if (coords) {
            const scrollerRect = cmEditor.scrollDOM.getBoundingClientRect();
            return coords.top - scrollerRect.top + cmEditor.scrollDOM.scrollTop;
          }
        }
        // Fallback: estimate from line number
        const pos = mdView.editor.offsetToPos(this.draft.from);
        return pos.line * 24;
      }
    } catch { /* ignore */ }
    return 0;
  }

  // ── Draft card ────────────────────────────────────────────────────────────────

  private renderDraftCardEl(): void {
    // Remove previous draft element
    this.draftEl?.remove();

    const d = this.draft!;
    const types = this.plugin.settings.commentTypes;

    const card = this.cardsZone.createEl('div', {
      cls: `ilc-card ilc-card-draft ilc-card-active`,
    });
    this.draftEl = card;

    // ── 1. Preview text + ⋯ button ──
    const previewBar = card.createEl('div', { cls: 'ilc-card-preview' });
    previewBar.createEl('span', {
      cls: 'ilc-card-preview-text',
      text: d.highlightText.slice(0, 50) + (d.highlightText.length > 50 ? '…' : ''),
    });
    const cardMoreBtn = previewBar.createEl('button', {
      cls: 'ilc-more-btn',
      attr: { 'aria-label': '更多操作' },
    });
    cardMoreBtn.textContent = '⋯';
    cardMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle('取消').setIcon('x').onClick(() => this.cancelDraft()),
      );
      menu.showAtMouseEvent(e);
    });

    // ── 2. Avatar + Name row ──
    const authorRow = card.createEl('div', { cls: 'ilc-draft-author-row' });
    const avatar = authorRow.createEl('div', { cls: 'ilc-draft-avatar' });
    avatar.textContent = this.plugin.settings.authorName.charAt(0).toUpperCase();
    avatar.style.background = this.plugin.settings.avatarBg;
    avatar.style.color = '#fff';
    avatar.style.border = 'none';
    authorRow.createEl('span', {
      cls: 'ilc-draft-author-name',
      text: this.plugin.settings.authorName,
    });

    // ── 3. Type chips (below the name) ──
    const typeRow = card.createEl('div', { cls: 'ilc-draft-type-row' });
    let activeBtn: HTMLElement | null = null;

    for (const type of types) {
      const btn = typeRow.createEl('button', {
        cls: `ilc-draft-type-btn ilc-draft-type-${type.id}`,
      });
      btn.createEl('span', { cls: 'ilc-draft-type-label', text: type.label });

      if (type.id === d.selectedType) {
        btn.addClass('ilc-draft-type-active');
        activeBtn = btn;
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeBtn?.removeClass('ilc-draft-type-active');
        d.selectedType = type.id;
        d.typeChanged = true;
        btn.addClass('ilc-draft-type-active');
        activeBtn = btn;
      });
    }

    // ── 4. Input ──
    const inputWrapper = card.createEl('div', { cls: 'ilc-draft-input-wrapper' });
    const input = inputWrapper.createEl('textarea', {
      cls: 'ilc-draft-input',
      attr: { placeholder: '添加评论（可选）…', rows: '3' },
    });
    this.draftInputEl = input;
    attachAtSelector(input, inputWrapper, this.app);

    // ── 5. Action buttons (always visible) ──
    const actionRow = card.createEl('div', { cls: 'ilc-draft-actions' });
    const cancelBtn = actionRow.createEl('button', { cls: 'ilc-draft-cancel', text: '取消' });
    const postBtn   = actionRow.createEl('button', { cls: 'ilc-draft-post mod-cta', text: '发送' });

    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.submitDraft(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); this.cancelDraft(); }
    });
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); this.cancelDraft(); });
    postBtn.addEventListener('click', (e) => { e.stopPropagation(); this.submitDraft(input.value); });

    // Schedule layout
    requestAnimationFrame(() => this.layoutCards());
  }

  private submitDraft(inputValue: string): void {
    if (!this.draft) return;

    const today = new Date().toISOString().split('T')[0];
    const entries: CommentEntry[] = [
      {
        author: this.plugin.settings.authorName,
        date:   today,
        type:   this.draft.selectedType,
        text:   inputValue.trim(),
      },
    ];

    const markup = buildAnnotationMarkup(this.draft.highlightText, entries);
    this.draft.onPost(markup);
    this.cancelDraft();
  }

  private cancelDraft(): void {
    if (this.clickAwayHandler) {
      document.removeEventListener('mousedown', this.clickAwayHandler);
      this.clickAwayHandler = null;
    }
    this.draftEl?.remove();
    this.draftEl = null;
    this.draftInputEl = null;
    this.draft = null;
  }

  // ── Annotation cards ──────────────────────────────────────────────────────────

  private renderCard(container: HTMLElement, ann: Annotation, file: TFile): HTMLElement {
    const card = container.createEl('div', { cls: 'ilc-card' });
    card.dataset.annotationId = ann.id;
    const firstType = ann.comments[0]?.type ?? 'note';
    card.addClass(`ilc-card-${firstType}`);

    // Apply active state if this card is currently active
    if (ann.id === this.activeAnnotationId) {
      card.addClass('ilc-card-active');
    }

    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.ilc-reply-input-row')) return;
      this.jumpToAnnotation(ann);
      this.highlightCard(ann.id);
    });

    // Preview with card-level ⋯ menu
    const preview = card.createEl('div', { cls: 'ilc-card-preview' });
    preview.createEl('span', {
      cls: 'ilc-card-preview-text',
      text: ann.highlightText.slice(0, 60) + (ann.highlightText.length > 60 ? '…' : ''),
    });
    const cardMoreBtn = preview.createEl('button', {
      cls: 'ilc-more-btn',
      attr: { 'aria-label': '更多操作' },
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

    // Thread
    const thread = card.createEl('div', { cls: 'ilc-thread' });
    ann.comments.forEach((comment, i) => {
      this.renderCommentEntry(thread, comment, ann, i, file);
    });

    // Reply input row (visible only when card is active, controlled by CSS)
    const inputRow  = card.createEl('div', { cls: 'ilc-reply-input-row' });
    const input     = inputRow.createEl('textarea', {
      cls: 'ilc-reply-input',
      attr: { placeholder: '写下回复…', rows: '2' },
    });
    const btnRow = inputRow.createEl('div', { cls: 'ilc-reply-btn-row' });
    const submitBtn = btnRow.createEl('button', { cls: 'ilc-reply-submit mod-cta ilc-hidden', text: '发送' });

    // Show submit button only when input has content
    input.addEventListener('input', () => {
      if (input.value.trim()) {
        submitBtn.removeClass('ilc-hidden');
      } else {
        submitBtn.addClass('ilc-hidden');
      }
      // Re-layout after height change
      requestAnimationFrame(() => this.layoutCards());
    });

    submitBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = input.value.trim();
      if (!text) return;
      const today = new Date().toISOString().split('T')[0];
      const reply: CommentEntry = { author: this.plugin.settings.authorName, date: today, type: 'reply', text };
      const currentContent = await this.app.vault.read(file);
      await this.app.vault.modify(file, appendReply(currentContent, ann.from, reply));
    });

    attachAtSelector(input, inputRow, this.app);

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
      const moreBtn = row.createEl('button', { cls: 'ilc-more-btn ilc-entry-more-btn', text: '⋯' });
      moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showEntryMenu(e, ann, entryIndex, file); });
      return;
    }

    const header = entry.createEl('div', { cls: 'ilc-entry-header' });

    // Avatar — use AI agent config or user's avatar settings
    const agentConfig = this.plugin.getAIAgent(comment.author);
    const avatarEl = header.createEl('div', { cls: 'ilc-entry-avatar' });
    if (agentConfig) {
      avatarEl.textContent = agentConfig.avatarChar;
      avatarEl.style.background = agentConfig.avatarBg;
      avatarEl.addClass('ilc-entry-avatar-ai');
    } else {
      avatarEl.textContent = comment.author.charAt(0).toUpperCase();
      avatarEl.style.background = this.plugin.settings.avatarBg;
      avatarEl.style.color = '#fff';
    }

    header.createEl('span', { cls: 'ilc-entry-author', text: comment.author });
    header.createEl('span', { cls: 'ilc-entry-emoji',  text: emoji });
    header.createEl('span', { cls: 'ilc-entry-date',   text: comment.date });

    // ⋯ button (appears on hover)
    const moreBtn = header.createEl('button', { cls: 'ilc-more-btn ilc-entry-more-btn', text: '⋯' });
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showEntryMenu(e, ann, entryIndex, file); });

    if (comment.text) {
      entry.createEl('div', { cls: 'ilc-entry-body', text: comment.text });
    }

    // @Agent reply button: detect @mention of a registered (has sessionId) agent
    const registeredNames = this.plugin.settings.aiAgents
      .filter((a) => a.sessionId)
      .map((a) => a.name);
    const mentionedAgent = parseAtMention(comment.text, registeredNames);
    if (mentionedAgent && mentionedAgent.toLowerCase() !== comment.author.toLowerCase()) {
      const btn = entry.createEl('button', {
        cls: 'ilc-agent-reply-btn',
        text: `🗨 请 ${mentionedAgent} 回应`,
      });
      const agentName = mentionedAgent;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = `${agentName} 思考中…`;
        btn.addClass('ilc-agent-reply-pending');
        try {
          await this.plugin.requestAgentReply(file, ann.from, agentName);
        } finally {
          btn.disabled = false;
          btn.textContent = `🗨 请 ${agentName} 回应`;
          btn.removeClass('ilc-agent-reply-pending');
        }
      });
    }

    // Read/unread indicator for reply entries
    if (comment.type === 'reply') {
      const readKey = computeReadKey(file.path, ann.highlightText, comment.author, comment.date, comment.text);
      const isAlreadyRead = this.plugin.unreadTracker?.isRead(readKey) ?? false;

      if (!isAlreadyRead) {
        entry.addClass('ilc-entry-unread');
      }

      const readBtn = entry.createEl('button', {
        cls: `ilc-read-btn ${isAlreadyRead ? 'ilc-read-btn-read' : 'ilc-read-btn-unread'}`,
        text: isAlreadyRead ? '已读' : '✓ 已读',
      });

      if (!isAlreadyRead) {
        readBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.plugin.unreadTracker?.markAsRead(readKey);
          await this.refresh();
        });
      }
    }
  }

  // ── Delete helpers ────────────────────────────────────────────────────────────

  private showEntryMenu(e: MouseEvent, ann: Annotation, entryIndex: number, file: TFile): void {
    const menu = new Menu();
    const isOnly = ann.comments.length === 1;
    const isFirst = entryIndex === 0;

    if (isOnly) {
      // Only one entry — deleting it removes the whole annotation
      menu.addItem((item) =>
        item.setTitle('删除整条评论').setIcon('trash-2')
          .onClick(() => this.deleteWholeAnnotation(ann, file)),
      );
    } else {
      // Multiple entries — only show "删除此条"
      menu.addItem((item) =>
        item.setTitle('删除此条').setIcon('trash-2')
          .onClick(() => this.deleteEntry(ann, entryIndex, file)),
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

  /** Find the MarkdownView for the current file (not getActiveViewOfType which may return null when panel is focused) */
  private findMarkdownView(): MarkdownView | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    // Search all leaves for a MarkdownView showing this file
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) {
        return view;
      }
    }
    return null;
  }

  private jumpToAnnotation(ann: Annotation): void {
    const mdView = this.findMarkdownView();
    if (!mdView) return;
    const editor = mdView.editor;

    // Temporarily stop syncing panel scroll with editor
    this.ignoreEditorScrollUntil = Date.now() + 600;

    // Focus the editor DOM directly (avoid setActiveLeaf which triggers refresh)
    const cmEditor = (mdView as any).editor?.cm as EditorView | undefined;
    if (cmEditor) {
      cmEditor.focus();
    }

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
