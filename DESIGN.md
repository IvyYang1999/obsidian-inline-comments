# Inline Comments — Design System

Synthesized from Feishu, sidebar-highlights, and Notion design patterns.

---

## Tokens

### Color

| Token | Value | Usage |
|-------|-------|-------|
| `--ilc-text` | `#1f2329` | Primary text |
| `--ilc-text-secondary` | `#646a73` | Metadata, secondary labels |
| `--ilc-text-faint` | `#8f959e` | Timestamps, placeholders |
| `--ilc-bg-card` | `var(--background-primary)` | Card surface |
| `--ilc-bg-preview` | `var(--background-secondary)` | Card preview bar |
| `--ilc-bg-reply` | `var(--background-secondary-alt, var(--background-secondary))` | Reply entries |
| `--ilc-border` | `var(--background-modifier-border)` | Card border |
| `--ilc-hover` | `var(--background-modifier-hover)` | Hover background |
| `--ilc-accent` | `var(--interactive-accent)` | Buttons, avatars |
| `--ilc-focus-ring` | `#ffe8a3` | Active card focus ring (Feishu yellow) |

### Comment type colors (built-in)

| Type | Highlight bg | Left-border |
|------|-------------|-------------|
| agree | `rgba(76,175,80,0.22)` | `#4CAF50` |
| disagree | `rgba(244,67,54,0.22)` | `#F44336` |
| question | `rgba(255,152,0,0.22)` | `#FF9800` |
| important | `rgba(33,150,243,0.22)` | `#2196F3` |
| note | `rgba(158,158,158,0.18)` | `#9E9E9E` |

### Shadow system (Notion / Feishu)

```
--ilc-shadow-xs:  0 1px 2px rgba(15,15,15,0.06);
--ilc-shadow-sm:  0 2px 6px rgba(15,15,15,0.10);
--ilc-shadow-md:  0 4px 16px rgba(15,15,15,0.14);
--ilc-shadow-focus: 0 0 0 2px #ffe8a3;          /* Feishu yellow focus */
--ilc-shadow-type: 0 0 0 1.5px <border-color>;  /* sidebar-highlights focus ring */
```

### Spacing (4 px grid)

`4 · 6 · 8 · 10 · 12 · 16 · 24`

### Typography

| Role | Size | Weight |
|------|------|--------|
| Body | 13 px | 400 |
| Meta (author, date) | 12 px | 400 / 600 |
| Badge / chip | 11 px | 600 |
| Preview text | 12 px | 400 italic |

### Border radius

| Context | Value |
|---------|-------|
| Small widgets (badge, chip, avatar) | 8–10 px |
| Cards | 8 px |
| Inputs / buttons | 5 px |
| Inline marks | 2 px |

---

## States

| State | Treatment |
|-------|-----------|
| Default card | `border: 1px solid var(--ilc-border)`, `shadow-xs` |
| Hover card | `shadow-sm`, `translateY(-1px)` |
| Active / focus card | `shadow-focus` (yellow `#ffe8a3`) — no layout shift |
| Flash (jump from editor) | `@keyframes ilc-flash` 0.5 s ease-out |

Buttons (`⋯`, reply, cancel/post) are `opacity: 0` by default and revealed at `opacity: 1` on parent hover or active state — matching sidebar-highlights pattern.

---

## Component inventory

- **Highlight mark** — `ilc-highlight ilc-hl-{type}`
- **Badge widget** — `ilc-badge` (count bubble after highlight)
- **Card** — `ilc-card ilc-card-{type}` (5px left border + shadow)
- **Card preview bar** — `ilc-card-preview` with truncated highlight text
- **Thread** — `ilc-thread` wrapping multiple entries
- **Comment entry** — `ilc-entry` with avatar, author, date, body
- **Pending entry** — `ilc-entry-pending` with spinner animation
- **Reply controls** — `ilc-reply-row` / `ilc-reply-input-row`
- **Draft card** — `ilc-card-draft` shown in `draftZone`
- **Type chips** — `ilc-draft-type-btn` horizontal scroll row
- **⋯ menu button** — `ilc-more-btn`, hidden until hover
- **Panel footer** — `ilc-panel-footer` with history link
- **History modal** — `ilc-history-modal`
- **Settings list** — `ilc-settings-list` / `ilc-settings-row`
