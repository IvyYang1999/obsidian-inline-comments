#!/bin/bash
# Obsidian Inline Comments — mailbox hook for Claude Code (installed by the plugin).
# Usage (from ~/.claude/settings.json):  bash "<this file>" --root "<mailbox root>"
ROOT=""
LANG_OPT="zh"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --lang) LANG_OPT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$ROOT" ] || exit 0

IN="$(cat)"
SID="$(printf '%s' "$IN" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -n1)"
EVT="$(printf '%s' "$IN" | sed -n 's/.*"hook_event_name" *: *"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$SID" ] || exit 0
case "$IN" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

BOX="$ROOT/$(printf '%s' "$SID" | cut -c1-8)"
[ -d "$BOX" ] || exit 0

TODAY="$(date +%Y-%m-%d)"
N=0
NAME=""
OUT=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  grep -q '^status: 未读' "$f" || continue
  N=$((N+1))
  [ -n "$NAME" ] || NAME="$(sed -n 's/^to_name: *//p' "$f" | head -n1)"
  BODY="$(awk 'BEGIN{fm=0} /^---$/{fm++; next} fm>=2{print}' "$f")"
  OUT="$OUT
━━ 留言 $N（$(basename "$f")）━━
$BODY"
  tmp="$f.tmp.$$"
  if sed 's/^status: 未读$/status: 已读（hook代标）/' "$f" > "$tmp"; then mv "$tmp" "$f"; else rm -f "$tmp"; fi
done < <(find "$BOX" -maxdepth 1 -type f -name '*.md' | sort)

[ "$N" -gt 0 ] || exit 0

if [ "$LANG_OPT" = "en" ]; then
MSG="📬 You have $N new comment(s) from Obsidian${NAME:+ (your name in the comments: $NAME)}.$OUT

How to reply: open the note named in the letter, find the comment block for the quoted passage (it looks like {==passage==}{>>author|date|type: text<<}), and append one entry right after that block's last <<}:
{>>${NAME:-YourName}|$TODAY|reply: your reply<<}
To change the highlighted passage itself, append a suggestion (body = the replacement text only; explanation goes in a separate reply):
{>>${NAME:-YourName}|$TODAY|suggest: replacement text<<}
The passage only changes when the user clicks Accept — never edit {==passage==} yourself.
Rules: do not delete or alter existing comments or the {==passage==}; avoid consecutive << or >> in your text; read the note first if you need context. Once written, the user sees your reply in the comments panel."
else
MSG="📬 Obsidian 评论区有 $N 封新留言给你${NAME:+（你在评论区的名字：$NAME）}。$OUT

如何回复：打开留言里的「文档」，找到「划线原文」对应的评论块（形如 {==原文==}{>>作者|日期|类型: 内容<<}），在该块的最后一个 <<} 之后紧接着追加一条：
{>>${NAME:-你的名字}|$TODAY|reply: 你的回复<<}
要修改划线原文时，另外追加一条建议（正文只放替换后的原文，不要解释，解释写在 reply 里）：
{>>${NAME:-你的名字}|$TODAY|suggest: 替换后的原文<<}
用户在面板里点「采纳」原文才会变，你自己不要直接改 {==原文==}。
规则：不要删改已有评论和 {==原文==}；回复正文里不要出现连续的 << 或 >>；需要上下文就先读文档。回复写进文档后，用户会在评论面板里看到。"
fi

case "$EVT" in
  Stop)
    printf '%s\n' "$MSG" >&2
    exit 2
    ;;
  *)
    printf '%s\n' "$MSG"
    exit 0
    ;;
esac
