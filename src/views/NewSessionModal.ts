import { App, Modal, Notice, Setting } from 'obsidian';
import { upsertAgent, validateName } from '../registry.ts';
import type { RosterEntry } from '../atSelector.ts';

/** Register a brand-new (not yet started) Claude Code session as a member */
export async function createSessionMember(app: App, name: string, cwd: string): Promise<RosterEntry | null> {
  const err = validateName(name);
  if (err) { new Notice(err); return null; }
  const sessionId = crypto.randomUUID();
  const res = await upsertAgent(app, { name: name.trim(), sessionId, harness: 'claude', cwd, autoStart: true });
  if (!res.ok) { new Notice(res.error); return null; }
  return {
    name: name.trim(),
    shortId: sessionId.slice(0, 8),
    sessionId,
    role: '',
    status: '离线',
    source: 'registry',
    harness: 'claude',
    cwd,
    autoStart: true,
  };
}

export function defaultSessionCwd(app: App): string {
  const base = (app.vault.adapter as any)?.basePath;
  return typeof base === 'string' ? base : '';
}

/**
 * 「新会话」— name + working directory. On confirm the member is registered;
 * the session itself is started the first time a letter is delivered to it.
 */
export class NewSessionModal extends Modal {
  private name: string;
  private cwd: string;

  constructor(app: App, private onCreated: (entry: RosterEntry) => void, initialName = '') {
    super(app);
    this.name = initialName;
    this.cwd = defaultSessionCwd(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('ilc-newsession-modal');
    contentEl.createEl('h2', { text: '新会话' });
    contentEl.createEl('p', {
      cls: 'ilc-members-intro',
      text: '起个名字。你在评论里 @ 它并发送后，插件会在终端里启动一个真正的 Claude Code 会话，把留言作为第一句话交给它；它会把回复写回文档，之后你可以继续在终端或评论里跟它聊。',
    });

    let nameInput: HTMLInputElement | null = null;
    new Setting(contentEl)
      .setName('名字')
      .setDesc('2–12 个字，评论里就用 @这个名字')
      .addText((t) => {
        nameInput = t.inputEl;
        t.setPlaceholder('例如：日记助理').setValue(this.name).onChange((v) => { this.name = v; });
        t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void this.submit(); } });
      });
    new Setting(contentEl)
      .setName('工作目录')
      .setDesc('会话在哪个目录启动；默认 vault 根目录，这样它能直接读写文档')
      .addText((t) => t.setValue(this.cwd).onChange((v) => { this.cwd = v.trim() || defaultSessionCwd(this.app); }));

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('创建并 @').setCta().onClick(() => void this.submit()));

    setTimeout(() => nameInput?.focus(), 50);
  }

  private async submit(): Promise<void> {
    const entry = await createSessionMember(this.app, this.name, this.cwd);
    if (!entry) return;
    this.close();
    this.onCreated(entry);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
