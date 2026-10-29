import { describe, it, expect } from 'vitest';
import { localIsoDate } from './localDate.ts';

describe('localIsoDate', () => {
  it('uses the local calendar day, not the UTC one', () => {
    expect(localIsoDate(new Date(2026, 9, 29, 0, 30))).toBe('2026-10-29');
    expect(localIsoDate(new Date(2026, 9, 29, 23, 30))).toBe('2026-10-29');
  });
});
