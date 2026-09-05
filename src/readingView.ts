import type { MarkdownPostProcessorContext } from 'obsidian';
import { isResolved, parseAnnotations } from './parser.ts';

/**
 * Reading view: turn rendered `{==text==}{>>…<<}` runs into the same highlight
 * span + badge the editor shows, and hide the raw comment markup.
 *
 * Obsidian renders `==text==` inside the braces as a <mark>, and `[@x](agent:…)`
 * inside comment blocks as links, so the rendered text is not the source. We
 * therefore walk the rendered text nodes, match `{…}{>>…<<}` runs there, and pair
 * them in order with the annotations parsed from this section's source.
 */

export interface ReadingHost {
  onBadgeClick?(annotationId: string): void;
  highlightBg?(typeId: string): string | null;
}

const TYPE_CLASS: Record<string, string> = {
  agree: 'ilc-hl-agree', disagree: 'ilc-hl-disagree', question: 'ilc-hl-question',
  important: 'ilc-hl-important', note: 'ilc-hl-note',
};

/** `{…}` then one or more `{>>…<<}` blocks, in rendered text (the ==…== may be gone) */
const RENDERED_RE = /\{(?:==)?([^{}]+?)(?:==)?\}((?:\{>>[\s\S]+?<<\})+)/g;

export function readingPostProcessor(host: ReadingHost) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    if (!info.text.includes('{>>')) return;

    // Source annotations that start inside this section
    const lines = info.text.split('\n');
    const sectionStart = lines.slice(0, info.lineStart).reduce((n, l) => n + l.length + 1, 0);
    const sectionEnd = sectionStart + lines.slice(info.lineStart, info.lineEnd + 1).reduce((n, l) => n + l.length + 1, 0);
    const anns = parseAnnotations(info.text).filter((a) => a.from >= sectionStart && a.from < sectionEnd);
    if (anns.length === 0) return;

    // Rendered text, with a map from flat offsets back to text nodes
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const starts: number[] = [];
    let flat = '';
    let cur: Node | null;
    while ((cur = walker.nextNode())) {
      nodes.push(cur as Text);
      starts.push(flat.length);
      flat += (cur as Text).data;
    }
    const locate = (pos: number): [Text, number] | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (pos >= starts[i]) return [nodes[i], Math.min(pos - starts[i], nodes[i].data.length)];
      }
      return null;
    };

    const matches: Array<{ start: number; end: number; hl: string }> = [];
    RENDERED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RENDERED_RE.exec(flat)) !== null) matches.push({ start: m.index, end: m.index + m[0].length, hl: m[1] });
    const count = Math.min(matches.length, anns.length);

    // Replace from the back so earlier offsets stay valid
    for (let i = count - 1; i >= 0; i--) {
      const ann = anns[i];
      const mt = matches[i];
      const a = locate(mt.start);
      const b = locate(mt.end);
      if (!a || !b) continue;
      const range = document.createRange();
      range.setStart(a[0], a[1]);
      range.setEnd(b[0], b[1]);
      range.deleteContents();

      const firstType = ann.comments[0]?.type ?? 'note';
      const resolved = isResolved(ann);
      const span = createSpan({ cls: `ilc-highlight ${TYPE_CLASS[firstType] ?? 'ilc-hl-note'}${resolved ? ' ilc-hl-resolved' : ''}`, text: mt.hl });
      span.dataset.annId = ann.id;
      const bg = resolved ? null : host.highlightBg?.(firstType);
      if (bg) span.setCssProps({ '--ilc-hl-bg': bg });
      const badge = createSpan({ cls: 'ilc-badge', text: String(ann.comments.filter((c) => c.type !== 'resolve').length) });
      badge.title = `${ann.comments.length} 条评论 · 点击定位`;
      badge.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); host.onBadgeClick?.(ann.id); });
      const frag = document.createDocumentFragment();
      frag.append(span, badge);
      range.insertNode(frag);
    }
  };
}
