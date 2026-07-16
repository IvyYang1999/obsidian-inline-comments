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

/** Build the headless Claude prompt for generating one reply body. */
export function buildAgentReplyPrompt(params: {
  absolutePath: string;
  agentName: string;
  highlightText: string;
  existingComments: ExistingCommentForPrompt[];
  date: string;
}): string {
  return [
    '你正在为 Obsidian Markdown 文件中的一条划线评论生成 @Agent 回复正文。',
    `文件绝对路径：${JSON.stringify(params.absolutePath)}`,
    '你可以读取该文件理解上下文，但只能只读：不要修改、保存、创建或删除任何文件。',
    '',
    '目标 annotation 用以下信息唯一定位：',
    `高亮文字：${JSON.stringify(params.highlightText)}`,
    `已有评论 JSON：${JSON.stringify(params.existingComments, null, 2)}`,
    '',
    '任务：',
    '1. 读取文件并理解目标 annotation 的上下文。',
    '2. 找到高亮文字和已有评论序列完全匹配的那一条 `{==...==}{>>...<<}` annotation。',
    '3. 只在 stdout 输出你的回复正文纯文本。',
    '4. 不要编辑任何文件；不要输出整篇文档、Markdown 代码块、JSON、解释、标题或其它格式标记。',
    `5. 不要输出 {>>...<<} 包裹，也不要输出作者、日期或 type；插件会以 ${JSON.stringify(params.agentName)}、${JSON.stringify(params.date)}、reply 强制写回。`,
    '6. 回复正文正常写即可；插件会转义 `<<` 和 `>>`，但能避开时请改写为安全表达。',
  ].join('\n');
}

export function cleanReplyText(raw: string): string {
  let text = raw.trim();

  const fenced = text.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenced) {
    text = fenced[1].trim();
  }

  const wrappedBlock = text.match(/^\{>>[^|]+?\|[^|]+?\|[^:]+:\s*([\s\S]*?)<<\}$/);
  if (wrappedBlock) {
    text = wrappedBlock[1].trim();
  }

  return text;
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
