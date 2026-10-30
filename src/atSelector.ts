import { t } from './i18n.ts';
import { type App, Notice, Platform } from 'obsidian';
import { REGISTRY_PATH, readRegistry } from './registry.ts';
import { MembersModal } from './views/MembersModal.ts';
import { NewSessionModal, createSessionMember, defaultHarness, defaultSessionCwd } from './views/NewSessionModal.ts';
import { validateName, nextAutoSessionName } from './registry.ts';
import { HARNESSES, detectHarnesses, harnessDef, type HarnessId } from './harnesses.ts';
import { claudeInboxHolds, findClaudeSession } from './claudeInbox.ts';
import { REACH_ORDER, decideReach, harnessLoggedIn, legacyReach, levelHint, unknownHarnessReach, type Reach } from './reach.ts';

export { REGISTRY_PATH };

export type AgentStatus = '在线' | '闲置' | '离线';

export interface RosterEntry {
  name: string;
  shortId: string;
  role: string;
  status: AgentStatus;
  source: 'roster' | 'registry';
  harness?: string;
  /** Full session id (roster line / registry); shortId is its first 8 chars */
  sessionId?: string;
  /** Vault-relative mailbox override from the registry */
  mailbox?: string;
  /** When true, this item is a UI action (e.g. "管理成员"), not a real agent. */
  isAction?: boolean;
  /** Working directory for auto-start / resume */
  cwd?: string;
  /** Plugin-created session: start it in a terminal when a letter arrives */
  autoStart?: boolean;
  /** Harness session id to resume, when it differs from sessionId */
  threadId?: string;
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
    sessionId: a.sessionId,
    mailbox: a.mailbox,
    cwd: a.cwd,
    autoStart: a.autoStart,
    threadId: a.threadId,
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
      sessionId: m[2].trim(),
      role: m[3]?.trim() ?? '',
      status: '离线',
      source: 'roster',
    });
  }

  return entries;
}

// ─── How each member gets a letter ───────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- the plugin instance is looked up through Obsidian's untyped registry */
const pluginOf = (app: App): any => (app as any).plugins?.plugins?.['inline-comments'];
/* eslint-enable @typescript-eslint/no-explicit-any -- end of the plugin lookup */

/** How each member would get a letter right now, by name (desktop only: empty on mobile) */
export async function memberReach(app: App, entries: RosterEntry[]): Promise<Map<string, Reach>> {
  const out = new Map<string, Reach>();
  if (!Platform.isDesktopApp) return out;
  const plugin = pluginOf(app);
  const [hookInstalled, { bins }] = await Promise.all([
    (plugin?.refreshHookState?.() as Promise<boolean> | undefined)?.catch(() => false) ?? false,
    detectHarnesses(),
  ]);
  await Promise.all(entries.map(async (e) => {
    if (e.isAction) return;
    if (e.source === 'roster') { out.set(e.name, legacyReach(e.status)); return; }
    const h = harnessDef(e.harness);
    if (!h) { out.set(e.name, unknownHarnessReach(e.harness ?? '')); return; }
    let open = false, noInbox = false, holds = false, desktop = false;
    if (h.id === 'claude' && e.sessionId) {
      const { running, inbox } = await findClaudeSession(e.sessionId);
      open = running;
      noInbox = running && !inbox;
      if (inbox) { desktop = inbox.desktop; holds = await claudeInboxHolds(inbox); }
    }
    out.set(e.name, decideReach({
      harness: h.id, label: h.label, headless: h.mode === 'headless', autoStart: !!e.autoStart,
      open, noInbox, holds, desktop, hookInstalled: !!hookInstalled, cliInstalled: !!bins[h.id],
      loggedIn: h.mode === 'headless' ? await harnessLoggedIn(h.id) : true,
      canOpenTerminal: process.platform === 'darwin',
    }));
  }));
  return out;
}

const LEGACY_LEVEL: Record<AgentStatus, Reach['level']> = { '在线': 'now', '闲置': 'later', '离线': 'none' };

/** Who can answer soonest first; then whoever already spoke in this thread; then whoever was @-ed last */
function pickerOrder(entries: RosterEntry[], reach: Map<string, Reach>, participants: Set<string>, lastAt: (e: RosterEntry) => number): RosterEntry[] {
  const level = (e: RosterEntry) => REACH_ORDER[reach.get(e.name)?.level ?? LEGACY_LEVEL[e.status]];
  const here = (e: RosterEntry) => (participants.has(e.name.toLowerCase()) ? 0 : 1);
  return entries
    .map((e, i) => ({ e, i, at: lastAt(e) }))
    .sort((a, b) => level(a.e) - level(b.e) || here(a.e) - here(b.e) || b.at - a.at || a.i - b.i)
    .map((x) => x.e);
}

/** What answering with a new session does, in one line */
function newSessionHint(name: string, harness: HarnessId | null, signedIn = true): string {
  const h = harness ? HARNESSES.find((x) => x.id === harness) : undefined;
  if (!h) return t('本机没找到 Claude Code、Codex 或 Gemini CLI');
  if (!signedIn) return t('会用 {0} 开「{1}」，但 {0} 好像还没登录', [h.label, name]);
  return h.mode === 'terminal'
    ? t('用 {0} 在终端里开「{1}」，之后 @{1} 都接着它聊', [h.label, name])
    : t('用 {0} 在后台开「{1}」回复，之后 @{1} 都接着它聊', [h.label, name]);
}

const LEVEL_CLS: Record<Reach['level'], string> = { now: 'online', later: 'idle', none: 'offline' };

// ─── Dropdown UI ─────────────────────────────────────────────────────────────

const STATUS_CLS: Record<AgentStatus, string> = { '在线': 'online', '闲置': 'idle', '离线': 'offline' };

/** Deterministic pastel-ish avatar color from a name */
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 52%)`;
}

/**
 * Lowest on-screen y the dropdown may use inside the panel. Obsidian's status bar
 * floats over the bottom of the right sidebar: anything under it shows through
 * but cannot be clicked, so the panel's own bottom edge is not enough.
 */
function visibleBottom(panelRect: DOMRect): number {
  let bottom = Math.min(panelRect.bottom, window.innerHeight);
  const bar = document.querySelector('.status-bar')?.getBoundingClientRect();
  if (bar && bar.height > 0 && bar.left < panelRect.right && bar.right > panelRect.left && bar.top < bottom) bottom = bar.top;
  return bottom;
}

/** Pseudo-entry shown first in the list: pick it to answer with a brand-new session */
const newSessionAction = (next: string, harness: HarnessId | null, ready: boolean): RosterEntry => ({
  name: t('用新会话回答'),
  shortId: '',
  role: newSessionHint(next, harness, ready),
  status: harness && ready ? '在线' : '离线',
  source: 'registry',
  isAction: true,
});

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
  ctx: { participants?: string[] } = {},
): void {
  const participants = new Set((ctx.participants ?? []).map((n) => n.toLowerCase()));
  let reach = new Map<string, Reach>();
  /** Harness a quick new session would use (null: none installed), and whether it seems signed in */
  let newHarness: HarnessId | null = null;
  let newHarnessReady = true;
  let dropdown: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;
  let notifyCb: HTMLInputElement | null = null;
  let activeAtPos = -1;
  let allEntries: RosterEntry[] = [];
  let visible: RosterEntry[] = [];
  let activeIndex = 0;
  /** typed name with no match → offer to create a session with it */
  let createCandidate: string | null = null;
  /** monotonically increasing id of the latest roster load (guards concurrent loads) */
  let loadSeq = 0;
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

  const insertMention = (entry: RosterEntry, atPos = activeAtPos, notifyOn = notifyCb?.checked ?? true) => {
    if (entry.isAction) { void createAndMention(nextAutoSessionName(allEntries.map((e) => e.name))); return; }
    if (atPos < 0) return;
    const notify = notifyOn ? '?notify' : '';
    const mention = `[@${entry.name}](agent:${entry.shortId}${notify}) `;

    const currentVal = textarea.value;
    const curPos = textarea.selectionStart ?? currentVal.length;
    const before = currentVal.slice(0, atPos);
    const after = currentVal.slice(curPos);
    textarea.value = before + mention + after;

    const newCursor = atPos + mention.length;
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
    const matches = q
      ? allEntries.filter((e) => e.name.toLowerCase().includes(q) || cleanRole(e.role).toLowerCase().includes(q))
      : allEntries;
    // "用新会话回答" leads the list whenever nothing specific is typed (or the label itself matches)
    const action = newSessionAction(nextAutoSessionName(allEntries.map((e) => e.name)), newHarness, newHarnessReady);
    visible = !q || action.name.includes(query.trim()) ? [action, ...matches] : matches;
    if (!q && reach.size > 0 && allEntries.length > 0 && ![...reach.values()].some((r) => r.level === 'now')) {
      listEl.createEl('div', { cls: 'ilc-at-tip', text: t('现在没有能马上回复的会话，可以用新会话回答') });
    }
    activeIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));

    createCandidate = q && !validateName(query.trim()) ? query.trim() : null;
    if (visible.length === 0) {
      if (createCandidate) {
        const item = listEl.createEl('div', { cls: 'ilc-at-item ilc-at-create is-active' });
        item.createEl('span', { cls: 'ilc-at-avatar ilc-at-avatar-new', text: '＋' });
        const main = item.createEl('span', { cls: 'ilc-at-main' });
        main.createEl('span', { cls: 'ilc-at-name', text: t('创建新会话「{0}」并 @ 它', [createCandidate]) });
        main.createEl('span', { cls: 'ilc-at-role', text: newSessionHint(createCandidate, newHarness, newHarnessReady) });
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', (e) => { e.stopPropagation(); void createAndMention(createCandidate!); });
      } else {
        listEl.createEl('div', {
          cls: 'ilc-at-empty',
          text: allEntries.length === 0 ? t('还没有可以 @ 的成员——输入一个名字直接创建新会话，或点「管理成员」') : t('没有匹配的成员'),
        });
      }
      return;
    }

    visible.forEach((entry, i) => {
      const r = entry.isAction ? undefined : reach.get(entry.name);
      const statusCls = r ? LEVEL_CLS[r.level] : STATUS_CLS[entry.status];
      const item = listEl!.createEl('div', {
        cls: `ilc-at-item ilc-at-status-${statusCls}${i === activeIndex ? ' is-active' : ''}${entry.isAction ? ' ilc-at-newsession' : ''}${entry.isAction && !(newHarness && newHarnessReady) ? ' is-disabled' : ''}`,
      });

      const avatar = item.createEl('span', { cls: `ilc-at-avatar${entry.isAction ? ' ilc-at-avatar-new' : ''}`, text: entry.isAction ? '＋' : entry.name.charAt(0) });
      if (!entry.isAction) {
        avatar.setCssStyles({ background: avatarColor(entry.name) });
        const dot = avatar.createEl('span', { cls: `ilc-at-dot ilc-at-dot-${statusCls}` });
        if (r) dot.setAttribute('title', levelHint(r.level));
      }

      const main = item.createEl('span', { cls: 'ilc-at-main' });
      main.createEl('span', { cls: 'ilc-at-name', text: entry.name });
      const role = [cleanRole(entry.role), r && r.text !== entry.status ? r.text : ''].filter(Boolean).join(' · ');
      if (role) main.createEl('span', { cls: 'ilc-at-role', text: role, attr: { title: role } });

      if (r?.fix) {
        const fix = r.fix;
        const btn = item.createEl('button', { cls: 'ilc-at-fix', text: fix === 'hook' ? t('安装 hook') : t('去登录') });
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const plugin = pluginOf(app);
          if (fix === 'hook') await plugin?.installHooks?.();
          else await plugin?.openHarnessLogin?.(entry.harness);
          reach = await memberReach(app, allEntries);
          renderList(currentQuery());
        });
      }
      if (!entry.isAction && participants.has(entry.name.toLowerCase())) {
        item.createEl('span', { cls: 'ilc-at-source ilc-at-source-muted', text: t('这条里回复过') });
      }

      if (entry.isAction) {
        // no source pill
      } else if (entry.source === 'registry') {
        const pill = item.createEl('span', { cls: 'ilc-at-source', text: harnessDef(entry.harness)?.label ?? entry.harness ?? t('会话') });
        pill.setAttribute('title', t('{0} 会话 {1}，自己加入的成员', [entry.harness ?? '', entry.shortId]));
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

  /** Register a not-yet-started session under `name` and @ it right away */
  const createAndMention = async (name: string) => {
    const atPos = activeAtPos;
    const notifyOn = notifyCb?.checked ?? true;
    const harness = await defaultHarness(app);
    if (!harness) { new Notice(t('本机没找到 Claude Code、Codex 或 Gemini CLI。装好其中一个再来。')); return; }
    const entry = await createSessionMember(app, name, defaultSessionCwd(app), harness);
    if (!entry) return;
    dismiss();
    insertMention(entry, atPos, notifyOn);
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
    const loadToken = ++loadSeq;

    const [entries, harness] = await Promise.all([loadRoster(app), defaultHarness(app)]);
    const reachNow = await memberReach(app, entries);
    const ready = !harness || !Platform.isDesktopApp || await harnessLoggedIn(harness);
    // Superseded (user moved on / another load finished first)? Just refresh the query.
    if (activeAtPos !== atPos || loadToken !== loadSeq) { if (dropdown) renderList(currentQuery()); return; }
    if (dropdown) { renderList(currentQuery()); return; }
    reach = reachNow;
    newHarness = harness;
    newHarnessReady = ready;
    const log = pluginOf(app)?.deliveryLog;
    allEntries = pickerOrder(entries, reach, participants, (e) => (e.sessionId ? log?.lastAt?.(e.sessionId) ?? 0 : 0));

    const card = wrapper.closest('.ilc-card');
    card?.classList.add('ilc-at-active');

    dropdown = wrapper.createEl('div', { cls: 'ilc-at-dropdown' });
    // Place below the textarea if there is room inside the panel viewport,
    // otherwise above; cap the height so head + list + foot always fit.
    {
      const panel = wrapper.closest('.ilc-panel') as HTMLElement | null;
      const panelRect = panel?.getBoundingClientRect();
      const taRect = textarea.getBoundingClientRect();
      const spaceBelow = panelRect ? visibleBottom(panelRect) - taRect.bottom - 12 : Infinity;
      const spaceAbove = panelRect ? taRect.top - panelRect.top - 12 : 0;
      const WANT = 280;
      if (spaceBelow < 220 && spaceAbove > spaceBelow) {
        dropdown.setCssStyles({ bottom: `${wrapper.clientHeight - textarea.offsetTop + 4}px` });
        dropdown.setCssStyles({ maxHeight: `${Math.max(160, Math.min(WANT, spaceAbove))}px` });
        dropdown.addClass('ilc-at-dropdown-up');
      } else {
        dropdown.setCssStyles({ top: `${textarea.offsetTop + textarea.offsetHeight + 4}px` });
        dropdown.setCssStyles({ maxHeight: `${Math.max(160, Math.min(WANT, spaceBelow))}px` });
      }
    }

    // Head: notify toggle (default on) + key hint
    const head = dropdown.createEl('div', { cls: 'ilc-at-head' });
    const notifyLabel = head.createEl('label', { cls: 'ilc-at-notify' });
    notifyCb = notifyLabel.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
    notifyCb.checked = true;
    notifyLabel.createEl('span', { text: t('通知对方') });
    notifyLabel.setAttribute('title', t('勾选：对方会收到这条评论并把回复写回这里。不勾：只是提一下，不打扰。'));
    head.createEl('span', { cls: 'ilc-at-hint', text: t('↑↓ 选择 · ⏎ 确认') });

    listEl = dropdown.createEl('div', { cls: 'ilc-at-list' });
    activeIndex = 0;
    renderList(currentQuery());

    // Foot: new session + manage members
    const foot = dropdown.createEl('div', { cls: 'ilc-at-foot' });
    const newItem = foot.createEl('button', { cls: 'ilc-at-new', text: t('＋ 新会话…') });
    newItem.addEventListener('mousedown', (e) => e.preventDefault());
    newItem.addEventListener('click', (e) => {
      e.stopPropagation();
      const atPos = activeAtPos;
      const notifyOn = notifyCb?.checked ?? true;
      const initial = currentQuery().trim();
      dismiss();
      new NewSessionModal(app, (entry) => insertMention(entry, atPos, notifyOn), initial).open();
    });
    const manageItem = foot.createEl('button', { cls: 'ilc-at-manage', text: t('管理成员…') });
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
    window.setTimeout(() => {
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
        } else if (createCandidate) {
          e.preventDefault(); e.stopPropagation();
          void createAndMention(createCandidate);
        }
        break;
    }
  });
}
