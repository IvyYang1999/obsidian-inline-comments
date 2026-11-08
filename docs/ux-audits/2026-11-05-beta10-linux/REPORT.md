# Agent Comments 0.2.4-beta.10 — Linux residual UX / delivery issues

Follow-up to [#7](https://github.com/IvyYang1999/obsidian-inline-comments/issues/7) after retesting **0.2.4-beta.10** on Linux (fresh vault + harness E2E).

## Meta

| | |
|---|---|
| Plugin | Agent Comments (`inline-comments`) **0.2.4-beta.10** |
| App | Obsidian (Linux, English UI) |
| Vaults | `AgentComments-Fresh10` (day-0), `AgentComments-Beta10` (Claude/Codex harness) |
| Date | 2026-11-05 |
| Related | Issue #7 (beta.8 brief; most P0/P1 claimed fixed in beta.10) |

## What we verified as fixed on Linux

- First Send refreshes the comments panel immediately (no click-on-highlight).
- Empty `@` shows “Nobody to @ yet…”; primary CTA is **Add your first member…**.
- Wake hook install/reinstall works; Advanced fold exists.
- Codex **New session** (background) sets autoStart and completes `@` round-trip (`ILC-FRESH-CODEX`).
- Claude `@` works when a session is **already running** (`ILC-FRESH-CLAUDE2`, route handed).
- Harness vault: Claude `ILC-CLAUDE-OK`; Codex with autoStart `ILC-CODEX-OK`.

## Unresolved (this issue)

See GitHub issue body for P0/P1/P2 acceptance criteria. Screenshots in `./screenshots/`.
