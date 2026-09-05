import type { Annotation, CommentEntry, CommentType } from './types.ts';

/**
 * Matches a full annotation: {==text==} followed by one or more {>>...<<} blocks.
 * Group 1: highlight text
 * Group 2: all comment blocks concatenated (we re-match below)
 */
const FULL_RE =
  /\{==([\s\S]+?)==\}((?:\{>>[\s\S]+?<<\})+)/g;

/** Matches a single comment block */
const BLOCK_RE = /\{>>([\s\S]+?)<<\}/g;

/**
 * Parses a comment block body: "author|date|type: text"
 * Falls back to type=note if format doesn't match.
 */
function parseMeta(raw: string): CommentEntry {
  const m = raw.match(/^([^|]+)\|([^|]+)\|([^:]+):\s*([\s\S]*)$/);
  if (m) {
    return {
      author: m[1].trim(),
      date:   m[2].trim(),
      type:   m[3].trim() as CommentType,
      text:   m[4].trim(),
    };
  }
  // Legacy fallback: "author|date: text"
  const m2 = raw.match(/^([^|]+)\|([^:]+):\s*([\s\S]*)$/);
  if (m2) {
    return {
      author: m2[1].trim(),
      date:   m2[2].trim(),
      type:   'note',
      text:   m2[3].trim(),
    };
  }
  return { author: 'unknown', date: '', type: 'note', text: raw.trim() };
}

/** Parse all annotations from raw document content */
export function parseAnnotations(content: string): Annotation[] {
  const results: Annotation[] = [];
  let m: RegExpExecArray | null;
  FULL_RE.lastIndex = 0;

  while ((m = FULL_RE.exec(content)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    const highlightText = m[1];
    const allBlocks = m[2];

    const comments: CommentEntry[] = [];
    let bm: RegExpExecArray | null;
    BLOCK_RE.lastIndex = 0;
    while ((bm = BLOCK_RE.exec(allBlocks)) !== null) {
      comments.push(parseMeta(bm[1]));
    }

    results.push({
      id: `ann-${from}`,
      highlightText,
      comments,
      from,
      to,
    });
  }

  return results;
}

/** Build the raw markup string for a new annotation */
export function buildAnnotationMarkup(
  highlightText: string,
  comments: CommentEntry[],
): string {
  const blocks = comments
    .map(
      (c) =>
        `{>>${c.author}|${c.date}|${c.type}: ${escapeBody(c.text)}<<}`,
    )
    .join('');
  return `{==${highlightText}==}${blocks}`;
}

/**
 * Append a reply comment block to the annotation that starts at `annotationFrom`.
 * Returns the modified content string.
 */
export function appendReply(
  content: string,
  annotationFrom: number,
  reply: CommentEntry,
): string {
  // Re-find the annotation at the given position
  FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_RE.exec(content)) !== null) {
    if (m.index === annotationFrom) {
      const insertPos = m.index + m[0].length;
      const block = `{>>${reply.author}|${reply.date}|${reply.type}: ${escapeBody(reply.text)}<<}`;
      return content.slice(0, insertPos) + block + content.slice(insertPos);
    }
  }
  return content; // annotation not found, return unchanged
}

/** Escape `<<` and `>>` inside a comment body to prevent parser confusion */
function escapeBody(text: string): string {
  return text.replace(/<</g, '‹‹').replace(/>>/g, '››');
}

/**
 * Remove an entire annotation from the document,
 * leaving only the plain highlighted text in its place.
 */
export function deleteAnnotation(content: string, annotationFrom: number): string {
  FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_RE.exec(content)) !== null) {
    if (m.index === annotationFrom) {
      return content.slice(0, m.index) + m[1] + content.slice(m.index + m[0].length);
    }
  }
  return content;
}

/**
 * Remove one comment entry block (by zero-based index) from an annotation.
 * If the deleted entry was the last one, the whole annotation is converted
 * back to plain text.
 */
export function deleteCommentEntry(
  content: string,
  annotationFrom: number,
  entryIndex: number,
): string {
  FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_RE.exec(content)) !== null) {
    if (m.index !== annotationFrom) continue;

    // Collect individual {>>...<<} blocks using a local regex to avoid state issues
    const blocks: string[] = [];
    const blockRe = /\{>>[\s\S]+?<<\}/g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(m[2])) !== null) {
      blocks.push(bm[0]);
    }

    if (entryIndex < 0 || entryIndex >= blocks.length) return content;
    blocks.splice(entryIndex, 1);

    if (blocks.length === 0) {
      // Last entry removed → restore plain text
      return content.slice(0, m.index) + m[1] + content.slice(m.index + m[0].length);
    }

    const newAnnotation = `{==${m[1]}==}${blocks.join('')}`;
    return content.slice(0, m.index) + newAnnotation + content.slice(m.index + m[0].length);
  }
  return content;
}

/** A thread is resolved when its last entry is a `resolve` marker (reopen = delete it) */
export function isResolved(ann: Annotation): boolean {
  const last = ann.comments[ann.comments.length - 1];
  return last?.type === 'resolve';
}

// ─── Suggestions ────────────────────────────────────────────────────────────────
// A `suggest` entry carries replacement text for the highlighted passage. Accepting
// swaps the passage and marks the entry `accepted`; declining marks it `declined`.
// Both are single string edits so the editor sees one undoable change.

/** Rebuild one annotation with a per-block transform; returns null if not found */
function rewriteAnnotation(
  content: string,
  annotationFrom: number,
  fn: (highlight: string, blocks: string[]) => { highlight: string; blocks: string[] } | null,
): string | null {
  FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_RE.exec(content)) !== null) {
    if (m.index !== annotationFrom) continue;
    const blocks: string[] = [];
    const blockRe = /\{>>[\s\S]+?<<\}/g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(m[2])) !== null) blocks.push(bm[0]);
    const out = fn(m[1], blocks);
    if (!out) return null;
    const rebuilt = `{==${out.highlight}==}${out.blocks.join('')}`;
    return content.slice(0, m.index) + rebuilt + content.slice(m.index + m[0].length);
  }
  return null;
}

/** Change the type of one entry (e.g. suggest → declined) */
export function setEntryType(
  content: string,
  annotationFrom: number,
  entryIndex: number,
  newType: CommentType,
): string {
  const out = rewriteAnnotation(content, annotationFrom, (highlight, blocks) => {
    const raw = blocks[entryIndex];
    if (!raw) return null;
    const next = raw.replace(/^\{>>([^|]+)\|([^|]+)\|[^:]+:/, (_s, a, d) => `{>>${a}|${d}|${newType}:`);
    if (next === raw) return null;
    blocks[entryIndex] = next;
    return { highlight, blocks };
  });
  return out ?? content;
}

/**
 * Apply a suggestion: the highlighted passage becomes the entry's text and the
 * entry is marked `accepted`. Returns the content unchanged when the entry is not
 * a pending suggestion.
 */
export function applySuggestion(content: string, annotationFrom: number, entryIndex: number): string {
  const out = rewriteAnnotation(content, annotationFrom, (_highlight, blocks) => {
    const raw = blocks[entryIndex];
    if (!raw) return null;
    const meta = parseMeta(raw.slice(3, -3));
    if (meta.type !== 'suggest' || !meta.text) return null;
    blocks[entryIndex] = `{>>${meta.author}|${meta.date}|accepted: ${escapeBody(meta.text)}<<}`;
    return { highlight: meta.text, blocks };
  });
  return out ?? content;
}
