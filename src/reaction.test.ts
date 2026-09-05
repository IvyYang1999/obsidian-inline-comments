import { describe, expect, it } from 'vitest';
import { deleteCommentEntry, parseAnnotations, parseReaction, toggleReaction } from './parser.ts';

const doc = '{==原文==}{>>yyt|2026-09-05|question: 问<<}{>>费宝|2026-09-05|reply: 答<<}';

describe('reactions', () => {
  it('parses "emoji #index"', () => {
    expect(parseReaction('👍 #1')).toEqual({ emoji: '👍', target: 1 });
    expect(parseReaction('nope')).toBeNull();
  });
  it('toggle adds then removes the same author+emoji+target', () => {
    const on = toggleReaction(doc, 0, 1, '👍', 'yyt', '2026-09-05');
    expect(on).toContain('{>>yyt|2026-09-05|react: 👍 #1<<}');
    const off = toggleReaction(on, 0, 1, '👍', 'yyt', '2026-09-06');
    expect(off).toBe(doc);
  });
  it('different author or emoji is a separate reaction', () => {
    const a = toggleReaction(doc, 0, 1, '👍', 'yyt', 'd');
    const b = toggleReaction(a, 0, 1, '👍', '费宝', 'd');
    const c = toggleReaction(b, 0, 1, '❤️', 'yyt', 'd');
    expect(parseAnnotations(c)[0].comments.filter((e) => e.type === 'react')).toHaveLength(3);
  });
  it('deleting an entry drops its reactions and renumbers later ones', () => {
    let d = toggleReaction(doc, 0, 0, '👍', 'a', 'd');   // on entry 0
    d = toggleReaction(d, 0, 1, '❤️', 'a', 'd');          // on entry 1
    const after = deleteCommentEntry(d, 0, 0);            // remove entry 0
    const reacts = parseAnnotations(after)[0].comments.filter((e) => e.type === 'react').map((e) => e.text);
    expect(reacts).toEqual(['❤️ #0']);
  });
});
