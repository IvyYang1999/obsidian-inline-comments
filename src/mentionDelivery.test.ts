import { describe, it, expect } from 'vitest';
import {
  MENTION_RE,
  buildLetter,
  isScannable,
  mentionKey,
  safeDocFragment,
  skipReason,
  type Candidate,
} from './mentionDelivery.ts';

const cand: Candidate = { name: '费宝', sessionId: '44444444-0000-1111-2222-333333333333', shortId: '44444444' };
const names = new Set(['费宝', '审计员']);

describe('MENTION_RE', () => {
  it('matches structured mentions only', () => {
    const text = '看看 [@费宝](agent:44444444?notify) 和 [@审计员](agent:22222222) 还有纯文本 @费宝';
    const ms = [...text.matchAll(MENTION_RE)].map((m) => [m[1], m[2], m[3] !== undefined]);
    expect(ms).toEqual([['费宝', '44444444', true], ['审计员', '22222222', false]]);
  });
});

describe('skipReason (mirrors the python scanner)', () => {
  const m = { name: '费宝', shortId: '44444444', notify: true };
  it('delivers a human question with ?notify', () => {
    expect(skipReason(m, { author: 'yyt', type: 'question' }, cand, names)).toBeNull();
  });
  it('delivers a human reply (yyt writing in the reply box)', () => {
    expect(skipReason(m, { author: 'yyt', type: 'reply' }, cand, names)).toBeNull();
  });
  it('skips when no candidate matches the short id', () => {
    expect(skipReason(m, { author: 'yyt', type: 'note' }, undefined, names)).toMatch(/无匹配/);
  });
  it('skips reference-only mentions (no ?notify)', () => {
    expect(skipReason({ ...m, notify: false }, { author: 'yyt', type: 'note' }, cand, names)).toMatch(/notify/);
  });
  it('skips self-mention', () => {
    expect(skipReason(m, { author: '费宝', type: 'note' }, cand, names)).toMatch(/自己/);
  });
  it('skips replies written by a registered agent (no self-trigger loops)', () => {
    expect(skipReason(m, { author: '审计员', type: 'reply' }, cand, names)).toMatch(/Agent/);
  });
});

describe('mentionKey', () => {
  it('is the sha1 of path+highlight+content+shortId, stable across runs', async () => {
    const a = await mentionKey('a/b.md', 'hl', 'content [@费宝](agent:44444444?notify)', '44444444');
    const b = await mentionKey('a/b.md', 'hl', 'content [@费宝](agent:44444444?notify)', '44444444');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    const c = await mentionKey('a/b.md', 'hl', 'other', '44444444');
    expect(c).not.toBe(a);
  });
});

describe('buildLetter', () => {
  it('writes the mailbox frontmatter contract', () => {
    const now = new Date(2026, 8, 3, 9, 5);
    const letter = buildLetter(cand.sessionId, '项目/x.md', '今天入职', '欢迎 [@费宝](agent:44444444?notify)', 'yyt', '2026-07-13', now);
    expect(letter.startsWith('---\nfrom: comment-scanner\nto: 44444444-0000-1111-2222-333333333333\nurgency: 普通\nwake: true\nstatus: 未读\ncreated: 2026-09-03 09:05\n---\n')).toBe(true);
    expect(letter).toContain('- 文档：项目/x.md');
    expect(letter).toContain('- 划线原文：今天入职');
    expect(letter).toContain('- 留言者：yyt｜2026-07-13');
    expect(letter).toContain('{>>你的花名|2026-09-03|reply: 内容<<}');
  });
});

describe('isScannable / safeDocFragment', () => {
  it('skips technical dirs, archived collab space and the mailbox itself', () => {
    expect(isScannable('笔记/a.md', 'Agent协作空间/信箱')).toBe(true);
    expect(isScannable('.obsidian/plugins/x.md', 'Agent协作空间/信箱')).toBe(false);
    expect(isScannable('Agent协作空间/归档/old.md', 'Agent协作空间/信箱')).toBe(false);
    expect(isScannable('Agent协作空间/信箱/44444444/letter.md', 'Agent协作空间/信箱')).toBe(false);
    expect(isScannable('Agent协作空间/例会/2026-07-13.md', 'Agent协作空间/信箱')).toBe(true);
    expect(isScannable('x.txt', 'Agent协作空间/信箱')).toBe(false);
  });
  it('sanitises the document fragment like the python scanner', () => {
    expect(safeDocFragment('归档/Agent协作空间/例会/2026-07-13.md')).toBe('2026-07-13');
    expect(safeDocFragment('a/very:long*file?name-with-many-chars-1234567890.md')).toBe('very_long_file_name-');
    expect(safeDocFragment('a/.md')).toBe('未命名文档');
  });
});
