/**
 * Lazy access to Node built-ins. The bundle must not `require('fs')` at module
 * scope: on mobile that throws and the whole plugin fails to load. Desktop-only
 * features call these inside functions, behind `Platform.isDesktop`.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
export const nodeFsp  = () => (require('fs') as typeof import('fs')).promises;
export const nodeCp   = () => require('child_process') as typeof import('child_process');
export const nodeOs   = () => require('os') as typeof import('os');
export const nodePath = () => require('path') as typeof import('path');
