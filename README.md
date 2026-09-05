<p align="center"><img src="site/logo.svg" width="96" alt="划线评论 logo"></p>

# Inline Comments

Feishu-style inline comments for Obsidian. Highlight a passage, leave a note, and — if you want — `@` an AI coding session (Claude Code / Codex) to reply. Comments live right inside the Markdown file, next to the text they refer to.

Website: https://github.com/IvyYang1999/obsidian-inline-comments · Author: [yytyyf](https://yytyyf.com)

## What it does

- **Highlight → comment.** Select text, right-click → *Add inline comment* (or use the command). A card appears in the right sidebar, horizontally aligned with the anchor and scrolling with it. The document only shows a soft highlight and a small badge.
- **Threads.** Reply to any comment. Cards render Markdown-stripped previews, per-thread accent colours, and avatar connector lines.
- **Unread.** Replies from other people (or AI) get a red dot; the panel header shows "N comments · M unread". Mark as read with one click. Your own replies never count as unread.
- **`@` a session.** Type `@` in a reply to pick a running Claude Code / Codex session, or choose *Answer with a new session*. The plugin drops a letter into that session's mailbox folder; a small hook (installed on request into `~/.claude/settings.json`) injects the letter into the session's context, and the session writes its reply back into the file. If the session isn't running, the plugin starts one in Terminal (macOS).
- **Plain text storage.** A comment is one line of CriticMarkup-style text:

  ```
  {==highlighted text==}{>>author|2026-09-05|question: What's the source? [@Session1](agent:3f9a12c0)<<}
  ```

  No database, no sidecar files. Syncs with iCloud / Git / Obsidian Sync; readable without the plugin.

## Install

From the community plugin list: search **Inline Comments**.

Before it is listed, or to track pre-releases, use [BRAT](https://github.com/TfTHacker/obsidian42-brat): *BRAT: Add a beta plugin* → `IvyYang1999/obsidian-inline-comments`.

Desktop only (uses Node APIs for session discovery and the mailbox hook).

## Using `@`

1. Open *Manage members* (from the `@` dropdown or the settings tab). Running sessions on this machine are discovered automatically; give one a name to make it mentionable.
2. Click *Install hook* once. This adds three entries (`UserPromptSubmit`, `Stop`, `SessionStart`) to `~/.claude/settings.json`, backing the file up first. Nothing else in the file is touched; *Uninstall* removes exactly those entries.
3. In a comment, type `@Name` and send. The letter lands in `<vault>/<mailbox root>/<session-id-prefix>/`. The session sees it the next time it speaks or finishes, reads the document, and appends a reply.

The plugin never talks to the network. Letters and replies are local files; what your AI tool does with them is up to that tool.

## Settings

- **Author name** — used for your comments and to exclude your own replies from unread counts.
- **Mention delivery** / **mailbox root** — where letters are written.
- **Panel background** — sidebar / editor / custom colour.
- **Unread signal** — writes `unread-replies.json` for badge plugins to consume.

## Development

```bash
npm install
npm run build      # tsc + esbuild → main.js
npm test           # vitest (pure functions)
npm run e2e        # launches an isolated Obsidian and runs ~70 UI assertions
```

Design notes are in `DESIGN.md`.

---

## 中文

在 Obsidian 笔记里划线留言，@ 一个 AI 会话来回复。评论以纯文本形式紧挨着原文存在 `.md` 里，不联网、不建库。

- 选中文字右键「添加划线评论」，卡片在右侧栏与原文水平对齐。
- 回复带红点、顶部常驻「N 条评论 · M 未读」。
- 打 `@` 点名一个正在跑的 Claude Code / Codex 会话，或「用新会话回答」；插件投信、hook 唤醒、回复写回文档。
- 仅桌面端。安装：社区插件搜「Inline Comments」，或用 BRAT 添加 `IvyYang1999/obsidian-inline-comments`。

## License

MIT
