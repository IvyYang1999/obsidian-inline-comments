import type { App } from 'obsidian';
import { REGISTRY_PATH, readRegistry } from './registry.ts';
import { MembersModal } from './views/MembersModal.ts';

export { REGISTRY_PATH };

export type AgentStatus = '在线' | '闲置' | '离线';

export interface RosterEntry {
  name: string;
  shortId: string;
  role: string;
  status: AgentStatus;
  source: 'roster' | 'registry';
  harness?: string;
  /** When true, this item is a UI action (e.g. "管理成员"), not a real agent. */
  isAction?: boolean;
}

const ROSTER_PATH = '_os/花名册.md';
const PRESENCE_PATH = '_os/在场.md';

/** 把 session-state.py 的客观状态值归一化成 UI 三态。
 *  真实值举例：运行中/在线/工作中 → 在线；闲置/等待输入/等额度 → 闲置；下线/离线/超时 → 离线。 */
function normalizeStatus(raw: string | undefined): AgentStatus {
  if (!raw) return '离线';
  if (/运行|在线|工作|活跃/.test(raw)) return '在线';
  if (/下线|离线|超时|退出/.test(raw)) return '离线';
  return '闲置'; // 闲置/等待输入/等额度等，默认视作在场但空闲
}

export async function loadRoster(app: App): Promise<RosterEntry[]> {
  // Source 1: 花名册 + 在场板
  let rosterEntries: RosterEntry[] = [];
  try {
    const content = await app.vault.adapter.read(ROSTER_PATH);
    rosterEntries = parseRosterContent(content);

    const statusMap = await loadPresenceStatus(app);
    for (const entry of rosterEntries) {
      entry.status = statusMap.get(entry.name) ?? '离线';
    }
  } catch {
    // roster file missing — treat as empty
  }

  // Source 2: 自助注册表
  const registryEntries = await loadRegistry(app);

  // Merge: same name → registry wins
  const byName = new Map<string, RosterEntry>();
  for (const e of rosterEntries) byName.set(e.name, e);
  for (const e of registryEntries) byName.set(e.name, e);

  const merged = Array.from(byName.values());
  const statusOrder: Record<AgentStatus, number> = { '在线': 0, '闲置': 1, '离线': 2 };
  merged.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

  return merged;
}

async function loadRegistry(app: App): Promise<RosterEntry[]> {
  const data = await readRegistry(app);
  return data.agents.map((a) => ({
    name: a.name,
    shortId: a.sessionId.slice(0, 8),
    role: '',
    status: '闲置' as AgentStatus,
    source: 'registry' as const,
    harness: a.harness || undefined,
  }));
}

async function loadPresenceStatus(app: App): Promise<Map<string, AgentStatus>> {
  const map = new Map<string, AgentStatus>();
  try {
    const content = await app.vault.adapter.read(PRESENCE_PATH);
    map.clear();
    for (const line of content.split('\n')) {
      // Format: - **花名**（...）｜ ... ｜ 状态: <状态> ｜ ...
      // 真实状态值由 session-state.py 客观探测，取值如：运行中/闲置/下线/等待输入/等额度…
      const nameMatch = line.match(/\*\*(.+?)\*\*/);
      const statusMatch = line.match(/状态:\s*([^\s｜|]+)/);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        map.set(name, normalizeStatus(statusMatch?.[1]));
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
      source: 'roster',
    });
  }

  return entries;
}

// ─── Dropdown UI ─────────────────────────────────────────────────────────────

const STATUS_CLS: Record<AgentStatus, string> = { '在线': 'online', '闲置': 'idle', '离线': 'offline' };

/** Deterministic pastel-ish avatar color from a name */
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 52%)`;
}

/** Strip a leading role prefix like "@审计员" so the role column reads as a job title, not a mention */
function cleanRole(role: string): string {
  return role.replace(/^@/, '').trim();
}

/**
 * Attach @-mention selector behavior to a textarea.
 * When user types `@`, loads the roster and shows a dropdown to pick an agent.
 * Typing after `@` filters the list; ↑/↓ moves, ⏎/Tab confirms, Esc dismisses.
 * Selecting inserts `[@花名](agent:短id?notify)`.
 */
export function attachAtSelector(
  textarea: HTMLTextAreaElement,
  wrapper: HTMLElement,
  app: App,
): void {
  let dropdown: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let notifyCb: HTMLInputElement | null = null;
  let activeAtPos = -1;
  let allEntries: RosterEntry[] = [];
  let visible: RosterEntry[] = [];
  let activeIndex = 0;
  let outsideClickHandler: ((ev: MouseEvent) => void) | null = null;

  const dismiss = () => {
    if (!dropdown) return;
    const card = wrapper.closest('.ilc-card');
    card?.classList.remove('ilc-at-active');
    dropdown.remove();
    dropdown = null;
    listEl = null;
    notifyCb = null;
    activeAtPos = -1;
    visible = [];
    activeIndex = 0;
    if (outsideClickHandler) {
      document.removeEventListener('mousedown', outsideClickHandler);
      outsideClickHandler = null;
    }
  };

  const insertMention = (entry: RosterEntry) => {
    const notify = notifyCb?.checked ? '?notify' : '';
    const mention = `[@${entry.name}](agent:${entry.shortId}${notify}) `;

    const currentVal = textarea.value;
    const curPos = textarea.selectionStart ?? currentVal.length;
    const before = currentVal.slice(0, activeAtPos);
    const after = currentVal.slice(curPos);
    textarea.value = before + mention + after;

    const newCursor = activeAtPos + mention.length;
    textarea.selectionStart = newCursor;
    textarea.selectionEnd = newCursor;
    textarea.focus();
    dismiss();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const renderList = (query: string) => {
    if (!listEl) return;
    listEl.empty();

    const q = query.trim().toLowerCase();
    visible = q
      ? allEntries.filter((e) => e.name.toLowerCase().includes(q) || cleanRole(e.role).toLowerCase().includes(q))
      : allEntries;
    activeIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));

    if (visible.length === 0) {
      listEl.createEl('div', {
        cls: 'ilc-at-empty',
        text: allEntries.length === 0 ? '还没有可以 @ 的成员——点下方「管理成员」添加' : '没有匹配的成员',
      });
      return;
    }

    visible.forEach((entry, i) => {
      const item = listEl!.createEl('div', {
        cls: `ilc-at-item ilc-at-status-${STATUS_CLS[entry.status]}${i === activeIndex ? ' is-active' : ''}`,
      });

      const avatar = item.createEl('span', { cls: 'ilc-at-avatar', text: entry.name.charAt(0) });
      avatar.style.background = avatarColor(entry.name);
      avatar.createEl('span', { cls: `ilc-at-dot ilc-at-dot-${STATUS_CLS[entry.status]}` });

      const main = item.createEl('span', { cls: 'ilc-at-main' });
      main.createEl('span', { cls: 'ilc-at-name', text: entry.name });
      const role = cleanRole(entry.role);
      if (role) main.createEl('span', { cls: 'ilc-at-role', text: role });

      if (entry.source === 'registry') {
        const pill = item.createEl('span', { cls: 'ilc-at-source', text: entry.harness ?? '会话' });
        pill.setAttribute('title', `${entry.harness ?? ''} 会话 ${entry.shortId}，自己加入的成员`);
      } else if (entry.status === '离线') {
        item.createEl('span', { cls: 'ilc-at-source ilc-at-source-muted', text: '离线' });
      }

      item.addEventListener('mousemove', () => {
        if (activeIndex !== i) {
          activeIndex = i;
          listEl!.querySelectorAll('.ilc-at-item').forEach((el, j) => el.toggleClass('is-active', j === i));
        }
      });
      item.addEventListener('mousedown', (e) => e.preventDefault()); // keep textarea focus
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        insertMention(entry);
      });
    });
  };

  const moveActive = (delta: number) => {
    if (!listEl || visible.length === 0) return;
    activeIndex = (activeIndex + delta + visible.length) % visible.length;
    const items = listEl.querySelectorAll<HTMLElement>('.ilc-at-item');
    items.forEach((el, j) => el.toggleClass('is-active', j === activeIndex));
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  };

  const currentQuery = (): string => {
    const pos = textarea.selectionStart ?? 0;
    return textarea.value.slice(activeAtPos + 1, pos);
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
        // `[@` is an already-inserted structured mention — never re-trigger on it
        if (i === 0 || !/[a-zA-Z0-9[]/.test(val[i - 1])) atPos = i;
        break;
      }
      if (/\s/.test(val[i])) break;
    }

    if (atPos < 0) {
      dismiss();
      return;
    }
    if (dropdown && activeAtPos === atPos) {
      renderList(currentQuery());
      return;
    }

    dismiss();
    activeAtPos = atPos;

    allEntries = await loadRoster(app);

    const card = wrapper.closest('.ilc-card');
    card?.classList.add('ilc-at-active');

    dropdown = wrapper.createEl('div', { cls: 'ilc-at-dropdown' });
    dropdown.style.top = `${textarea.offsetTop + textarea.offsetHeight + 4}px`;

    // Head: notify toggle (default on) + key hint
    const head = dropdown.createEl('div', { cls: 'ilc-at-head' });
    const notifyLabel = head.createEl('label', { cls: 'ilc-at-notify' });
    notifyCb = notifyLabel.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
    notifyCb.checked = true;
    notifyLabel.createEl('span', { text: '通知对方' });
    notifyLabel.setAttribute('title', '勾选：对方会收到这条评论并把回复写回这里。不勾：只是提一下，不打扰。');
    head.createEl('span', { cls: 'ilc-at-hint', text: '↑↓ 选择 · ⏎ 确认' });

    listEl = dropdown.createEl('div', { cls: 'ilc-at-list' });
    activeIndex = 0;
    renderList(currentQuery());

    // Foot: manage members
    const foot = dropdown.createEl('div', { cls: 'ilc-at-foot' });
    const manageItem = foot.createEl('button', { cls: 'ilc-at-manage', text: '管理成员…' });
    manageItem.addEventListener('mousedown', (e) => e.preventDefault());
    manageItem.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
      new MembersModal(app).open();
    });

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
    if (!dropdown) return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        dismiss();
        break;
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation();
        moveActive(-1);
        break;
      case 'Enter':
      case 'Tab':
        if (visible[activeIndex]) {
          e.preventDefault(); e.stopPropagation();
          insertMention(visible[activeIndex]);
        }
        break;
    }
  });
}
