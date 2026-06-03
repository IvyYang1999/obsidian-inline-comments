import { App, Modal } from 'obsidian';
import type { DeletedRecord } from '../types.ts';
import type InlineCommentsPlugin from '../../main.ts';

export class HistoryModal extends Modal {
  constructor(app: App, private plugin: InlineCommentsPlugin) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass('ilc-history-modal');

    // Header row
    const headerRow = contentEl.createEl('div', { cls: 'ilc-history-header' });
    headerRow.createEl('h2', { text: '评论删除历史' });

    const history = await this.plugin.loadDeletedHistory();

    if (history.length === 0) {
      contentEl.createEl('div', { cls: 'ilc-history-empty', text: '暂无删除记录' });
      return;
    }

    // Clear-all button
    const clearBtn = headerRow.createEl('button', {
      cls: 'ilc-history-clear-btn',
      text: '清空历史',
    });
    clearBtn.addEventListener('click', async () => {
      await this.plugin.clearDeletedHistory();
      this.onOpen();  // re-render
    });

    const list = contentEl.createEl('div', { cls: 'ilc-history-list' });

    for (const record of history) {
      const item = list.createEl('div', { cls: 'ilc-history-item' });

      // Item header: filename + time
      const itemHeader = item.createEl('div', { cls: 'ilc-history-item-header' });
      const fileName = record.filePath.split('/').pop() ?? record.filePath;
      itemHeader.createEl('span', {
        cls: 'ilc-history-item-file',
        text: fileName,
        attr: { title: record.filePath },
      });
      itemHeader.createEl('span', {
        cls: 'ilc-history-item-time',
        text: relativeTime(record.deletedAt),
        attr: { title: record.deletedAt },
      });
      if (record.wasFullAnnotation) {
        itemHeader.createEl('span', { cls: 'ilc-history-item-badge', text: '整条' });
      }

      // Highlight text
      const hl = record.highlightText;
      item.createEl('div', {
        cls: 'ilc-history-item-highlight',
        text: `"${hl.slice(0, 70)}${hl.length > 70 ? '…' : ''}"`,
      });

      // Deleted entries
      const entriesEl = item.createEl('div', { cls: 'ilc-history-item-entries' });
      for (const entry of record.entries) {
        const entryEl = entriesEl.createEl('div', { cls: 'ilc-history-entry-row' });
        entryEl.createEl('span', { cls: 'ilc-history-entry-author', text: entry.author });
        entryEl.createEl('span', { cls: 'ilc-history-entry-type', text: entry.type });
        if (entry.text) {
          entryEl.createEl('span', {
            cls: 'ilc-history-entry-text',
            text: entry.text.slice(0, 100) + (entry.text.length > 100 ? '…' : ''),
          });
        }
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function relativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1)  return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return `${days} 天前`;
  } catch {
    return iso;
  }
}
