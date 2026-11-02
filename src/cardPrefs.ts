/**
 * Per-comment display choices: a card the user folded down to one line, or hid from
 * the panel until they click its passage in the note again. Kept in the plugin folder
 * (`card-state.json`), not in the note — it is how this reader looks at the comments.
 */
import type { App } from 'obsidian';
import type { Annotation } from './types.ts';
import { computeReadKey } from './unreadTracker.ts';

export type CardState = 'collapsed' | 'hidden';

/**
 * Which comment thread a card is, wherever it sits: its passage and its first comment.
 * Replies, edits elsewhere in the note, renames and moves all keep the key.
 */
export function cardKey(ann: Pick<Annotation, 'highlightText' | 'comments'>): string {
  const first = ann.comments[0];
  return computeReadKey('', ann.highlightText, first?.author ?? '', first?.date ?? '', first?.text ?? '');
}

export class CardPrefs {
  private states = new Map<string, CardState>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private app: App, private path: string) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await this.app.vault.adapter.read(this.path)) as Record<string, unknown>;
      for (const [key, state] of Object.entries(data)) {
        if (state === 'collapsed' || state === 'hidden') this.states.set(key, state);
      }
    } catch {
      this.states.clear();
    }
  }

  get(ann: Pick<Annotation, 'highlightText' | 'comments'>): CardState | undefined {
    return this.states.get(cardKey(ann));
  }

  /** null puts the card back to normal */
  set(ann: Pick<Annotation, 'highlightText' | 'comments'>, state: CardState | null): void {
    const key = cardKey(ann);
    if (state) this.states.set(key, state);
    else this.states.delete(key);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.app.vault.adapter.write(this.path, JSON.stringify(Object.fromEntries(this.states), null, 2)).catch(() => {});
    }, 300);
  }
}
