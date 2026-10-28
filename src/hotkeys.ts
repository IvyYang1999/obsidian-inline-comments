/**
 * Hotkey for 添加划线评论. Obsidian's plugin guidelines forbid shipping a default
 * hotkey, so the command starts unbound. The UI shows whatever the user bound and
 * offers a one-click ⌘⇧K that is saved as the user's own binding.
 *
 * `hotkeyManager` and `setting` are internal Obsidian APIs: every access is
 * guarded and degrades to "not bound" / "could not open".
 */
import type { App, Hotkey, Modifier } from 'obsidian';

export const ADD_COMMENT_COMMAND = 'inline-comments:add-inline-comment';
export const SUGGESTED_HOTKEY: Hotkey = { modifiers: ['Mod', 'Shift'], key: 'K' };

interface HotkeyManagerLike {
  getHotkeys?(id: string): Hotkey[] | undefined;
  getDefaultHotkeys?(id: string): Hotkey[] | undefined;
  setHotkeys?(id: string, keys: Hotkey[]): void;
  save?(): unknown;
}
interface HotkeyTabLike {
  setQuery?(q: string): void;
  searchComponent?: { setValue(v: string): unknown };
  updateHotkeyVisibility?(): void;
}
interface Internals {
  hotkeyManager?: HotkeyManagerLike;
  setting?: { open(): void; openTabById(id: string): HotkeyTabLike | undefined };
  commands?: { commands?: Record<string, { name?: string }> };
}
const internals = (app: App) => app as unknown as Internals;

/** What the user has bound to a command (their own keys win; otherwise its defaults) */
export function boundHotkeys(app: App, id = ADD_COMMENT_COMMAND): Hotkey[] {
  try {
    const hm = internals(app).hotkeyManager;
    return hm?.getHotkeys?.(id) ?? hm?.getDefaultHotkeys?.(id) ?? [];
  } catch {
    return [];
  }
}

// ⌘ first, as the plugin has always written it (⌘⇧K)
const MAC_ORDER: Modifier[] = ['Mod', 'Meta', 'Ctrl', 'Alt', 'Shift'];
const MAC_SYMBOL: Record<Modifier, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘', Meta: '⌘' };
const PC_ORDER: Modifier[] = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];
const PC_NAME: Record<Modifier, string> = { Mod: 'Ctrl', Ctrl: 'Ctrl', Meta: 'Win', Alt: 'Alt', Shift: 'Shift' };

/** ⌘⇧K on macOS, Ctrl+Shift+K elsewhere */
export function formatHotkey(h: Hotkey, mac: boolean): string {
  const key = h.key.length === 1 ? h.key.toUpperCase() : h.key;
  if (mac) return [...new Set(MAC_ORDER.filter((m) => h.modifiers.includes(m)).map((m) => MAC_SYMBOL[m]))].join('') + key;
  return [...new Set(PC_ORDER.filter((m) => h.modifiers.includes(m)).map((m) => PC_NAME[m])), key].join('+');
}

export function sameHotkey(a: Hotkey, b: Hotkey): boolean {
  const mods = (h: Hotkey) => [...h.modifiers].sort().join('+');
  return a.key.toUpperCase() === b.key.toUpperCase() && mods(a) === mods(b);
}

/** Name of another command already using this hotkey, if any */
export function hotkeyConflict(app: App, hotkey: Hotkey, except = ADD_COMMENT_COMMAND): string | null {
  const commands = internals(app).commands?.commands ?? {};
  for (const [id, cmd] of Object.entries(commands)) {
    if (id === except) continue;
    if (boundHotkeys(app, id).some((h) => sameHotkey(h, hotkey))) return cmd.name ?? id;
  }
  return null;
}

/** Bind ⌘⇧K for the user. Refuses (and names the command) when it is already taken. */
export function bindSuggestedHotkey(app: App): { ok: true } | { ok: false; conflict?: string } {
  const hm = internals(app).hotkeyManager;
  if (!hm?.setHotkeys) return { ok: false };
  const conflict = hotkeyConflict(app, SUGGESTED_HOTKEY);
  if (conflict) return { ok: false, conflict };
  try {
    hm.setHotkeys(ADD_COMMENT_COMMAND, [SUGGESTED_HOTKEY]);
    void hm.save?.();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Open Settings → Hotkeys filtered to `query`. Returns false when Obsidian's internals are missing. */
export function openHotkeySettings(app: App, query: string): boolean {
  const setting = internals(app).setting;
  if (!setting) return false;
  try {
    setting.open();
    const tab = setting.openTabById('hotkeys');
    if (tab?.setQuery) tab.setQuery(query);
    else {
      tab?.searchComponent?.setValue(query);
      tab?.updateHotkeyVisibility?.();
    }
    return true;
  } catch {
    return false;
  }
}
