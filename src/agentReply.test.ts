import { describe, expect, it } from 'vitest';
import {
  buildAgentReplyPrompt,
  parseAtMention,
  verifyOnlyTargetAnnotationChanged,
} from './agentReply.ts';

describe('parseAtMention', () => {
  it('matches a registered Chinese agent name', () => {
    expect(parseAtMention('这里请 @回声 看一下', ['回声'])).toBe('回声');
  });

  it('returns null for an unregistered name', () => {
    expect(parseAtMention('这里请 @未知 看一下', ['回声'])).toBeNull();
  });

  it('returns the first registered mention', () => {
    expect(parseAtMention('@未注册 @Echo @回声', ['回声', 'Echo'])).toBe('Echo');
  });

  it('returns null when there is no mention', () => {
    expect(parseAtMention('这里没有点名', ['回声'])).toBeNull();
  });

  it('matches English, Chinese, and numeric names', () => {
    expect(parseAtMention('请 @Agent007 回复', ['Agent007', '回声2'])).toBe(
      'Agent007',
    );
    expect(parseAtMention('请 @回声2 回复', ['Agent007', '回声2'])).toBe(
      '回声2',
    );
  });
});

describe('buildAgentReplyPrompt', () => {
  it('contains the file path, agent name, and append-only instruction', () => {
    const prompt = buildAgentReplyPrompt({
      absolutePath: '/tmp/vault/note.md',
      agentName: '回声',
      highlightText: '关键句',
      existingComments: [{ author: 'user', type: 'question', text: '@回声?' }],
      date: '2026-07-08',
    });

    expect(prompt).toContain('/tmp/vault/note.md');
    expect(prompt).toContain('{>>回声|2026-07-08|reply: 你的回复<<}');
    expect(prompt).toContain('只追加不改其它任何字符');
  });
});

describe('verifyOnlyTargetAnnotationChanged', () => {
  it('accepts appending a reply to the target annotation only', () => {
    const before = 'a {==高亮==}{>>user|2026-07-08|question: @回声?<<} z';
    const from = before.indexOf('{==');
    const after =
      'a {==高亮==}{>>user|2026-07-08|question: @回声?<<}{>>回声|2026-07-08|reply: 已处理<<} z';

    expect(verifyOnlyTargetAnnotationChanged(before, after, from)).toEqual({
      onlyTargetChanged: true,
      appendedReply: true,
    });
  });

  it('rejects body changes outside the target annotation', () => {
    const before = 'a {==高亮==}{>>user|2026-07-08|question: @回声?<<} z';
    const from = before.indexOf('{==');
    const after =
      'changed {==高亮==}{>>user|2026-07-08|question: @回声?<<}{>>回声|2026-07-08|reply: 已处理<<} z';

    expect(verifyOnlyTargetAnnotationChanged(before, after, from)).toEqual({
      onlyTargetChanged: false,
      appendedReply: false,
    });
  });

  it('reports no appended reply when the target annotation is unchanged', () => {
    const before = 'a {==高亮==}{>>user|2026-07-08|question: @回声?<<} z';
    const from = before.indexOf('{==');

    expect(verifyOnlyTargetAnnotationChanged(before, before, from)).toEqual({
      onlyTargetChanged: true,
      appendedReply: false,
    });
  });
});
