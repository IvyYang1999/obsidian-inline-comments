import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { loadRoster, REGISTRY_PATH, type RosterEntry } from '../atSelector.ts';

interface RegistryFile {
  agents: Array<{
    name: string;
    sessionId: string;
    harness: string;
    joinedAt: string;
  }>;
}

export async function renderAgentRegistrySection(
  containerEl: HTMLElement,
  app: App,
): Promise<void> {
  containerEl.createEl('h3', { text: '评论互动成员' });

  const listEl = containerEl.createEl('div', { cls: 'ilc-settings-list' });
  await refreshList(listEl, app);
}

async function refreshList(listEl: HTMLElement, app: App): Promise<void> {
  listEl.empty();

  const entries = await loadRoster(app);
  const realEntries = entries.filter((e) => !e.isAction);

  if (realEntries.length === 0) {
    listEl.createEl('p', {
      text: '暂无成员。任意 session 可运行 _os/scripts/comment-agent.sh join 自助加入。',
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
      const label = `自助·${entry.harness ?? ''}`;
      row.createEl('span', { cls: 'ilc-registry-badge ilc-registry-badge-self', text: label });

      const delBtn = row.createEl('button', {
        cls: 'ilc-settings-del-btn',
        text: '移除',
        attr: { title: '从注册表中移除' },
      });
      delBtn.addEventListener('click', async () => {
        await removeRegistryAgent(app, entry.name);
        new Notice(`已移除「${entry.name}」`);
        await refreshList(listEl, app);
      });
    } else {
      row.createEl('span', { cls: 'ilc-registry-badge ilc-registry-badge-roster', text: '在编' });
    }
  }
}

async function removeRegistryAgent(app: App, name: string): Promise<void> {
  let data: RegistryFile = { agents: [] };
  try {
    const raw = await app.vault.adapter.read(REGISTRY_PATH);
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(data?.agents)) return;

  data.agents = data.agents.filter((a) => a.name !== name);
  await app.vault.adapter.write(REGISTRY_PATH, JSON.stringify(data, null, 2));
}
