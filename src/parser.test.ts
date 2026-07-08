import { describe, expect, it } from 'vitest';
import { appendReply, parseAnnotations } from './parser.ts';

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
