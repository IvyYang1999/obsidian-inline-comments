import { t } from './i18n.ts';
import type { MarkdownPostProcessorContext } from 'obsidian';
import { isResolved, parseAnnotations } from './parser.ts';
import type { Annotation } from './types.ts';

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

/*
 * A comment body with a blank line or a list in it ends up in several Markdown
 * sections, and Obsidian hands us one section at a time. The section where it starts
 * gets the highlight + badge in place of everything from `{>>` on (SPILL_RE), sections
 * wholly inside the comment are hidden, and the section where it ends loses the text up
 * to its last `<<}` (TAIL_RE).
 */
const SPILL_RE = /\{(?:==)?([^{}]+?)(?:==)?\}\{>>[\s\S]*$/;
const TAIL_RE = /^[\s\S]*?<<\}(?:\{>>[\s\S]*?<<\})*/;

/** Source offset where an annotation's comment blocks start (just after `==}`), or -1 */
function commentStart(text: string, ann: Annotation): number {
  const i = text.slice(ann.from, ann.to).indexOf('==}');
  return i < 0 ? -1 : ann.from + i + 3;
}

export function readingPostProcessor(host: ReadingHost) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    if (!info.text.includes('{>>')) return;

    // This section's source range: [sectionStart, contentEnd] (contentEnd = end of its last line)
    const lines = info.text.split('\n');
    const sectionStart = lines.slice(0, info.lineStart).reduce((n, l) => n + l.length + 1, 0);
    const contentEnd = sectionStart + lines.slice(info.lineStart, info.lineEnd + 1).reduce((n, l) => n + l.length + 1, 0) - 1;
    const all = parseAnnotations(info.text);
    const spans = all.map((a) => ({ a, cs: commentStart(info.text, a) })).filter((x) => x.cs >= 0);

    if (spans.some(({ a, cs }) => cs <= sectionStart && a.to > contentEnd)) {
      el.addClass('ilc-hidden'); // wholly inside one comment
      return;
    }
    const tail = spans.find(({ a, cs }) => cs <= sectionStart && a.to > sectionStart && a.to <= contentEnd)?.a;
    const spill = spans.find(({ a, cs }) => a.from >= sectionStart && cs <= contentEnd && a.to > contentEnd)?.a;
    // Source annotations that start inside this section and end in it
    const anns = all.filter((a) => a.from >= sectionStart && a.from <= contentEnd && a !== spill);
    if (anns.length === 0 && !tail && !spill) return;

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

    // The end of a comment that began in an earlier section
    const tailEnd = tail ? (TAIL_RE.exec(flat)?.[0].length ?? 0) : 0;

    const matches: Array<{ start: number; end: number; hl: string }> = [];
    RENDERED_RE.lastIndex = tailEnd;
    let m: RegExpExecArray | null;
    while ((m = RENDERED_RE.exec(flat)) !== null) matches.push({ start: m.index, end: m.index + m[0].length, hl: m[1] });
    const count = Math.min(matches.length, anns.length);

    // A comment that starts here and runs on into later sections
    let spillAt: { start: number; hl: string } | null = null;
    if (spill) {
      const from = count > 0 ? matches[count - 1].end : tailEnd;
      const sm = SPILL_RE.exec(flat.slice(from));
      if (sm) spillAt = { start: from + sm.index, hl: sm[1] };
    }

    /** Swap rendered text [start, end) for the highlight + badge (or nothing) */
    const replace = (start: number, end: number, ann?: Annotation, hl?: string): void => {
      const a = locate(start);
      const b = locate(end);
      if (!a || !b) return;
      const range = document.createRange();
      range.setStart(a[0], a[1]);
      range.setEnd(b[0], b[1]);
      range.deleteContents();
      if (ann && hl !== undefined) range.insertNode(highlightWithBadge(host, ann, hl));
    };

    // Replace from the back so earlier offsets stay valid
    if (spill && spillAt) replace(spillAt.start, flat.length, spill, spillAt.hl);
    for (let i = count - 1; i >= 0; i--) replace(matches[i].start, matches[i].end, anns[i], matches[i].hl);
    if (tailEnd > 0) {
      replace(0, tailEnd);
      // Paragraphs and list items that held only comment text are now empty
      for (const blk of Array.from(el.querySelectorAll('p, li')).reverse()) {
        if (!blk.textContent?.trim() && !blk.querySelector('img, input, .ilc-badge')) blk.remove();
      }
      for (const list of Array.from(el.querySelectorAll('ul, ol'))) if (!list.querySelector('li')) list.remove();
      if (!el.textContent?.trim()) el.addClass('ilc-hidden');
    }
  };
}

function highlightWithBadge(host: ReadingHost, ann: Annotation, hl: string): DocumentFragment {
  const firstType = ann.comments[0]?.type ?? 'note';
  const resolved = isResolved(ann);
  const span = createSpan({ cls: `ilc-highlight ${TYPE_CLASS[firstType] ?? 'ilc-hl-note'}${resolved ? ' ilc-hl-resolved' : ''}`, text: hl });
  span.dataset.annId = ann.id;
  const bg = resolved ? null : host.highlightBg?.(firstType);
  if (bg) span.setCssProps({ '--ilc-hl-bg': bg });
  // Clicking the passage itself (not selecting in it) focuses its card, like the badge
  span.addEventListener('click', () => { if (!window.getSelection()?.toString()) host.onBadgeClick?.(ann.id); });
  const badge = createSpan({ cls: 'ilc-badge', text: String(ann.comments.filter((c) => c.type !== 'resolve' && c.type !== 'react').length) });
  badge.title = t('{0} 条评论 · 点击定位', [ann.comments.length]);
  badge.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); host.onBadgeClick?.(ann.id); });
  const frag = document.createDocumentFragment();
  frag.append(span, badge);
  return frag;
}
