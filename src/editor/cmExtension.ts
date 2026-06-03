import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { parseAnnotations } from '../parser.ts';
import type { Annotation } from '../types.ts';

/** Callback interface to avoid circular import with main.ts */
export interface ICommentHost {
  onEditorCursorInAnnotation(annotationId: string): void;
}

// ─── Badge widget shown after each annotation ─────────────────────────────────

class CommentBadgeWidget extends WidgetType {
  constructor(
    private count: number,
    private annotationId: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'ilc-badge';
    el.textContent = String(this.count);
    el.dataset.annotationId = this.annotationId;
    el.title = `${this.count} 条评论`;
    return el;
  }

  eq(other: CommentBadgeWidget): boolean {
    return (
      this.count === other.count && this.annotationId === other.annotationId
    );
  }

  ignoreEvent(): boolean {
    return false;
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

// ─── Main ViewPlugin class ───────────────────────────────────────────────────

class CommentViewPlugin implements PluginValue {
  decorations: DecorationSet = Decoration.none;

  constructor(
    view: EditorView,
    private host: ICommentHost,
  ) {
    this.decorations = this.buildDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
    }

    // Cursor moved → notify panel to highlight corresponding card
    if (update.selectionSet) {
      const pos = update.state.selection.main.head;
      const content = update.state.doc.toString();
      const anns = parseAnnotations(content);
      const active = anns.find((a) => pos >= a.from && pos <= a.to);
      if (active) {
        this.host.onEditorCursorInAnnotation(active.id);
      }
    }
  }

  private buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const content = view.state.doc.toString();
    const anns = parseAnnotations(content);

    // RangeSetBuilder requires ranges to be added in document order
    anns.sort((a, b) => a.from - b.from);

    for (const ann of anns) {
      const raw = content.slice(ann.from, ann.to);

      const hlStart    = ann.from + 3;                         // skip {==
      const eqIdx      = raw.indexOf('==}');
      if (eqIdx < 0) continue;
      const hlEnd      = ann.from + eqIdx;                     // end of highlight text
      const markupEnd  = ann.to;

      const cls = highlightClass(ann);

      // 1. Hide the `{==` prefix
      builder.add(ann.from, hlStart, Decoration.replace({}));

      // 2. Mark the highlighted text with color
      if (hlStart < hlEnd) {
        builder.add(
          hlStart,
          hlEnd,
          Decoration.mark({ class: `ilc-highlight ${cls}` }),
        );
      }

      // 3. Replace `==}{>>...<<}` with badge widget
      if (hlEnd < markupEnd) {
        builder.add(
          hlEnd,
          markupEnd,
          Decoration.replace({
            widget: new CommentBadgeWidget(ann.comments.length, ann.id),
          }),
        );
      }
    }

    return builder.finish();
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function buildCommentExtension(host: ICommentHost) {
  return ViewPlugin.define(
    (view) => new CommentViewPlugin(view, host),
    { decorations: (v) => v.decorations },
  );
}
