import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import { CardPrefs, cardKey } from './cardPrefs.ts';
import type { Annotation, CommentEntry } from './types.ts';

const c = (author: string, text: string, type: CommentEntry['type'] = 'note'): CommentEntry => ({ author, date: '2026-11-02', type, text });
const ann = (comments: CommentEntry[], highlightText = '原文', from = 10): Annotation => ({ id: `ann-${from}`, highlightText, comments, from, to: from + 40 });

describe('cardKey', () => {
  it('stays the same when replies arrive or the passage moves in the note', () => {
    const a = ann([c('Ivy', '看看这里')]);
    expect(cardKey(ann([c('Ivy', '看看这里'), c('助手', '好的', 'reply')], '原文', 500))).toBe(cardKey(a));
  });
  it('differs for another passage or another first comment', () => {
    const a = ann([c('Ivy', '看看这里')]);
    expect(cardKey(ann([c('Ivy', '看看这里')], '别的原文'))).not.toBe(cardKey(a));
    expect(cardKey(ann([c('Ivy', '换个说法')]))).not.toBe(cardKey(a));
  });
});

describe('CardPrefs', () => {
  it('remembers collapsed / hidden, clears with null, and writes them out', async () => {
    vi.useFakeTimers();
    const files = new Map<string, string>([['p/card-state.json', '{"x":"hidden","y":"bogus"}']]);
    const app = { vault: { adapter: {
      read: async (p: string) => files.get(p) ?? Promise.reject(new Error('missing')),
      write: async (p: string, s: string) => { files.set(p, s); },
    } } } as unknown as App;
    const prefs = new CardPrefs(app, 'p/card-state.json');
    await prefs.load();
    const a = ann([c('Ivy', '看看这里')]);
    expect(prefs.get(a)).toBeUndefined();
    prefs.set(a, 'collapsed');
    expect(prefs.get(ann([c('Ivy', '看看这里'), c('助手', '收到', 'reply')]))).toBe('collapsed');
    prefs.set(a, 'hidden');
    await vi.runAllTimersAsync();
    expect(JSON.parse(files.get('p/card-state.json')!)).toEqual({ x: 'hidden', [cardKey(a)]: 'hidden' });
    prefs.set(a, null);
    expect(prefs.get(a)).toBeUndefined();
    vi.useRealTimers();
  });
});
