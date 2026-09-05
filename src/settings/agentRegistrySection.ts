import { Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { loadRoster } from '../atSelector.ts';
import { removeAgent } from '../registry.ts';
import { MembersModal } from '../views/MembersModal.ts';

export async function renderAgentRegistrySection(
  containerEl: HTMLElement,
  app: App,
): Promise<void> {
  new Setting(containerEl).setName('评论 @ 成员').setHeading();
  const desc = containerEl.createEl('p', { cls: 'setting-item-description' });
  desc.appendText('可以在评论里 @ 的 AI 会话。添加、移除和自动发现本机会话，都在 ');
  const openBtn = desc.createEl('button', { cls: 'ilc-members-open', text: '成员管理…' });
  openBtn.addEventListener('click', () => new MembersModal(app).open());
  desc.appendText(' 里。');

  const listEl = containerEl.createEl('div', { cls: 'ilc-settings-list' });
  await refreshList(listEl, app);
}

async function refreshList(listEl: HTMLElement, app: App): Promise<void> {
  listEl.empty();

  const entries = await loadRoster(app);
  const realEntries = entries.filter((e) => !e.isAction);

  if (realEntries.length === 0) {
    listEl.createEl('p', {
      text: '暂无成员。打开「成员管理…」从本机会话里加一个。',
      cls: 'setting-item-description',
    });
    return;
  }

  for (const entry of realEntries) {
    const row = listEl.createEl('div', { cls: 'ilc-settings-row' });

    row.createEl('span', { cls: 'ilc-registry-name', text: entry.name });
    row.createEl('span', {
      cls: 'ilc-registry-id',
      text: entry.shortId,
      attr: { title: '短 ID（前 8 位）' },
    });

    if (entry.source === 'registry') {
      row.createEl('span', { cls: 'ilc-registry-badge ilc-registry-badge-self', text: entry.harness ?? '会话' });

      const delBtn = row.createEl('button', {
        cls: 'ilc-settings-del-btn',
        text: '移除',
        attr: { title: '从注册表中移除' },
      });
      delBtn.addEventListener('click', async () => {
        await removeAgent(app, entry.name);
        new Notice(`已移除「${entry.name}」`);
        await refreshList(listEl, app);
      });
    } else {
      row.createEl('span', { cls: 'ilc-registry-badge ilc-registry-badge-roster', text: '在编' });
    }
  }
}
