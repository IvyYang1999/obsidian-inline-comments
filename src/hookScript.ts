/**
 * The Claude Code hook the plugin installs (source: hooks/ilc-mailbox-hook.sh,
 * inlined at build time by esbuild's text loader). One script serves every
 * session: it reads `session_id` from the hook's stdin JSON, looks into that
 * session's inbox and hands unread letters to Claude.
 *
 *  - UserPromptSubmit / SessionStart: letters → stdout → injected as context
 *  - Stop: letters → stderr, exit 2 → Claude keeps working on them
 *    (guarded by `stop_hook_active` so it cannot loop)
 *
 * Letters are marked `status: 已读（hook代标）` once handed over.
 */
import script from '../hooks/ilc-mailbox-hook.sh';

export const HOOK_SCRIPT_NAME = 'ilc-mailbox-hook.sh';
export const HOOK_SCRIPT: string = script;
