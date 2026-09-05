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
import { setDraftRange, type AnnotationPosition } from '../editor/cmExtension.ts';
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

/** Accent colors for built-in types (fallback when settings carry no color) */
const BUILTIN_TYPE_COLORS: Record<string, string> = {
  agree:     '#6FA287',
  disagree:  '#C96C6C',
  question:  '#D4A24C',
  important: '#6A8FCF',
  note:      '#9AA0A6',
};

/** Strip common markdown formatting for preview display */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/__(.+?)__/g, '$1')        // bold alt
    .replace(/\*(.+?)\*/g, '$1')        // italic
    .replace(/_(.+?)_/g, '$1')          // italic alt
    .replace(/~~(.+?)~~/g, '$1')        // strikethrough
    .replace(/==(.+?)==/g, '$1')        // highlight
    .replace(/`(.+?)`/g, '$1')          // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links → text only
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export class CommentPanel extends ItemView {
  private annotations: Annotation[] = [];
  private activeAnnotationId: string | null = null;
  private cardEls: Map<string, HTMLElement> = new Map();

  private cardsZone!: HTMLElement;
  private headerEl!: HTMLElement;
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
  /** Observe card size changes to trigger relayout */
  private resizeObserver: ResizeObserver | null = null;
  /** Editor instance the panel is currently aligned with (same note may be open in several panes) */
  private alignedCm: EditorView | undefined;

  constructor(leaf: WorkspaceLeaf, private plugin: InlineCommentsPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_COMMENTS; }
  getDisplayText(): string { return '评论'; }
  getIcon(): string { return 'message-square'; }

  async onOpen(): Promise<void> {
    this.panelContainer = this.containerEl.children[1] as HTMLElement;
    this.panelContainer.addClass('ilc-panel');
    this.applyPanelBackground();

    this.headerEl = this.panelContainer.createEl('div', { cls: 'ilc-panel-header ilc-hidden' });
    this.cardsZone = this.panelContainer.createEl('div', { cls: 'ilc-cards-zone' });

    // History button in the view header (top-right clock icon)
    this.addAction('clock', '删除历史', () => {
      new HistoryModal(this.app, this.plugin).open();
    });

    // Observe card size changes (text reflow, reply box expand/collapse)
    this.resizeObserver = new ResizeObserver(() => {
      this.layoutCards();
    });

    await this.refresh();

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const newFile = this.app.workspace.getActiveFile();
        if (newFile?.path !== this.currentFilePath) {
          this.refresh();
          return;
        }
        // Same note, but possibly a different pane: re-align with that editor
        const cm = this.currentCm();
        if (cm && cm !== this.alignedCm) this.alignWith(cm);
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        const active = this.app.workspace.getActiveFile();
        if (active && file.path === active.path) this.refresh();
      }),
    );
    // Layout changes (sidebar opened/resized) re-wrap the editor and move every anchor
    this.registerEvent(this.app.workspace.on('resize', () => this.layoutCards()));
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
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
    this.setEditorDraftRange({ from, to: from + highlightText.length, cls: `ilc-highlight ilc-hl-${defaultType}` });
    // Scroll panel to show the draft card
    window.setTimeout(() => {
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
    window.setTimeout(() => {
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
      window.setTimeout(() => this.layoutCards(), 50);
    }
  }

  /** Receive annotation positions from CM6 */
  syncPositions(positions: AnnotationPosition[], view?: EditorView): void {
    if (!this.isCurrentEditor(view)) return; // a background tab of the same note
    // The extension measures inside the editor scroller; re-base onto cardsZone
    let delta = 0;
    try {
      const cm = view ?? this.currentCm();
      if (cm) delta = this.originDelta(cm.scrollDOM.getBoundingClientRect());
    } catch { /* ignore */ }
    this.lastPositions = positions.map((p) => ({ ...p, topInEditor: p.topInEditor + delta }));
    this.layoutCards();
  }

  /** Sync panel scroll with editor scroll */
  syncEditorScroll(scrollTop: number, view?: EditorView): void {
    if (!this.isCurrentEditor(view)) return;
    // Skip if we're in a user-initiated scroll (e.g. after clicking a card)
    if (Date.now() < this.ignoreEditorScrollUntil) return;
    this.syncingScroll = true;
    this.panelContainer.scrollTop = scrollTop;
    window.requestAnimationFrame(() => { this.syncingScroll = false; });
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
      this.headerEl.addClass('ilc-hidden');
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

    this.updateHeader(file);

    for (const ann of this.annotations) {
      const card = this.renderCard(this.cardsZone, ann, file);
      this.cardEls.set(ann.id, card);
    }

    // Re-add draft element into cardsZone
    if (hadDraft && this.draft) {
      this.renderDraftCardEl();
    }

    // Compute positions directly from the editor (don't wait for async CM6 callback)
    this.alignedCm = this.currentCm();
    this.computePositionsFromEditor();
    this.layoutCards();
    // The editor may still be re-measuring (sidebar just opened, fonts loading):
    // settle with two deferred passes.
    window.requestAnimationFrame(() => this.layoutCards());
    window.setTimeout(() => this.layoutCards(), 300);
  }

  // ── Panel background (settings) ──────────────────────────────────────────────

  /** Apply the "面板背景" setting: follow sidebar (default), follow editor, or custom color */
  applyPanelBackground(): void {
    const s = this.plugin.settings;
    const el = this.panelContainer;
    if (!el) return;
    el.removeClass('ilc-panel-bg-editor');
    el.style.removeProperty('--ilc-panel-bg');
    if (s.panelBackground === 'editor') {
      el.addClass('ilc-panel-bg-editor');
    } else if (s.panelBackground === 'custom' && s.panelBackgroundColor) {
      el.setCssProps({ '--ilc-panel-bg': s.panelBackgroundColor });
    }
  }

  // ── Header & accent helpers ──────────────────────────────────────────────────

  /** Resolve the accent color for a comment type (settings first, then built-in) */
  private typeAccent(typeId: string): string {
    const cfg = this.plugin.settings.commentTypes.find((t) => t.id === typeId);
    if (cfg?.color) return cfg.color;
    return BUILTIN_TYPE_COLORS[typeId] ?? 'var(--text-muted)';
  }

  /** Render "N 条评论 · M 未读" above the cards */
  private updateHeader(file: TFile): void {
    this.headerEl.empty();
    const total = this.annotations.length;
    if (total === 0) {
      this.headerEl.addClass('ilc-hidden');
      return;
    }
    this.headerEl.removeClass('ilc-hidden');

    const tracker = this.plugin.unreadTracker;
    let unread = 0;
    for (const ann of this.annotations) {
      for (const c of ann.comments) {
        if (c.type !== 'reply' || !tracker?.isTrackable(c.author)) continue;
        const key = computeReadKey(file.path, ann.highlightText, c.author, c.date, c.text);
        if (!tracker.isRead(key)) unread++;
      }
    }

    const count = this.headerEl.createEl('span', { cls: 'ilc-panel-count' });
    count.createEl('strong', { text: String(total) });
    count.appendText(' 条评论');
    if (unread > 0) {
      this.headerEl.createEl('span', { cls: 'ilc-panel-unread', text: `· ${unread} 未读` });
    }
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
      const delta = this.originDelta(scrollerRect);
      // document-top → scroller coordinate base (for the out-of-viewport fallback)
      const docBase = cmEditor.documentTop - scrollerRect.top + cmEditor.scrollDOM.scrollTop;

      for (const ann of this.annotations) {
        const hlStart = Math.min(ann.from + 3, cmEditor.state.doc.length); // skip {==
        const coords = cmEditor.coordsAtPos(hlStart);

        let topInEditor: number;
        if (coords) {
          topInEditor = coords.top - scrollerRect.top + cmEditor.scrollDOM.scrollTop;
        } else {
          // Outside the rendered viewport — CM6 height-map estimate (accurate to the line block)
          topInEditor = cmEditor.lineBlockAt(hlStart).top + docBase;
        }
        topInEditor += delta;

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

    // Anchors can change between refreshes (editor re-measures lines as they scroll
    // into view) — re-read them; cheap, and keeps cards glued to the text.
    this.computePositionsFromEditor();

    const posMap = new Map<string, number>();
    for (const p of this.lastPositions) {
      posMap.set(p.annotationId, p.topInEditor);
    }

    const hasPositionData = this.lastPositions.length > 0;

    let estimateTop = 0;
    for (const ann of this.annotations) {
      const cardEl = this.cardEls.get(ann.id);
      if (!cardEl) continue;

      const h = cardEl.offsetHeight || 60;
      let idealTop: number;
      if (hasPositionData) {
        idealTop = posMap.get(ann.id) ?? estimateTop;
      } else {
        idealTop = estimateTop;
      }
      estimateTop = idealTop + h + 8;

      items.push({ id: ann.id, idealTop, el: cardEl, height: h, actualTop: 0 });
    }

    if (this.draft && this.draftEl) {
      const h = this.draftEl.offsetHeight || 200;
      items.push({ id: '__draft__', idealTop: this.getDraftIdealTop(), el: this.draftEl, height: h, actualTop: 0 });
    }

    if (items.length === 0) return;

    items.sort((a, b) => a.idealTop - b.idealTop);

    // Pass 1 — no-overlap greedy: each card sits at its anchor or below the previous card
    const GAP = 8;
    const MIN_TOP = 8;
    let nextAvailable = MIN_TOP;

    for (const item of items) {
      item.actualTop = Math.max(item.idealTop, nextAvailable);
      nextAvailable = item.actualTop + item.height + GAP;
    }

    // Pass 2 — the focused card (draft first, else active) must sit exactly on its
    // anchor; cards above it yield upward (Feishu / Google Docs behaviour), cards
    // below are re-flowed underneath it.
    const focusId = this.draft ? '__draft__' : this.activeAnnotationId;
    const fi = focusId ? items.findIndex((it) => it.id === focusId) : -1;
    if (fi >= 0 && items[fi].actualTop > items[fi].idealTop) {
      items[fi].actualTop = Math.max(items[fi].idealTop, MIN_TOP);
      for (let i = fi - 1; i >= 0; i--) {
        const limit = items[i + 1].actualTop - items[i].height - GAP;
        items[i].actualTop = Math.min(items[i].actualTop, limit);
      }
      // Ran out of room at the top → push the whole cluster back down just enough
      if (items[0].actualTop < MIN_TOP) {
        const shift = MIN_TOP - items[0].actualTop;
        for (let i = 0; i <= fi; i++) items[i].actualTop += shift;
      }
      let next = items[fi].actualTop + items[fi].height + GAP;
      for (let i = fi + 1; i < items.length; i++) {
        items[i].actualTop = Math.max(items[i].idealTop, next);
        next = items[i].actualTop + items[i].height + GAP;
      }
    }

    const lastItem = items[items.length - 1];
    if (lastItem) {
      this.cardsZone.setCssStyles({ minHeight: `${lastItem.actualTop + lastItem.height + 60}px` });
    }

    for (const item of items) {
      item.el.setCssStyles({ top: `${item.actualTop}px` });
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
            return coords.top - scrollerRect.top + cmEditor.scrollDOM.scrollTop + this.originDelta(scrollerRect);
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
    card.setCssProps({ '--ilc-accent': this.typeAccent(d.selectedType) });
    this.draftEl = card;

    // ── 1. Preview text + ⋯ button ──
    const previewBar = card.createEl('div', { cls: 'ilc-card-preview' });
    previewBar.createEl('span', { cls: 'ilc-card-quote-rule' });
    const draftPreviewText = stripMarkdown(d.highlightText);
    previewBar.createEl('span', {
      cls: 'ilc-card-preview-text',
      text: draftPreviewText.slice(0, 50) + (draftPreviewText.length > 50 ? '…' : ''),
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
    avatar.setCssStyles({ background: this.plugin.settings.avatarBg });
    avatar.setCssStyles({ color: '#fff' });
    avatar.setCssStyles({ border: 'none' });
    this.tryUpgradeAvatarToImage(avatar, this.plugin.settings.authorName);
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
      btn.setCssProps({ '--ilc-accent': this.typeAccent(type.id) });

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
        card.setCssProps({ '--ilc-accent': this.typeAccent(type.id) });
        this.setEditorDraftRange({ from: d.from, to: d.from + d.highlightText.length, cls: `ilc-highlight ilc-hl-${type.id}` });
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
    });
    // Esc cancels from anywhere inside the draft card (type chips included)
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelDraft(); }
    });
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); this.cancelDraft(); });
    postBtn.addEventListener('click', (e) => { e.stopPropagation(); this.submitDraft(input.value); });

    this.resizeObserver?.observe(card);

    // Schedule layout
    window.requestAnimationFrame(() => this.layoutCards());
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

    // Force panel refresh after document modification so the new comment card appears immediately
    window.setTimeout(() => this.refresh(), 150);
  }

  /** Show / clear the temporary "being commented" highlight in the editor */
  private setEditorDraftRange(range: { from: number; to: number; cls?: string } | null): void {
    try {
      const cm = (this.findMarkdownView() as any)?.editor?.cm as EditorView | undefined;
      cm?.dispatch({ effects: setDraftRange.of(range) });
    } catch { /* editor gone */ }
  }

  /**
   * Cards are positioned inside cardsZone, anchors are measured inside the
   * editor's scroller. The two containers rarely start at the same screen Y
   * (panel header, view headers) — this is the correction to add to anchors.
   */
  private originDelta(scrollerRect: DOMRect): number {
    const zoneTop = this.cardsZone.getBoundingClientRect().top + this.panelContainer.scrollTop;
    return scrollerRect.top - zoneTop;
  }

  private cancelDraft(): void {
    this.setEditorDraftRange(null);
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
    card.setCssProps({ '--ilc-accent': this.typeAccent(firstType) });

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
    preview.createEl('span', { cls: 'ilc-card-quote-rule' });
    const previewText = stripMarkdown(ann.highlightText);
    preview.createEl('span', {
      cls: 'ilc-card-preview-text',
      text: previewText.slice(0, 60) + (previewText.length > 60 ? '…' : ''),
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
      window.requestAnimationFrame(() => this.layoutCards());
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

    this.resizeObserver?.observe(card);

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
    if (entryIndex > 0) entry.addClass('ilc-entry-has-prev');
    if (entryIndex < ann.comments.length - 1) entry.addClass('ilc-entry-has-next');

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

    // Avatar — letter fallback first, then async upgrade to image if png exists
    const agentConfig = this.plugin.getAIAgent(comment.author);
    const avatarEl = header.createEl('div', { cls: 'ilc-entry-avatar' });
    if (agentConfig) {
      avatarEl.textContent = agentConfig.avatarChar;
      avatarEl.setCssStyles({ background: agentConfig.avatarBg });
      avatarEl.addClass('ilc-entry-avatar-ai');
    } else {
      avatarEl.textContent = comment.author.charAt(0).toUpperCase();
      avatarEl.setCssStyles({ background: this.plugin.settings.avatarBg });
      avatarEl.setCssStyles({ color: '#fff' });
    }
    this.tryUpgradeAvatarToImage(avatarEl, comment.author);

    header.createEl('span', { cls: 'ilc-entry-author', text: comment.author });
    if (comment.type !== 'reply') {
      const label = typeConfig?.label ?? builtinMeta?.label ?? comment.type;
      const chip = header.createEl('span', { cls: 'ilc-entry-chip', text: label });
      chip.setCssProps({ '--ilc-accent': this.typeAccent(comment.type) });
      chip.setAttribute('title', `${emoji} ${label}`);
    }
    header.createEl('span', { cls: 'ilc-entry-date',   text: comment.date });

    // ⋯ button (appears on hover)
    const moreBtn = header.createEl('button', { cls: 'ilc-more-btn ilc-entry-more-btn', text: '⋯' });
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showEntryMenu(e, ann, entryIndex, file); });

    if (comment.text) {
      const body = entry.createEl('div', { cls: 'ilc-entry-body' });
      this.renderCommentText(body, comment.text);
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

    // Unread state for replies from others: dot on avatar + "标为已读" action.
    // Click updates the DOM optimistically; persistence + recount run in background.
    const tracker = this.plugin.unreadTracker;
    if (comment.type === 'reply' && tracker?.isTrackable(comment.author)) {
      const readKey = computeReadKey(file.path, ann.highlightText, comment.author, comment.date, comment.text);
      if (!tracker.isRead(readKey)) {
        entry.addClass('ilc-entry-unread');
        const footer = entry.createEl('div', { cls: 'ilc-entry-footer' });
        const readBtn = footer.createEl('button', { cls: 'ilc-read-btn', text: '标为已读' });
        readBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          entry.removeClass('ilc-entry-unread');
          footer.remove();
          void tracker.markAsRead(readKey, file);
          this.updateHeader(file);
        });
      }
    }
  }

  // ── Rich text rendering for comment body ──────────────────────────────────────

  private renderCommentText(container: HTMLElement, text: string): void {
    // Match structured @mentions: [@Name](agent:id) or [@Name](agent:id?notify)
    const mentionRe = /\[@([^\]]+)\]\(agent:[^)]+\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionRe.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendText(text.slice(lastIndex, match.index));
      }
      const name = match[1];
      const isNotify = match[0].includes('?notify');
      const span = container.createEl('span', {
        cls: `ilc-mention${isNotify ? ' ilc-mention-notify' : ''}`,
        text: `@${name}`,
      });
      span.setAttribute('title', isNotify ? '通知此人' : '仅引用');
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      container.appendText(text.slice(lastIndex));
    }
  }

  // ── Avatar image upgrade ──────────────────────────────────────────────────────

  private async tryUpgradeAvatarToImage(avatarEl: HTMLElement, authorName: string): Promise<void> {
    const vaultPath = `_os/花名册形象/${authorName}.png`;
    try {
      const exists = await this.app.vault.adapter.exists(vaultPath);
      if (!exists) return;
      if (!avatarEl.isConnected) return;

      const url = this.app.vault.adapter.getResourcePath(vaultPath);
      const img = document.createElement('img');
      img.className = 'ilc-entry-avatar-img';
      img.src = url;
      img.alt = authorName;
      img.addEventListener('error', () => { img.remove(); });

      avatarEl.empty();
      avatarEl.appendChild(img);
      avatarEl.setCssStyles({ background: 'none' });
      avatarEl.setCssStyles({ color: 'transparent' });
    } catch {
      // Silently fall back to letter avatar
    }
  }

  // ── Delete helpers ────────────────────────────────────────────────────────────

  private showEntryMenu(e: MouseEvent, ann: Annotation, entryIndex: number, file: TFile): void {
    const menu = new Menu();
    const isOnly = ann.comments.length === 1;

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

  /**
   * The MarkdownView the user is actually looking at for the current file.
   * The same note is often open in several tabs; a background tab's editor has
   * no meaningful geometry, so prefer active → most-recent → visible → any.
   */
  private findMarkdownView(): MarkdownView | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    const matches = (v: unknown): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path;

    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && matches(active)) return active;
    const recent = this.app.workspace.getMostRecentLeaf()?.view;
    if (matches(recent)) return recent;

    const candidates = this.app.workspace.getLeavesOfType('markdown').map((l) => l.view).filter(matches);
    const visible = candidates.find((v) => v.containerEl.offsetParent !== null && v.containerEl.getBoundingClientRect().width > 0);
    return visible ?? candidates[0] ?? null;
  }

  /** Current CM6 EditorView for the file, or undefined */
  private currentCm(): EditorView | undefined {
    return (this.findMarkdownView() as any)?.editor?.cm as EditorView | undefined;
  }

  /** Adopt an editor instance: mirror its scroll position and re-measure every anchor */
  private alignWith(cm: EditorView): void {
    this.alignedCm = cm;
    this.syncingScroll = true;
    this.panelContainer.scrollTop = cm.scrollDOM.scrollTop;
    window.requestAnimationFrame(() => { this.syncingScroll = false; });
    this.computePositionsFromEditor();
    this.layoutCards();
    window.setTimeout(() => this.layoutCards(), 200);
  }

  /** Whether an editor instance is the one this panel is aligned with */
  isCurrentEditor(view?: EditorView): boolean {
    if (!view) return true;
    const cur = this.currentCm();
    return !cur || cur === view;
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
      window.setTimeout(() => card.removeClass('ilc-card-flash'), 600);
    }
  }
}
