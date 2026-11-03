import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { ADD_COMMENT_COMMAND, SUGGESTED_HOTKEY, bindSuggestedHotkey, boundHotkeys, eventMatchesHotkey, formatHotkey, hotkeyConflict, sameHotkey } from './hotkeys.ts';

/** Minimal stand-in for Obsidian's internal hotkeyManager + command registry */
function fakeApp(custom: Record<string, unknown[]>, defaults: Record<string, unknown[]> = {}) {
  const saved: string[] = [];
  const app = {
    hotkeyManager: {
      getHotkeys: (id: string) => custom[id],
      getDefaultHotkeys: (id: string) => defaults[id],
      setHotkeys: (id: string, keys: unknown[]) => { custom[id] = keys; },
      save: () => { saved.push('x'); },
    },
    commands: { commands: Object.fromEntries([...Object.keys(custom), ...Object.keys(defaults), ADD_COMMENT_COMMAND].map((id) => [id, { name: `name of ${id}` }])) },
  };
  return { app: app as unknown as App, custom, saved };
}

describe('hotkeys', () => {
  it('formats per platform', () => {
    expect(formatHotkey(SUGGESTED_HOTKEY, true)).toBe('⌘⌥M');
    expect(formatHotkey(SUGGESTED_HOTKEY, false)).toBe('Ctrl+Alt+M');
    expect(formatHotkey({ modifiers: ['Alt', 'Ctrl'], key: 'm' }, true)).toBe('⌃⌥M');
  });

  it('compares modifiers regardless of order and key case', () => {
    expect(sameHotkey({ modifiers: ['Alt', 'Mod'], key: 'm' }, SUGGESTED_HOTKEY)).toBe(true);
    expect(sameHotkey({ modifiers: ['Mod'], key: 'M' }, SUGGESTED_HOTKEY)).toBe(false);
  });

  it('matches a key press to a hotkey per platform, letters by code (⌥M types µ on macOS)', () => {
    const press = (o: Partial<KeyboardEvent>) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    expect(eventMatchesHotkey(press({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true }), SUGGESTED_HOTKEY, true)).toBe(true);
    expect(eventMatchesHotkey(press({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true }), SUGGESTED_HOTKEY, false)).toBe(true);
    expect(eventMatchesHotkey(press({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true }), SUGGESTED_HOTKEY, true)).toBe(false);
    expect(eventMatchesHotkey(press({ key: 'M', code: 'KeyM', metaKey: true, altKey: true, shiftKey: true }), SUGGESTED_HOTKEY, true)).toBe(false);
    expect(eventMatchesHotkey(press({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true }), { modifiers: ['Mod', 'Shift'], key: 'K' }, true)).toBe(true);
    expect(eventMatchesHotkey(press({ key: 'F2', code: 'F2' }), { modifiers: [], key: 'F2' }, true)).toBe(true);
  });

  it('user keys win over defaults, and an empty custom list means unbound', () => {
    const { app } = fakeApp({ [ADD_COMMENT_COMMAND]: [] }, { [ADD_COMMENT_COMMAND]: [SUGGESTED_HOTKEY] });
    expect(boundHotkeys(app)).toEqual([]);
    expect(boundHotkeys(fakeApp({}, { [ADD_COMMENT_COMMAND]: [SUGGESTED_HOTKEY] }).app)).toEqual([SUGGESTED_HOTKEY]);
  });

  it('binds ⌘⌥M and saves when it is free', () => {
    const { app, custom, saved } = fakeApp({});
    expect(bindSuggestedHotkey(app)).toEqual({ ok: true });
    expect(custom[ADD_COMMENT_COMMAND]).toEqual([SUGGESTED_HOTKEY]);
    expect(saved.length).toBe(1);
  });

  it('refuses and names the command already holding ⌘⌥M', () => {
    const { app, custom } = fakeApp({ 'other:cmd': [{ modifiers: ['Alt', 'Mod'], key: 'm' }] });
    expect(hotkeyConflict(app, SUGGESTED_HOTKEY)).toBe('name of other:cmd');
    expect(bindSuggestedHotkey(app)).toEqual({ ok: false, conflict: 'name of other:cmd' });
    expect(custom[ADD_COMMENT_COMMAND]).toBeUndefined();
  });
});
