import { t } from '../i18n.ts';
import { App, Modal } from 'obsidian';

type OnSubmit = (message: string) => void | Promise<void>;

export class GlobalThreadModal extends Modal {
  private inputEl: HTMLTextAreaElement | null = null;

  constructor(
    app: App,
    private onSubmit: OnSubmit,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: t('文档对话') });

    this.inputEl = contentEl.createEl('textarea', {
      cls: 'ilc-global-thread-input',
      attr: { placeholder: t('输入消息…'), rows: '6' },
    });

    this.inputEl.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void this.submit();
      }
    });

    const footer = contentEl.createEl('div', { cls: 'modal-button-container' });
    const cancelBtn = footer.createEl('button', { text: t('取消') });
    cancelBtn.addEventListener('click', () => this.close());

    const submitBtn = footer.createEl('button', {
      cls: 'mod-cta',
      text: t('发送'),
    });
    submitBtn.addEventListener('click', () => {
      void this.submit();
    });

    window.setTimeout(() => this.inputEl?.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
    this.inputEl = null;
  }

  private async submit(): Promise<void> {
    const message = this.inputEl?.value.trim() ?? '';
    if (!message) return;
    this.close();
    await this.onSubmit(message);
  }
}
