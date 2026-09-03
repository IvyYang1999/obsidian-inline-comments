# Inline Comments — Design System · "Quiet thread"

> 2026-09 重设计。一句话：**一张卡片只有一种强调色（评论类型），其余全部退到发丝线和主题色里。**
> 目标是让阅读线程像读一段安静的对话，而不是看一堆彩色边框和灰色按钮。

---

## 原则

1. **一卡一色**：类型色只出现在「引文竖线」「类型 chip」「激活态描边」三处，通过 `--ilc-accent` 自定义属性下发；不再给整张卡片刷左边框。
2. **发丝线代替阴影**：卡片静止时只有 1px 半透明边线，没有阴影；阴影只留给悬浮的草稿卡。激活态用 3px 的 16% 强调色描边光环。
3. **头像牵引线程**：每条评论以 24px 头像开头，多条评论之间用 2px 连接线串起来（GitHub / Slack thread 式），回复不再用灰底缩进。
4. **未读只在头像上**：红点挂在头像右上角，「标为已读」是一条 11px 的文字动作，读完即消失；不再渲染灰色大按钮和"已读"幽灵态。自己的回复永不进入未读逻辑。
5. **文字动作 > 按钮**：取消、标为已读、请 Agent 回应都是胶囊/文字样式，只有「发送」是实心强调色。

---

## Tokens（`styles.css :root`）

| Token | 值 | 用途 |
|---|---|---|
| `--ilc-accent` | 卡片级自定义属性，由 TS 按类型写入 | 引文竖线 / chip / 激活描边 |
| `--ilc-surface` | `var(--background-primary)` | 卡片表面 |
| `--ilc-surface-sunken` | `var(--background-secondary)` | 输入框底 |
| `--ilc-hairline` | 边线色 75% | 卡片边 |
| `--ilc-hairline-soft` | 边线色 45% | 线程连接线 |
| `--ilc-avatar` | `24px` | 头像尺寸 |
| `--ilc-gutter` | `12px` | 卡片左右内边距 |
| `--ilc-indent` | `avatar + 8px` | 正文相对头像的缩进 |
| `--ilc-radius-card` / `-btn` / `-pill` | `10px` / `6px` / `999px` | 卡片 / 输入 / 胶囊 |
| `--ilc-font-body` / `-meta` / `-small` | `13 / 12 / 11 px` | 正文 / 作者、引文 / 日期、动作 |

类型色（内置）：agree `#4CAF50` · disagree `#F44336` · question `#FF9800` · important `#2196F3` · note `#9E9E9E`。自定义类型由 `main.ts injectTypeStyles()` 写入 `.ilc-card-<id> { --ilc-accent }`。

---

## 组件

| 组件 | 类名 | 说明 |
|---|---|---|
| 面板头 | `ilc-panel-header` · `ilc-panel-count` · `ilc-panel-unread` | 「**N** 条评论 · M 未读」，位于 cardsZone 之外 |
| 卡片 | `ilc-card` · `ilc-card-active` · `ilc-card-flash` | 绝对定位，`top` 由布局引擎写入 |
| 引文 | `ilc-card-preview` → `ilc-card-quote-rule` + `ilc-card-preview-text` | 3px 强调色竖线 + 两行截断的原文（已剥 markdown） |
| 线程 | `ilc-thread` → `ilc-entry` (`-has-prev` / `-has-next`) | 连接线由 `::before/::after` 画在头像中轴 |
| 条目头 | `ilc-entry-header` → `ilc-entry-avatar` · `ilc-entry-author` · `ilc-entry-chip` · `ilc-entry-date` | 回复条目没有 chip |
| 未读 | `ilc-entry-unread` · `ilc-entry-footer` → `ilc-read-btn` | 红点在头像；点击乐观更新 |
| 正文 | `ilc-entry-body` → `ilc-mention` (`-notify`) | 结构化 @ 渲染为强调色文字 |
| 回复输入 | `ilc-reply-input-row` → `ilc-reply-input` · `ilc-reply-submit` | 仅激活卡片显示，沉底输入框 |
| 草稿卡 | `ilc-card-draft` → `ilc-draft-type-btn` (`-active`) | 类型选择为「色点 + 标签」胶囊，选中即改卡片强调色 |
| 编辑器侧 | `ilc-highlight ilc-hl-<type>` · `ilc-badge` | 未改 |

---

## 布局引擎（`CommentPanel.layoutCards`）

- 每张卡片的理想位置 = 编辑器里锚点的 y；实际位置 = `max(理想, 上一张卡片底 + 8px)`，纯不重叠贪心，**没有间距封顶**。
- 卡片尺寸变化（回复框展开、文字换行）由 `ResizeObserver` 触发重排。
