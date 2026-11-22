import { describe, expect, it } from 'vitest';
import { appendReply, parseAnnotations, editCommentEntry } from './parser.ts';

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
