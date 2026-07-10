import type { App } from 'obsidian';
import { parseAnnotations } from './parser.ts';

interface ReadState {
  read: string[];
}

interface UnreadDoc {
  path: string;
  unread: number;
}

interface UnreadJson {
  generatedAt: string;
  docs: UnreadDoc[];
}

/** Stable 64-bit FNV-1a hash → 16 hex chars */
export function computeReadKey(
  path: string,
  highlightText: string,
  author: string,
  date: string,
  text: string,
): string {
  const input = `${path}\0${highlightText}\0${author}\0${date}\0${text}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Tracks read/unread state for reply-type comments.
 * Persists read keys to `read-state.json` and produces `unread-replies.json`
 * for the directory-tree badge plugin to consume.
 */
export class UnreadTracker {
  private readSet = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private app: App,
    private pluginDir: string,
    private enabled: () => boolean,
  ) {}

  private get readStatePath(): string {
    return `${this.pluginDir}/read-state.json`;
  }

  private get unreadJsonPath(): string {
    return `${this.pluginDir}/unread-replies.json`;
  }

  async init(): Promise<void> {
    await this.loadReadState();
    await this.recompute();
  }

  private async loadReadState(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.readStatePath);
      const state = JSON.parse(raw) as ReadState;
      this.readSet = new Set(state.read ?? []);
    } catch {
      this.readSet = new Set();
    }
  }

  private async saveReadState(): Promise<void> {
    const state: ReadState = { read: [...this.readSet] };
    await this.app.vault.adapter.write(
      this.readStatePath,
      JSON.stringify(state, null, 2),
    );
  }

  isRead(readKey: string): boolean {
    return this.readSet.has(readKey);
  }

  async markAsRead(readKey: string): Promise<void> {
    this.readSet.add(readKey);
    await this.saveReadState();
    await this.recompute();
  }

  /** Debounced recompute — call on vault modify events */
  scheduleRecompute(): void {
    if (!this.enabled()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.recompute();
    }, 2000);
  }

  /** Scan all markdown files, count unread replies, write unread-replies.json */
  async recompute(): Promise<void> {
    if (!this.enabled()) return;

    const files = this.app.vault.getMarkdownFiles();
    const docs: UnreadDoc[] = [];

    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const annotations = parseAnnotations(content);
        let unread = 0;

        for (const ann of annotations) {
          for (const comment of ann.comments) {
            if (comment.type === 'reply') {
              const key = computeReadKey(
                file.path,
                ann.highlightText,
                comment.author,
                comment.date,
                comment.text,
              );
              if (!this.readSet.has(key)) unread++;
            }
          }
        }

        if (unread > 0) docs.push({ path: file.path, unread });
      } catch {
        // skip unreadable files
      }
    }

    const result: UnreadJson = {
      generatedAt: new Date().toISOString(),
      docs,
    };

    await this.app.vault.adapter.write(
      this.unreadJsonPath,
      JSON.stringify(result, null, 2),
    );
  }
}
