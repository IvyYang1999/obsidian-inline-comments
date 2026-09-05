import type { App } from 'obsidian';

/**
 * Red unread-count badge on file-explorer rows (files with unread replies, and
 * collapsed folders that contain such files). Counts come from UnreadTracker;
 * this class only paints. A MutationObserver on the explorer keeps badges in
 * place when Obsidian re-renders rows (expand/collapse, rename, sort).
 */
export class ExplorerBadge {
  private counts = new Map<string, number>();
  private observed = new WeakSet<Element>();
  private observers: MutationObserver[] = [];
  private timer = 0;

  constructor(private app: App, private enabled: () => boolean) {}

  /** Call once the layout is ready, and again on layout-change (explorer may be recreated) */
  attach(): void {
    for (const root of Array.from(document.querySelectorAll('.nav-files-container'))) {
      if (this.observed.has(root)) continue;
      this.observed.add(root);
      const mo = new MutationObserver((records) => {
        // Ignore the mutations we cause ourselves
        if (records.every((r) => this.isOurs(r))) return;
        this.schedule();
      });
      mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      this.observers.push(mo);
    }
    this.schedule();
  }

  detach(): void {
    for (const mo of this.observers) mo.disconnect();
    this.observers = [];
    for (const b of Array.from(document.querySelectorAll('.ilc-unread-badge'))) b.remove();
  }

  setCounts(counts: ReadonlyMap<string, number>): void {
    this.counts = new Map(counts);
    this.schedule();
  }

  private isOurs(r: MutationRecord): boolean {
    const isBadge = (n: Node) => n instanceof Element && n.classList.contains('ilc-unread-badge');
    if (r.type === 'childList') {
      return [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].every(isBadge);
    }
    return isBadge(r.target);
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 60);
  }

  render(): void {
    const on = this.enabled();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.nav-file-title[data-path]'))) {
      const path = el.dataset.path ?? '';
      this.apply(el, on ? this.counts.get(path) ?? 0 : 0);
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.nav-folder-title[data-path]'))) {
      const path = el.dataset.path ?? '';
      const collapsed = el.closest('.nav-folder')?.classList.contains('is-collapsed') ?? false;
      this.apply(el, on && collapsed && path && path !== '/' ? this.sumUnder(path) : 0);
    }
  }

  private sumUnder(folder: string): number {
    const prefix = folder.endsWith('/') ? folder : folder + '/';
    let n = 0;
    for (const [p, c] of this.counts) if (p.startsWith(prefix)) n += c;
    return n;
  }

  private apply(row: HTMLElement, n: number): void {
    let badge = row.querySelector<HTMLElement>(':scope > .ilc-unread-badge');
    if (n <= 0) { badge?.remove(); return; }
    if (!badge) badge = row.createSpan({ cls: 'ilc-unread-badge' });
    const text = n > 99 ? '99+' : String(n);
    if (badge.textContent !== text) badge.textContent = text;
  }
}
