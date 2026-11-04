# New-user onboarding audit — Agent Comments 0.2.4-beta.8

> **Handoff for a coding agent:** this issue is a fix brief, not a discussion. Work the **P0/P1** items with the acceptance criteria below. Screenshots live next to this file under `screenshots/`. Do not expand scope into a rewrite of the members system unless a criterion requires it.

## Meta

| | |
|---|---|
| Plugin | Agent Comments (`inline-comments`) **0.2.4-beta.8** |
| App | Obsidian 1.14.5 (Linux, English UI) |
| Vault | Brand-new; plugin only; **no** `_os/`, hooks, skills, `comment-agents.json`, or pre-added @ members |
| Tester | Grok Bot day-0 walkthrough, 2026-11-04 |
| Goal | First install → find entry → first comment → type `@` → add first member |

## Executive summary

- **Plain comments (no AI):** nearly shippable. Ribbon + empty-state copy + right-click + draft card + optional hotkey bind work.
- **@ / members day-0:** pushes a new user toward spawning a Claude Code terminal session before explaining what a member is; Manage members dumps every local CLI session + hook errors.
- **P0 bug:** after Send, the comments panel still says “No comments yet” until the user clicks the highlight.

---

## P0 — must fix

### P0.1 Panel stays empty after first Send

**Repro**
1. Fresh vault, open a note, select text → Add inline comment → Send with any body.
2. Watch the right **Comments** panel (do not click the highlight yet).

**Actual:** Note shows highlight; panel still shows empty state (“No comments yet…”).  
**Expected:** Panel lists the new thread immediately (same as after clicking the highlight).

**Acceptance**
- [ ] Within ~100ms of a successful Send, the panel shows the new card without requiring a click on the highlight.
- [ ] Reloading the note still shows the card.
- [ ] Header grammar is correct (`1 comment` / `N comments`), not `1 comments`.

**Screenshots:** `screenshots/07-saved-comment-panel.png` (stale empty / weak refresh), `screenshots/07-saved-comment-after-click-highlight.png` (appears only after click).

---

### P0.2 Empty `@` picker must not lead with “open a terminal session”

**Repro**
1. Zero @ members.
2. Open reply / draft, type `@`.

**Actual:** Primary highlighted action is **Answer with a new session** (“Opens ‘Session1’ with Claude Code in a terminal…”). Tiny footers only: `+ New session…`, `Manage members…`. No sentence like “You have no members yet.”

**Expected:** Empty state explains there is nobody to @ yet; primary CTAs are **Manage members…** / **Add first member**; “new session in terminal” is secondary or behind an explicit choose-engine step.

**Acceptance**
- [ ] With 0 members, the popover shows an empty-state line (EN+ZH) before any “open terminal” action.
- [ ] Default focus / first button is not “start Claude Code in Terminal”.
- [ ] Creating a terminal session still possible, but requires a clear second step.

**Screenshot:** `screenshots/08-at-empty-popover.png`

---

## P1 — strong day-0 improvements

### P1.1 Manage members: shortest path first

**Actual:** Modal opens with wake-hook “needs reinstall”, mailbox path (Chinese default in EN UI), and a long **Sessions on this machine** list (other vaults, duplicate Codex titles from skill markdown, red “inbox file is gone” warnings). Name field says only “Name it”; 2–12 rule appears only after failed Add via toast. Add on a filled name row did not reliably add a member in this run.

**Acceptance**
- [ ] First-time / zero-member layout: short explainer + **one** Add path (pick a running session **or** create) before the full session dump.
- [ ] Hook reinstall / advanced delivery collapsed or behind “Advanced”.
- [ ] Name field helper text shows `2–12 characters` before submit; validation errors stay inline, not only toast.
- [ ] Successful Add updates the members list immediately and shows a toast that `@Name` works in comments.
- [ ] Prefer sessions whose cwd is the current vault; de-emphasize or group other vaults.

**Screenshots:** `screenshots/09-manage-members-modal.png`, `screenshots/11-name-must-be-2-12.png`, `screenshots/12-enter-a-name-toast.png`

---

### P1.2 One mental model: Settings “AI assistants” vs “@ members”

**Actual:** Settings ships Claude / Codex / Gemini assistants with empty session-id fields and a default assistant, while @ members is empty. New users cannot tell which list `@` uses.

**Acceptance**
- [ ] Settings copy states clearly that **@ mentions use the members roster** (or merges the two concepts).
- [ ] If assistants remain for “document thread / AI reply”, label them so they are not confused with @ targets.
- [ ] Session-id placeholders are not clipped mid-sentence.

**Screenshot:** `screenshots/10b-settings-members-and-hook.png`

---

### P1.3 Discoverability

**Actual**
- Ribbon tooltip is only **Comments** (not Agent Comments).
- No welcome modal / checklist / docs link after enable.
- Command palette: `comment` ranks core **Toggle comment** first; search `评论` → no commands (all command names English).

**Acceptance**
- [ ] Ribbon tooltip includes product name (e.g. `Agent Comments`).
- [ ] Commands have Chinese aliases or localized names when Obsidian locale is zh (at least 添加划线评论 / 打开评论面板 / 管理 @ 成员).
- [ ] Optional: one-time empty-panel tip or settings top blurb with a docs URL.

**Screenshots:** `screenshots/01-ribbon-tooltip-comments.png`, `screenshots/04-palette-search-comment.png`, `screenshots/05c-palette-search-pinglun-no-commands.png`, `screenshots/02b-empty-panel-zoom.png`

---

## P2 — polish (keep if cheap)

- Right-click **Add inline comment** sits between Search and Format; easy to hit Format (checkbox-looking row).
- Draft type chips: Agree looked selected while saved type was `note` — verify chip ↔ stored type sync.
- Reaction picker: Escape / click-outside should dismiss (⋯ menu already does).
- Entry ☺/⋯ ~18px: fine for mouse; still worth a touch target pass later (no mobile Obsidian on the test box).

**Screenshot:** `screenshots/06-draft-card.png`

---

## What already works (do not regress)

1. Empty panel copy: select text → right-click Add inline comment; optional Use Ctrl+Alt+M / Choose a hotkey.
2. Draft card: quote, types, optional body, Cancel/Send, hotkey offer on first draft.
3. Comment stored as CriticMarkup in the note markdown.
4. Community plugin description mentions plain-text comments + @ Claude Code / Codex.

**Screenshots:** `screenshots/02-note-open-empty-panel.png`, `screenshots/06-draft-card.png`

---

## Suggested implementation order

1. P0.1 panel refresh + `1 comment` grammar  
2. P0.2 empty @ copy / CTA order  
3. P1.1 members modal first-run layout + name helper  
4. P1.2 settings mental model  
5. P1.3 ribbon + command i18n aliases  

## Out of scope for this issue

- Re-running desktop Claude/Codex @ E2E (covered elsewhere).
- Mobile Obsidian touch testing (no device on auditor machine).
- Changing default mailbox folder name localization strategy beyond “don’t surprise EN UI with untranslated path without label”.

## Screenshot index

| File | What it shows |
|------|----------------|
| `screenshots/01-ribbon-tooltip-comments.png` | Ribbon tooltip “Comments” |
| `screenshots/02-note-open-empty-panel.png` | Note + empty panel |
| `screenshots/02b-empty-panel-zoom.png` | Empty-state copy zoom |
| `screenshots/04-palette-search-comment.png` | Palette search `comment` |
| `screenshots/05c-palette-search-pinglun-no-commands.png` | Palette search `评论` empty |
| `screenshots/06-draft-card.png` | First draft card + hotkey offer |
| `screenshots/07-saved-comment-panel.png` | After Send (panel issue) |
| `screenshots/07-saved-comment-after-click-highlight.png` | Card after clicking highlight |
| `screenshots/08-at-empty-popover.png` | `@` with zero members |
| `screenshots/09-manage-members-modal.png` | Manage members overload |
| `screenshots/10b-settings-members-and-hook.png` | Settings members + hook |
| `screenshots/11-name-must-be-2-12.png` | Name length toast |
| `screenshots/12-enter-a-name-toast.png` | Empty name toast |
