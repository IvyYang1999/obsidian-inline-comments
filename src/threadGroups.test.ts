import { describe, it, expect } from 'vitest';
import { countUnreadRuns, runHeads } from './threadGroups.ts';

const e = (author: string, type = 'reply', date = '2026-10-29') => ({ author, type, date });

describe('runHeads', () => {
  it('folds consecutive replies by one author on one day into one run', () => {
    expect(runHeads([e('yyt', 'question'), e('助理'), e('助理'), e('yyt'), e('助理')])).toEqual([0, 1, 1, 3, 4]);
  });
  it('keeps a new header for typed entries, another day, or another author', () => {
    expect(runHeads([e('助理'), e('助理', 'suggest'), e('助理', 'reply', '2026-10-30'), e('Ivy')])).toEqual([0, 1, 2, 3]);
  });
  it('looks through reaction and resolve markers', () => {
    expect(runHeads([e('助理'), e('yyt', 'react'), e('助理')])).toEqual([0, 1, 0]);
  });
  it('matches authors case-insensitively', () => {
    expect(runHeads([e('Bot'), e('bot')])).toEqual([0, 0]);
  });
});

it('countUnreadRuns counts a run once', () => {
  const thread = [e('yyt', 'question'), e('助理'), e('助理'), e('yyt'), e('助理')];
  expect(countUnreadRuns(thread, (i) => thread[i].author === '助理')).toBe(2);
  expect(countUnreadRuns(thread, (i) => i === 2)).toBe(1);
  expect(countUnreadRuns(thread, () => false)).toBe(0);
});
