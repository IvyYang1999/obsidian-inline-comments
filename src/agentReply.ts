import { parseAnnotations } from './parser.ts';

interface ExistingCommentForPrompt {
  author: string;
  type:   string;
  text:   string;
}

/** From a comment body, return the first registered agent name mentioned with @. */
export function parseAtMention(
  commentText: string,
  registeredNames: string[],
): string | null {
  const namesByLower = new Map<string, string>();
  for (const name of registeredNames) {
    const cleaned = name.trim();
    if (cleaned) namesByLower.set(cleaned.toLowerCase(), cleaned);
  }
  if (namesByLower.size === 0) return null;

  const mentionRe = /@([\p{Script=Han}A-Za-z0-9]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = mentionRe.exec(commentText)) !== null) {
    const candidate = match[1].toLowerCase();
    const registered = namesByLower.get(candidate);
    if (registered) return registered;
  }

  return null;
}

/** Build the headless Claude prompt for appending one reply to one annotation. */
export function buildAgentReplyPrompt(params: {
  absolutePath: string;
  agentName: string;
  highlightText: string;
  existingComments: ExistingCommentForPrompt[];
  date: string;
}): string {
  return [
    '你正在为 Obsidian Markdown 文件中的一条划线评论追加 @Agent 回复。',
    `文件绝对路径：${JSON.stringify(params.absolutePath)}`,
    '',
    '目标 annotation 用以下信息唯一定位：',
    `高亮文字：${JSON.stringify(params.highlightText)}`,
    `已有评论 JSON：${JSON.stringify(params.existingComments, null, 2)}`,
    '',
    '任务：',
    '1. 读取并只编辑上面的原文件。',
    '2. 找到高亮文字和已有评论序列完全匹配的那一条 `{==...==}{>>...<<}` annotation。',
    `3. 只在该 annotation 末尾追加一条回复，格式必须等价于调用 parser.ts 的 appendReply：{>>${params.agentName}|${params.date}|reply: 你的回复<<}`,
    '4. 只追加不改其它任何字符：不要改正文、不要改其它评论、不要改目标 annotation 的高亮文字和已有评论。',
    '5. 回复正文中不要写入 `<<` 或 `>>`；如必须表达，请改写为安全文本。',
    '6. 直接保存原文件；不要创建新文件，不要输出整篇文档。',
  ].join('\n');
}

/** Verify that only the target annotation changed, and that a reply was appended. */
export function verifyOnlyTargetAnnotationChanged(
  before: string,
  after: string,
  annotationFrom: number,
): { onlyTargetChanged: boolean; appendedReply: boolean } {
  const beforeTarget = parseAnnotations(before).find(
    (annotation) => annotation.from === annotationFrom,
  );
  const afterTarget = parseAnnotations(after).find(
    (annotation) => annotation.from === annotationFrom,
  );

  if (!beforeTarget || !afterTarget) {
    return { onlyTargetChanged: false, appendedReply: false };
  }

  const onlyTargetChanged =
    before.slice(0, beforeTarget.from) === after.slice(0, afterTarget.from) &&
    before.slice(beforeTarget.to) === after.slice(afterTarget.to);

  const beforeTargetRaw = before.slice(beforeTarget.from, beforeTarget.to);
  const afterTargetRaw = after.slice(afterTarget.from, afterTarget.to);
  const addedComments = afterTarget.comments.slice(beforeTarget.comments.length);
  const appendedReply =
    afterTargetRaw.startsWith(beforeTargetRaw) &&
    addedComments.some((comment) => comment.type === 'reply');

  return { onlyTargetChanged, appendedReply };
}
