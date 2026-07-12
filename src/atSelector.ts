import type { App } from 'obsidian';

export interface RosterEntry {
  name: string;
  shortId: string;
  role: string;
}

const ROSTER_PATH = '_os/花名册.md';

export async function loadRoster(app: App): Promise<RosterEntry[]> {
  try {
    const content = await app.vault.adapter.read(ROSTER_PATH);
    return parseRosterContent(content);
  } catch {
    return [];
  }
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
    let atPos = -1;
    for (let i = pos - 1; i >= 0; i--) {
      if (val[i] === '@') {
        if (i === 0 || /\s/.test(val[i - 1])) atPos = i;
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
      const item = dropdown.createEl('div', { cls: 'ilc-at-item' });
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
