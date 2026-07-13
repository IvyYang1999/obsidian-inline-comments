import type { App } from 'obsidian';

export type AgentStatus = '在线' | '闲置' | '离线';

export interface RosterEntry {
  name: string;
  shortId: string;
  role: string;
  status: AgentStatus;
}

const ROSTER_PATH = '_os/花名册.md';
const PRESENCE_PATH = '_os/在场.md';

export async function loadRoster(app: App): Promise<RosterEntry[]> {
  try {
    const content = await app.vault.adapter.read(ROSTER_PATH);
    const entries = parseRosterContent(content);

    // Load presence status from 在场.md
    const statusMap = await loadPresenceStatus(app);
    for (const entry of entries) {
      entry.status = statusMap.get(entry.name) ?? '离线';
    }

    // Sort: online/idle first, offline last
    const statusOrder: Record<AgentStatus, number> = { '在线': 0, '闲置': 1, '离线': 2 };
    entries.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    return entries;
  } catch {
    return [];
  }
}

async function loadPresenceStatus(app: App): Promise<Map<string, AgentStatus>> {
  const map = new Map<string, AgentStatus>();
  try {
    const content = await app.vault.adapter.read(PRESENCE_PATH);
    map.clear();
    for (const line of content.split('\n')) {
      // Format: - **花名**（...）｜ ... ｜ 状态: <状态> ｜ ...
      const nameMatch = line.match(/\*\*(.+?)\*\*/);
      const statusMatch = line.match(/状态:\s*(在线|闲置|离线)/);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        const status: AgentStatus = (statusMatch?.[1] as AgentStatus) ?? '离线';
        map.set(name, status);
      }
    }
  } catch {
    // 在场.md not found or unreadable — all agents treated as offline
  }
  return map;
}

/** Parse the "## 在场" section of the roster file. Each line: `- **花名** = <id>（岗位）` */
export function parseRosterContent(content: string): RosterEntry[] {
  const sectionMatch = content.match(/##\s*在场[^\n]*\n([\s\S]*?)(?=\n##|$)/);
  if (!sectionMatch) return [];

  const section = sectionMatch[1];
  const entries: RosterEntry[] = [];
  const lineRe = /^-\s+\*\*(.+?)\*\*\s*=\s*([^\s（]+)(?:\s*（(.+?)）)?/gm;
  let m: RegExpExecArray | null;

  while ((m = lineRe.exec(section)) !== null) {
    entries.push({
      name: m[1].trim(),
      shortId: m[2].trim().slice(0, 8),
      role: m[3]?.trim() ?? '',
      status: '离线',
    });
  }

  return entries;
}

/**
 * Attach @-mention selector behavior to a textarea.
 * When user types `@`, loads the roster and shows a dropdown to pick an agent.
 * Selecting inserts `[@花名](agent:短id?notify)`.
 */
export function attachAtSelector(
  textarea: HTMLTextAreaElement,
  wrapper: HTMLElement,
  app: App,
): void {
  let dropdown: HTMLElement | null = null;
  let activeAtPos = -1;
  let outsideClickHandler: ((ev: MouseEvent) => void) | null = null;

  const dismiss = () => {
    if (!dropdown) return;
    const card = wrapper.closest('.ilc-card');
    card?.classList.remove('ilc-at-active');
    dropdown.remove();
    dropdown = null;
    activeAtPos = -1;
    if (outsideClickHandler) {
      document.removeEventListener('mousedown', outsideClickHandler);
      outsideClickHandler = null;
    }
  };

  textarea.addEventListener('input', async () => {
    const pos = textarea.selectionStart ?? 0;
    const val = textarea.value;

    // Scan backwards from cursor to find a standalone @
    // Trigger when @ is at position 0, or preceded by anything except ASCII alphanumeric
    // (allows CJK, punctuation, whitespace — like Feishu; only blocks email-like "word@")
    let atPos = -1;
    for (let i = pos - 1; i >= 0; i--) {
      if (val[i] === '@') {
        if (i === 0 || !/[a-zA-Z0-9]/.test(val[i - 1])) atPos = i;
        break;
      }
      if (/\s/.test(val[i])) break;
    }

    if (atPos < 0) {
      dismiss();
      return;
    }
    if (dropdown && activeAtPos === atPos) return;

    dismiss();
    activeAtPos = atPos;

    const entries = await loadRoster(app);
    if (entries.length === 0) return;

    const card = wrapper.closest('.ilc-card');
    card?.classList.add('ilc-at-active');

    dropdown = wrapper.createEl('div', { cls: 'ilc-at-dropdown' });
    dropdown.style.top = `${textarea.offsetTop + textarea.offsetHeight + 2}px`;

    // Notify toggle (default: on)
    const toggleRow = dropdown.createEl('div', { cls: 'ilc-at-notify-row' });
    const cb = toggleRow.createEl('input', {
      attr: { type: 'checkbox' },
    }) as HTMLInputElement;
    cb.checked = true;
    toggleRow.createEl('span', { text: '🔔 通知（投信）' });

    for (const entry of entries) {
      const item = dropdown.createEl('div', { cls: `ilc-at-item ilc-at-status-${entry.status === '在线' ? 'online' : entry.status === '闲置' ? 'idle' : 'offline'}` });
      const statusCls = entry.status === '在线' ? 'ilc-at-badge-online'
        : entry.status === '闲置' ? 'ilc-at-badge-idle' : 'ilc-at-badge-offline';
      item.createEl('span', { cls: `ilc-at-badge ${statusCls}`, text: entry.status === '离线' ? '离线' : '' });
      item.createEl('span', { cls: 'ilc-at-name', text: `@${entry.name}` });
      if (entry.role) {
        item.createEl('span', { cls: 'ilc-at-role', text: entry.role });
      }

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const notify = cb.checked ? '?notify' : '';
        const mention = `[@${entry.name}](agent:${entry.shortId}${notify})`;

        const currentVal = textarea.value;
        const curPos = textarea.selectionStart ?? currentVal.length;
        const before = currentVal.slice(0, activeAtPos);
        const after = currentVal.slice(curPos);
        textarea.value = before + mention + after;

        const newCursor = activeAtPos + mention.length;
        textarea.selectionStart = newCursor;
        textarea.selectionEnd = newCursor;
        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        dismiss();
      });
    }

    outsideClickHandler = (ev: MouseEvent) => {
      if (dropdown && !dropdown.contains(ev.target as Node) && ev.target !== textarea) {
        dismiss();
      }
    };
    setTimeout(() => {
      if (outsideClickHandler) document.addEventListener('mousedown', outsideClickHandler);
    }, 50);
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dropdown) {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  });
}
