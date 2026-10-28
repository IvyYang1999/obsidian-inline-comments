import { t } from '../i18n.ts';
import { App, type ButtonComponent, Modal, Notice, Platform, Setting, type TextComponent } from 'obsidian';
import { readRegistry, upsertAgent, validateName } from '../registry.ts';
import type { RosterEntry } from '../atSelector.ts';
import { electronRemote } from '../node.ts';
import { HARNESSES, detectHarnesses, type HarnessId } from '../harnesses.ts';

/** Native folder picker; null when cancelled or unavailable. `ILC_PICK_FOLDER` answers for it in e2e. */
async function pickFolder(title: string, start: string): Promise<string | null> {
  if (process.env.ILC_PICK_FOLDER) return process.env.ILC_PICK_FOLDER;
  const remote = electronRemote();
  if (!remote?.dialog) return null;
  const res = await remote.dialog.showOpenDialog(remote.getCurrentWindow?.(), {
    title,
    defaultPath: start || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0] ?? null;
}

/** Installed harnesses, in table order; on mobile nothing can be detected, so Claude Code is assumed */
async function installedHarnesses(): Promise<HarnessId[]> {
  if (!Platform.isDesktopApp) return ['claude'];
  const { bins } = await detectHarnesses();
  return HARNESSES.filter((h) => bins[h.id]).map((h) => h.id);
}

/** Harness for a quick new session: the one the newest plugin-created member uses, else the first installed */
export async function defaultHarness(app: App): Promise<HarnessId | null> {
  const installed = await installedHarnesses();
  const recent = (await readRegistry(app)).agents.filter((a) => a.autoStart).map((a) => a.harness).reverse();
  return (recent.find((h) => installed.includes(h as HarnessId)) as HarnessId | undefined) ?? installed[0] ?? null;
}

/** Register a brand-new (not yet started) session as a member */
export async function createSessionMember(app: App, name: string, cwd: string, harness: HarnessId): Promise<RosterEntry | null> {
  const err = validateName(name);
  if (err) { new Notice(err); return null; }
  const sessionId = crypto.randomUUID();
  const res = await upsertAgent(app, { name: name.trim(), sessionId, harness, cwd, autoStart: true });
  if (!res.ok) { new Notice(res.error); return null; }
  return {
    name: name.trim(),
    shortId: sessionId.slice(0, 8),
    sessionId,
    role: '',
    status: '离线',
    source: 'registry',
    harness,
    cwd,
    autoStart: true,
  };
}

export function defaultSessionCwd(app: App): string {
  const base = (app.vault.adapter as any)?.basePath;
  return typeof base === 'string' ? base : '';
}

/**
 * 「新会话」— name + harness + working directory. On confirm the member is
 * registered; the session itself is started the first time a letter is delivered to it.
 */
export class NewSessionModal extends Modal {
  private name: string;
  private cwd: string;
  private harness: HarnessId | null = null;

  constructor(app: App, private onCreated: (entry: RosterEntry) => void, initialName = '') {
    super(app);
    this.name = initialName;
    this.cwd = defaultSessionCwd(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('ilc-newsession-modal');
    contentEl.createEl('h2', { text: t('新会话') });
    contentEl.createEl('p', {
      cls: 'ilc-members-intro',
      text: t('起个名字。你在评论里 @ 它并发送后，插件会启动一个真正的会话，把留言交给它；它会把回复写回文档。'),
    });

    let nameInput: HTMLInputElement | null = null;
    new Setting(contentEl)
      .setName(t('名字'))
      .setDesc(t('2–12 个字，评论里就用 @这个名字'))
      .addText((txt) => {
        nameInput = txt.inputEl;
        txt.setPlaceholder(t('例如：日记助理')).setValue(this.name).onChange((v) => { this.name = v; });
        txt.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void this.submit(); } });
      });
    const harnessSetting = new Setting(contentEl).setName('Harness').setDesc(t('正在查找本机装了哪些…'));
    harnessSetting.settingEl.addClass('ilc-newsession-harness');
    let createBtn: ButtonComponent | null = null;
    void this.renderHarnesses(harnessSetting, () => createBtn);

    let cwdText: TextComponent | null = null;
    const cwdSetting = new Setting(contentEl)
      .setName(t('工作目录'))
      .setDesc(t('会话在哪个目录启动；默认 vault 根目录，这样它能直接读写文档'))
      .addText((txt) => {
        cwdText = txt;
        txt.inputEl.addClass('ilc-newsession-cwd');
        txt.setValue(this.cwd).onChange((v) => { this.cwd = v.trim() || defaultSessionCwd(this.app); });
      });
    if (Platform.isDesktopApp) {
      cwdSetting.addButton((b) => b.setButtonText(t('选择…')).onClick(async () => {
        const dir = await pickFolder(t('选择会话的工作目录'), this.cwd);
        if (!dir) return;
        this.cwd = dir;
        cwdText?.setValue(dir);
      }));
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t('取消')).onClick(() => this.close()))
      .addButton((b) => {
        createBtn = b;
        b.setButtonText(t('创建并 @')).setCta().setDisabled(!this.harness).onClick(() => void this.submit());
      });

    window.setTimeout(() => nameInput?.focus(), 50);
  }

  /** Fill the harness dropdown with what is installed; with nothing installed, say what to install */
  private async renderHarnesses(setting: Setting, createBtn: () => ButtonComponent | null): Promise<void> {
    const installed = await installedHarnesses();
    const preferred = await defaultHarness(this.app);
    if (installed.length === 0) {
      setting.setDesc(t('本机没找到 Claude Code、Codex 或 Gemini CLI。装好其中一个再来。'));
      return;
    }
    this.harness = preferred ?? installed[0];
    const describe = (id: HarnessId) => setting.setDesc(HARNESSES.find((h) => h.id === id)?.mode === 'terminal'
      ? t('在终端里打开，之后可以继续在终端或评论里跟它聊')
      : t('在后台回复，每封留言都接着同一个会话；想接着聊可以在成员列表里点「终端」'));
    describe(this.harness);
    setting.addDropdown((d) => {
      for (const id of installed) d.addOption(id, HARNESSES.find((h) => h.id === id)!.label);
      d.setValue(this.harness!).onChange((v) => { this.harness = v as HarnessId; describe(this.harness); });
    });
    createBtn()?.setDisabled(false);
  }

  private async submit(): Promise<void> {
    if (!this.harness) return;
    const entry = await createSessionMember(this.app, this.name, this.cwd, this.harness);
    if (!entry) return;
    this.close();
    this.onCreated(entry);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
