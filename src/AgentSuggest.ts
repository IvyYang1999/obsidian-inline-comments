import {
  type EditorPosition,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
  Editor,
  EditorSuggest,
  TFile,
} from 'obsidian';
import type { App } from 'obsidian';
import type InlineCommentsPlugin from '../main.ts';
import { loadRoster, type RosterEntry } from './atSelector.ts';

export class AgentSuggest extends EditorSuggest<RosterEntry> {
  constructor(
    app: App,
    private plugin: InlineCommentsPlugin,
  ) {
    super(app);
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile | null,
  ): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const sub = line.slice(0, cursor.ch);

    let atIdx = -1;
    for (let i = sub.length - 1; i >= 0; i--) {
      if (sub[i] === '@') {
        if (i === 0 || !/[a-zA-Z0-9]/.test(sub[i - 1])) {
          atIdx = i;
        }
        break;
      }
      if (/\s/.test(sub[i])) break;
    }

    if (atIdx < 0) return null;

    const query = sub.slice(atIdx + 1);

    return {
      start: { line: cursor.line, ch: atIdx },
      end: cursor,
      query,
    };
  }

  async getSuggestions(
    context: EditorSuggestContext,
  ): Promise<RosterEntry[]> {
    const entries = await loadRoster(this.app);
    const q = context.query.toLowerCase();
    const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;

    const manageAction: RosterEntry = {
      name: '⚙ 管理成员…',
      shortId: '',
      role: '',
      status: '离线',
      source: 'roster',
      isAction: true,
    };
    return [...filtered, manageAction];
  }

  renderSuggestion(entry: RosterEntry, el: HTMLElement): void {
    if (entry.isAction) {
      el.addClass('ilc-at-item', 'ilc-at-manage');
      el.createEl('span', { text: entry.name });
      return;
    }

    el.addClass('ilc-at-item');
    const statusClass =
      entry.status === '在线'
        ? 'ilc-at-status-online'
        : entry.status === '闲置'
          ? 'ilc-at-status-idle'
          : 'ilc-at-status-offline';
    el.addClass(statusClass);

    if (entry.source === 'registry') {
      const label = `自助·${entry.harness ?? ''}`;
      el.createEl('span', { cls: 'ilc-at-badge ilc-at-badge-idle', text: label });
    } else {
      const badgeCls =
        entry.status === '在线'
          ? 'ilc-at-badge-online'
          : entry.status === '闲置'
            ? 'ilc-at-badge-idle'
            : 'ilc-at-badge-offline';
      const badge = el.createEl('span', { cls: `ilc-at-badge ${badgeCls}` });
      if (entry.status === '离线') badge.setText('离线');
    }

    el.createEl('span', { cls: 'ilc-at-name', text: `@${entry.name}` });
    if (entry.role) {
      el.createEl('span', { cls: 'ilc-at-role', text: entry.role });
    }
  }

  selectSuggestion(entry: RosterEntry, _evt: MouseEvent | KeyboardEvent): void {
    if (entry.isAction) {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById('inline-comments');
      return;
    }

    const ctx = this.context;
    if (!ctx) return;

    const mention = `[@${entry.name}](agent:${entry.shortId}?notify)`;
    ctx.editor.replaceRange(mention, ctx.start, ctx.end);
  }
}
