import { describe, expect, it } from 'vitest';
import { applySuggestion, parseAnnotations, setEntryType } from './parser.ts';

const doc =
  '前文 {==cut prices hard==}{>>yyt|2026-09-05|question: 太冲了<<}{>>费宝|2026-09-05|suggest: reduce prices significantly<<} 后文';

describe('suggestions', () => {
  it('parses a suggest entry like any other type', () => {
    const [ann] = parseAnnotations(doc);
    expect(ann.comments[1]).toEqual({ author: '费宝', date: '2026-09-05', type: 'suggest', text: 'reduce prices significantly' });
  });

  it('accept swaps the passage and marks the entry accepted, in one string edit', () => {
    const [ann] = parseAnnotations(doc);
    const out = applySuggestion(doc, ann.from, 1);
    expect(out).toBe(
      '前文 {==reduce prices significantly==}{>>yyt|2026-09-05|question: 太冲了<<}{>>费宝|2026-09-05|accepted: reduce prices significantly<<} 后文',
    );
    const [after] = parseAnnotations(out);
    expect(after.highlightText).toBe('reduce prices significantly');
    expect(after.comments[1].type).toBe('accepted');
  });

  it('decline only relabels the entry', () => {
    const [ann] = parseAnnotations(doc);
    const out = setEntryType(doc, ann.from, 1, 'declined');
    expect(parseAnnotations(out)[0].highlightText).toBe('cut prices hard');
    expect(parseAnnotations(out)[0].comments[1].type).toBe('declined');
  });

  it('refuses to accept a non-suggestion or an already handled one', () => {
    const [ann] = parseAnnotations(doc);
    expect(applySuggestion(doc, ann.from, 0)).toBe(doc);
    const declined = setEntryType(doc, ann.from, 1, 'declined');
    expect(applySuggestion(declined, ann.from, 1)).toBe(declined);
  });

  it('leaves the document alone when the annotation is not found', () => {
    expect(applySuggestion(doc, 9999, 1)).toBe(doc);
    expect(setEntryType(doc, 9999, 1, 'declined')).toBe(doc);
  });
});
