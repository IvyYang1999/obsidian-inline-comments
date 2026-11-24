import { describe, expect, it } from 'vitest';
import { appendReply, parseAnnotations, editCommentEntry, findEntryAgain } from './parser.ts';

describe('appendReply', () => {
  it('escapes every comment delimiter pair in reply text', () => {
    const before = 'a {==高亮==}{>>user|2026-07-08|question: @回声?<<} z';
    const from = before.indexOf('{==');
    const after = appendReply(before, from, {
      author: '回声',
      date: '2026-07-08',
      type: 'reply',
      text: 'A << B << C and X >> Y >> Z',
    });

    expect(after).toContain('A ‹‹ B ‹‹ C and X ›› Y ›› Z');
    expect(parseAnnotations(after)[0].comments).toHaveLength(2);
    expect(parseAnnotations(after)[0].comments[1]).toMatchObject({
      author: '回声',
      type: 'reply',
      text: 'A ‹‹ B ‹‹ C and X ›› Y ›› Z',
    });
  });
});

describe('editCommentEntry', () => {
  it('replaces one entry text, keeping author/date/type and other entries', () => {
    const before = 'a {==高亮==}{>>alice|2026-07-08|question: old text<<}{>>bob|2026-07-09|reply: keep me<<} z';
    const from = before.indexOf('{==');
    const after = editCommentEntry(before, from, 0, 'new text');

    expect(after).toContain('{>>alice|2026-07-08|question: new text<<}');
    expect(after).toContain('{>>bob|2026-07-09|reply: keep me<<}');
    const comments = parseAnnotations(after)[0].comments;
    expect(comments[0]).toMatchObject({ author: 'alice', date: '2026-07-08', type: 'question', text: 'new text' });
    expect(comments[1]).toMatchObject({ author: 'bob', text: 'keep me' });
  });

  it('escapes delimiters in edited text so the block structure survives', () => {
    const before = 'x {==p==}{>>me|2026-01-01|note: before<<} y';
    const from = before.indexOf('{==');
    const after = editCommentEntry(before, from, 0, 'a << b >> c');

    expect(after).toContain('a ‹‹ b ›› c');
    const comments = parseAnnotations(after)[0].comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe('a ‹‹ b ›› c');
  });

  it('supports multiline edited text and trims surrounding whitespace', () => {
    const before = 'x {==p==}{>>me|2026-01-01|reply: old<<} y';
    const from = before.indexOf('{==');
    const after = editCommentEntry(before, from, 0, '  line one\n\nline two  ');
    const text = parseAnnotations(after)[0].comments[0].text;

    expect(text).toBe('line one\n\nline two');
  });

  it('leaves content unchanged for an out-of-range index', () => {
    const before = 'x {==p==}{>>me|2026-01-01|note: old<<} y';
    const from = before.indexOf('{==');
    expect(editCommentEntry(before, from, 5, 'nope')).toBe(before);
  });

  it('can edit an AI reply entry in place', () => {
    const before = 'x {==p==}{>>me|2026-01-01|note: question<<}{>>Session3|2026-01-01|reply: long one-liner<<} y';
    const from = before.indexOf('{==');
    const after = editCommentEntry(before, from, 1, 'short answer');
    const comments = parseAnnotations(after)[0].comments;

    expect(comments[1]).toMatchObject({ author: 'Session3', type: 'reply', text: 'short answer' });
    expect(comments[0].text).toBe('question');
  });
});

describe('findEntryAgain', () => {
  const note = 'a {==one==}{>>me|2026-01-01|note: first<<} b {==two==}{>>me|2026-01-02|question: why?<<} c';
  const was = (content: string, i: number, entryIndex = 0) => {
    const a = parseAnnotations(content)[i];
    return { annId: a.id, highlightText: a.highlightText, entryIndex, entry: { ...a.comments[entryIndex] } };
  };

  it('finds the same annotation when nothing moved', () => {
    const w = was(note, 1);
    expect(findEntryAgain(parseAnnotations(note), w)?.id).toBe(w.annId);
  });

  it('follows the entry when a reply above it shifts the offsets', () => {
    const w = was(note, 1);
    const first = parseAnnotations(note)[0];
    const after = appendReply(note, first.from, { author: 'Agent', date: '2026-01-03', type: 'reply', text: 'a longer reply' });
    const found = findEntryAgain(parseAnnotations(after), w);
    expect(found?.highlightText).toBe('two');
    expect(found?.id).not.toBe(w.annId);
  });

  it('still finds it after a reply lands in the same thread', () => {
    const w = was(note, 1);
    const ann = parseAnnotations(note)[1];
    const after = appendReply(note, ann.from, { author: 'Agent', date: '2026-01-03', type: 'reply', text: 'because' });
    expect(findEntryAgain(parseAnnotations(after), w)?.comments).toHaveLength(2);
  });

  it('gives up when the entry was changed or removed', () => {
    const w = was(note, 1);
    const ann = parseAnnotations(note)[1];
    expect(findEntryAgain(parseAnnotations(editCommentEntry(note, ann.from, 0, 'how?')), w)).toBeNull();
    expect(findEntryAgain(parseAnnotations('a {==one==}{>>me|2026-01-01|note: first<<} c'), w)).toBeNull();
  });

  it('does not guess between two identical entries that both moved', () => {
    const twin = 'x {==p==}{>>me|2026-01-01|note: same<<} y {==p==}{>>me|2026-01-01|note: same<<}';
    const w = { ...was(twin, 0), annId: 'ann-999' };
    expect(findEntryAgain(parseAnnotations(twin), w)).toBeNull();
  });
});
