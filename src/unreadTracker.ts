import type { App, TFile } from 'obsidian';
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
 *
 * Unread counts are kept per-file in memory; only the changed file is
 * re-scanned on modify / mark-as-read. A full vault scan happens once at init.
 * Replies authored by the current user are never counted as unread.
 */
export class UnreadTracker {
  private readSet = new Set<string>();
  private docCounts = new Map<string, number>();
  private fileTimers = new Map<string, number>();

  constructor(
    private app: App,
    private pluginDir: string,
    private enabled: () => boolean,
    private selfName: () => string = () => '',
  ) {}

  private get readStatePath(): string {
    return `${this.pluginDir}/read-state.json`;
  }

  private get unreadJsonPath(): string {
    return `${this.pluginDir}/unread-replies.json`;
  }

  async init(): Promise<void> {
    await this.loadReadState();
    await this.recomputeAll();
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

  /** Whether a reply should participate in unread tracking (own replies never do) */
  isTrackable(author: string): boolean {
    const self = this.selfName();
    return !self || author.toLowerCase() !== self.toLowerCase();
  }

  /**
   * Mark a reply as read. The in-memory set is updated synchronously so any
   * re-render that follows is immediately consistent; persistence and the
   * per-file recount run in the background.
   */
  markAsRead(readKey: string, file?: TFile): Promise<void> {
    this.readSet.add(readKey);
    return (async () => {
      await this.saveReadState();
      if (file) await this.recomputeFile(file);
      else await this.recomputeAll();
    })();
  }

  /** Debounced per-file recount — call on vault modify events */
  scheduleRecompute(file?: TFile): void {
    if (!this.enabled()) return;
    if (!file) {
      void this.recomputeAll();
      return;
    }
    const prev = this.fileTimers.get(file.path);
    if (prev) window.clearTimeout(prev);
    this.fileTimers.set(
      file.path,
      window.setTimeout(() => {
        this.fileTimers.delete(file.path);
        void this.recomputeFile(file);
      }, 1500),
    );
  }

  /** Backwards-compatible alias (settings toggle) */
  recompute(): Promise<void> {
    return this.recomputeAll();
  }

  /** Count unread replies in one document's content */
  countUnread(path: string, content: string): number {
    let unread = 0;
    for (const ann of parseAnnotations(content)) {
      for (const comment of ann.comments) {
        if (comment.type !== 'reply') continue;
        if (!this.isTrackable(comment.author)) continue;
        const key = computeReadKey(path, ann.highlightText, comment.author, comment.date, comment.text);
        if (!this.readSet.has(key)) unread++;
      }
    }
    return unread;
  }

  async recomputeFile(file: TFile): Promise<void> {
    if (!this.enabled()) return;
    try {
      const content = await this.app.vault.cachedRead(file);
      const n = this.countUnread(file.path, content);
      if (n > 0) this.docCounts.set(file.path, n);
      else this.docCounts.delete(file.path);
      await this.writeJson();
    } catch {
      // unreadable file — leave previous count untouched
    }
  }

  /** Scan all markdown files, rebuild the per-file table, write unread-replies.json */
  async recomputeAll(): Promise<void> {
    if (!this.enabled()) return;

    const files = this.app.vault.getMarkdownFiles();
    const counts = new Map<string, number>();

    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const n = this.countUnread(file.path, content);
        if (n > 0) counts.set(file.path, n);
      } catch {
        // skip unreadable files
      }
    }

    this.docCounts = counts;
    await this.writeJson();
  }

  private async writeJson(): Promise<void> {
    const docs: UnreadDoc[] = [...this.docCounts.entries()]
      .map(([path, unread]) => ({ path, unread }))
      .sort((a, b) => a.path.localeCompare(b.path));

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
