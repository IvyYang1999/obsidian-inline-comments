import { t } from '../i18n.ts';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { isResolved, parseAnnotations } from '../parser.ts';
import type { Annotation } from '../types.ts';

// ─── Position data emitted to the panel ──────────────────────────────────────

export interface AnnotationPosition {
  annotationId: string;
  /** Y offset from the TOP of the editor's scroll container (not the viewport) */
  topInEditor: number;
  from: number;
}

// ─── Host interface ──────────────────────────────────────────────────────────

/** Callback interface to avoid circular import with main.ts */
export interface ICommentHost {
  /** `byPointer`: the user clicked into the passage (vs. moving the cursor with keys) */
  onEditorCursorInAnnotation(annotationId: string, view?: EditorView, byPointer?: boolean): void;
  onPositionsUpdated(positions: AnnotationPosition[], view?: EditorView): void;
  onEditorScroll(scrollTop: number, view?: EditorView): void;
  /** Badge after a highlight was clicked → reveal + focus the matching card */
  onBadgeClick?(annotationId: string): void;
  /**
   * Highlight background for a comment type, or null to use the built-in class.
   * User-defined types carry their colour inline instead of through an injected
   * stylesheet (plugins must not create `<style>` elements).
   */
  highlightBg?(typeId: string): string | null;
}

/** `--ilc-hl-bg: <colour>` as a decoration attribute, or nothing for built-ins */
function bgAttrs(bg: string | null | undefined): { style: string } | undefined {
  return bg ? { style: `--ilc-hl-bg: ${bg};` } : undefined;
}

// ─── Badge widget shown after each annotation ─────────────────────────────────

class CommentBadgeWidget extends WidgetType {
  constructor(
    private count: number,
    private annotationId: string,
    private onClick: (annotationId: string) => void,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'ilc-badge';
    el.textContent = String(this.count);
    el.dataset.annotationId = this.annotationId;
    el.title = t('{0} 条评论 · 点击定位', [this.count]);
    // Take the click ourselves: never let CodeMirror move the cursor into the markup
    el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick(this.annotationId);
    });
    return el;
  }

  eq(other: CommentBadgeWidget): boolean {
    return (
      this.count === other.count && this.annotationId === other.annotationId
    );
  }

  /** Mouse events are handled by the widget; everything else goes to the editor */
  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

// ─── Type → CSS class mapping ────────────────────────────────────────────────

const TYPE_CLASS: Record<string, string> = {
  agree:     'ilc-hl-agree',
  disagree:  'ilc-hl-disagree',
  question:  'ilc-hl-question',
  important: 'ilc-hl-important',
  note:      'ilc-hl-note',
};

function highlightClass(ann: Annotation): string {
  const firstType = ann.comments[0]?.type ?? 'note';
  return TYPE_CLASS[firstType] ?? 'ilc-hl-note';
}

// ─── Where each annotation's pieces sit ──────────────────────────────────────

interface AnnotationParts {
  ann: Annotation;
  /** After `{==` */
  hlStart: number;
  /** At the closing `==` */
  hlEnd: number;
  /** After `==` — the `}{>>...<<}` the badge replaces starts here */
  badgeStart: number;
  markupEnd: number;
}

/**
 * Annotations in document order, minus any that overlap the previous one (RangeSetBuilder
 * must never see overlapping replace ranges — one malformed/nested annotation would
 * otherwise throw and CM6 would disable every decoration in the file).
 */
function annotationParts(content: string): AnnotationParts[] {
  if (!content.includes('{>>')) return [];
  const anns = parseAnnotations(content).sort((a, b) => a.from - b.from);
  const out: AnnotationParts[] = [];
  let lastEnd = -1;
  for (const ann of anns) {
    if (ann.from < lastEnd) continue; // overlaps the previous annotation — skip, don't crash
    const eqIdx = content.slice(ann.from, ann.to).indexOf('==}');
    if (eqIdx < 0) continue;
    const hlStart = ann.from + 3; // skip {==
    const hlEnd = ann.from + eqIdx;
    const markupEnd = ann.to;
    if (hlEnd < hlStart || markupEnd < hlEnd) continue;
    out.push({ ann, hlStart, hlEnd, badgeStart: hlEnd + 2, markupEnd });
    lastEnd = markupEnd;
  }
  return out;
}

/**
 * A comment body may hold line breaks (a reply typed with Enter, an agent writing
 * paragraphs). CodeMirror refuses a replace decoration that hides a line break when it
 * comes from a view plugin — it throws and the note fails to open — so those badges come
 * from `multilineBadgeField` instead.
 */
function badgeCrossesLine(content: string, p: AnnotationParts): boolean {
  return content.slice(p.badgeStart, p.markupEnd).includes('\n');
}

function badgeWidget(ann: Annotation, onClick: (annotationId: string) => void): CommentBadgeWidget {
  return new CommentBadgeWidget(ann.comments.filter((c) => c.type !== 'resolve' && c.type !== 'react').length, ann.id, onClick);
}

// ─── Main ViewPlugin class ───────────────────────────────────────────────────

class CommentViewPlugin implements PluginValue {
  decorations: DecorationSet = Decoration.none;
  private scrollRAF = 0;
  private view: EditorView;
  private onScroll: () => void;

  constructor(
    view: EditorView,
    private host: ICommentHost,
  ) {
    this.view = view;
    this.decorations = this.buildDecorations(view);

    // Scroll listener on the editor's scroll container (throttled via rAF)
    this.onScroll = () => {
      if (this.scrollRAF) return;
      this.scrollRAF = window.requestAnimationFrame(() => {
        this.scrollRAF = 0;
        try {
          this.host.onEditorScroll(this.view.scrollDOM.scrollTop, this.view);
        } catch { /* panel may not be ready */ }
      });
    };
    try {
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    } catch { /* scrollDOM may not be ready */ }

    // Initial positions once CM has laid the document out
    this.requestPositions(view);
  }

  /**
   * Position reads go through `requestMeasure`: CodeMirror forbids `coordsAtPos`
   * during an update (it throws, and we used to swallow that — which made the
   * update() path a no-op). `key: this` merges a burst of requests into one read.
   */
  private requestPositions(view: EditorView): void {
    view.requestMeasure({
      key: this,
      read: (v) => { try { this.emitPositions(v); } catch { /* view torn down */ } },
    });
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
    }

    // Emit position updates when geometry or content changes
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.requestPositions(update.view);
    }

    // Cursor moved → notify panel to highlight corresponding card
    if (update.selectionSet) {
      const pos = update.state.selection.main.head;
      const content = update.state.doc.toString();
      const anns = parseAnnotations(content);
      const active = anns.find((a) => pos >= a.from && pos <= a.to);
      if (active) {
        const byPointer = update.transactions.some((tr) => tr.isUserEvent('select.pointer'));
        this.host.onEditorCursorInAnnotation(active.id, update.view, byPointer);
      }
    }
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    if (this.scrollRAF) {
      window.cancelAnimationFrame(this.scrollRAF);
    }
  }

  // ── Position emission ──────────────────────────────────────────────────────

  private emitPositions(view: EditorView): void {
    const content = view.state.doc.toString();
    const anns = parseAnnotations(content);
    const scrollerRect = view.scrollDOM.getBoundingClientRect();

    const positions: AnnotationPosition[] = [];
    // document-top → scroller coordinate base (for the out-of-viewport fallback)
    const docBase = view.documentTop - scrollerRect.top + view.scrollDOM.scrollTop;
    for (const ann of anns) {
      const hlStart = Math.min(ann.from + 3, view.state.doc.length); // skip {==
      const coords = view.coordsAtPos(hlStart);
      let topInEditor: number;
      if (coords) {
        topInEditor = coords.top - scrollerRect.top + view.scrollDOM.scrollTop;
      } else {
        // Not rendered (outside the CM6 viewport): use the height-map estimate
        topInEditor = view.lineBlockAt(hlStart).top + docBase;
      }
      positions.push({ annotationId: ann.id, topInEditor, from: ann.from });
    }

    this.host.onPositionsUpdated(positions, view);
  }

  // ── Decorations ────────────────────────────────────────────────────────────

  private buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const content = view.state.doc.toString();
    const onBadgeClick = (id: string) => {
      try { this.host.onBadgeClick?.(id); } catch { /* panel may not be ready */ }
    };

    for (const p of annotationParts(content)) {
      const { ann, hlStart, hlEnd, badgeStart, markupEnd } = p;
      const cls = highlightClass(ann) + (isResolved(ann) ? ' ilc-hl-resolved' : '');
      const bg = isResolved(ann) ? null : this.host.highlightBg?.(ann.comments[0]?.type ?? 'note');

      try {
        // 1. Hide the `{==` prefix
        builder.add(ann.from, hlStart, Decoration.replace({}));

        // 2. Mark the highlighted text with color
        if (hlStart < hlEnd) {
          builder.add(
            hlStart,
            hlEnd,
            Decoration.mark({ class: `ilc-highlight ${cls}`, attributes: bgAttrs(bg) }),
          );
        }

        // 3. Hide the closing `==` on its own, then replace `}{>>...<<}` with the
        // badge. Live preview hides that `==` too; a badge range overlapping it got
        // clipped by CM and then dropped on the next incremental redraw (Obsidian
        // 1.13: every badge after the edited line vanished after a reply).
        // A badge range that crosses a line break is left to `multilineBadgeField`.
        builder.add(hlEnd, badgeStart, Decoration.replace({}));
        if (badgeStart < markupEnd && !badgeCrossesLine(content, p)) {
          builder.add(badgeStart, markupEnd, Decoration.replace({ widget: badgeWidget(ann, onBadgeClick) }));
        }
      } catch {
        // malformed range — skip this annotation only
      }
    }

    return builder.finish();
  }
}

// ─── Draft range: temporary highlight while a comment is being written ───────

export interface DraftRange {
  from: number;
  to: number;
  /** CSS classes, e.g. "ilc-highlight ilc-hl-agree" */
  cls?: string;
  /** Inline highlight colour for user-defined types (built-ins use their class) */
  bg?: string | null;
}

/** Dispatch with `{ from, to }` to show the pending selection, `null` to clear */
export const setDraftRange = StateEffect.define<DraftRange | null>();


export const draftRangeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDraftRange)) {
        if (!e.value || e.value.to <= e.value.from) return Decoration.none;
        const to = Math.min(e.value.to, tr.newDoc.length);
        const mark = Decoration.mark({
          class: `ilc-draft-highlight ${e.value.cls ?? 'ilc-highlight ilc-hl-note'}`,
          attributes: bgAttrs(e.value.bg),
        });
        return Decoration.set([mark.range(Math.max(0, e.value.from), to)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ─── Badges for comments that span lines ─────────────────────────────────────

/** See `badgeCrossesLine`: only a state field may hide a line break */
function multilineBadgeField(host: ICommentHost) {
  const onBadgeClick = (id: string) => {
    try { host.onBadgeClick?.(id); } catch { /* panel may not be ready */ }
  };
  const build = (content: string): DecorationSet => {
    const ranges = annotationParts(content)
      .filter((p) => p.badgeStart < p.markupEnd && badgeCrossesLine(content, p))
      .map((p) => Decoration.replace({ widget: badgeWidget(p.ann, onBadgeClick) }).range(p.badgeStart, p.markupEnd));
    return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
  };
  return StateField.define<DecorationSet>({
    create: (state) => build(state.doc.toString()),
    update: (deco, tr) => (tr.docChanged ? build(tr.newDoc.toString()) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function buildCommentExtension(host: ICommentHost) {
  return [
    ViewPlugin.define(
      (view) => new CommentViewPlugin(view, host),
      { decorations: (v) => v.decorations },
    ),
    multilineBadgeField(host),
    draftRangeField,
  ];
}
