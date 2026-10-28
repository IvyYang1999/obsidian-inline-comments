/**
 * Lazy access to Node built-ins. The bundle must not `require('fs')` at module
 * scope: on mobile that throws and the whole plugin fails to load. Desktop-only
 * features call these inside functions, behind `Platform.isDesktop`.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Defer Node built-ins until desktop-only callers invoke these helpers so mobile can load the plugin. */
export const nodeFsp  = () => (require('fs') as typeof import('fs')).promises;
export const nodeCp   = () => require('child_process') as typeof import('child_process');
export const nodeOs   = () => require('os') as typeof import('os');
export const nodePath = () => require('path') as typeof import('path');
/** Electron's remote module as bundled by Obsidian desktop (dialogs); undefined when absent */
export const electronRemote = () => (require('electron') as { remote?: ElectronRemote }).remote;
/* eslint-enable @typescript-eslint/no-require-imports -- Restore the rule after the lazy Node helpers. */

export interface ElectronRemote {
  getCurrentWindow?(): unknown;
  dialog?: {
    showOpenDialog(win: unknown, opts: { title?: string; defaultPath?: string; properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
}
