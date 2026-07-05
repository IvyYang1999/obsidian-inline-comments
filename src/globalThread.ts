export type GlobalThreadEngine = 'claude' | 'glm';

export interface GlobalThreadEntry {
  author: string;
  date:   string;
  text:   string;
}

export interface GlobalThreadBlock {
  from:          number;
  to:            number;
  bodyFrom:      number;
  endMarkerFrom: number;
  body:          string;
  entries:       GlobalThreadEntry[];
}

export const GLOBAL_THREAD_START_MARKER =
  '<!-- ilc-global-thread: 全局对话 -->';
export const GLOBAL_THREAD_END_MARKER = '<!-- /ilc-global-thread -->';
export const GLOBAL_THREAD_CALLOUT_HEADER = '> [!ai-thread]+ 文档对话';

const THREAD_RE =
  /(^[ \t]*<!--\s*(?:ilc-global-thread(?::\s*全局对话)?|全局对话)\s*-->[ \t]*(?:\r?\n)?)([\s\S]*?)(^[ \t]*<!--\s*\/(?:ilc-global-thread|全局对话)\s*-->[ \t]*)/m;

const ENTRY_LINE_RE = /^>\s*\*\*(.+?)[｜|](.+?)\*\*[：:]\s?(.*)$/;

/** Parse the document-level AI thread block, if the file has one. */
export function parseGlobalThreadBlock(content: string): GlobalThreadBlock | null {
  const m = THREAD_RE.exec(content);
  if (!m) return null;

  const from = m.index;
  const bodyFrom = from + m[1].length;
  const endMarkerFrom = bodyFrom + m[2].length;
  const to = endMarkerFrom + m[3].length;

  return {
    from,
    to,
    bodyFrom,
    endMarkerFrom,
    body: m[2],
    entries: parseGlobalThreadEntries(m[2]),
  };
}

/** Append one message to the existing block, or create the block at EOF. */
export function appendGlobalThreadEntry(
  content: string,
  entry: GlobalThreadEntry,
): string {
  const line = buildGlobalThreadEntryMarkup(entry);
  const block = parseGlobalThreadBlock(content);

  if (block) {
    const needsNewline = block.body.length > 0 && !block.body.endsWith('\n');
    const needsHeader = !/^>\s*\[!ai-thread\]/im.test(block.body);
    const insert = [
      needsNewline ? '\n' : '',
      needsHeader ? `${GLOBAL_THREAD_CALLOUT_HEADER}\n` : '',
      line,
      '\n',
    ].join('');
    return (
      content.slice(0, block.endMarkerFrom) +
      insert +
      content.slice(block.endMarkerFrom)
    );
  }

  let separator = '\n\n';
  if (content.length === 0 || content.endsWith('\n\n')) {
    separator = '';
  } else if (content.endsWith('\n')) {
    separator = '\n';
  }
  return `${content}${separator}${buildGlobalThreadBlock([entry])}\n`;
}

/**
 * True when the only changed region is the global thread block.
 * Marker movement counts as an outside change.
 */
export function hasOnlyGlobalThreadBlockChanged(
  before: string,
  after: string,
): boolean {
  const beforeBlock = parseGlobalThreadBlock(before);
  const afterBlock = parseGlobalThreadBlock(after);
  if (!beforeBlock || !afterBlock) return false;

  return (
    before.slice(0, beforeBlock.from) === after.slice(0, afterBlock.from) &&
    before.slice(beforeBlock.to) === after.slice(afterBlock.to)
  );
}

export function buildGlobalThreadEntryMarkup(entry: GlobalThreadEntry): string {
  const author = cleanMeta(entry.author, 'user');
  const date = cleanMeta(entry.date, localIsoDate());
  const text = cleanEntryText(entry.text);
  const lines = text.split('\n');
  const first = lines.shift() ?? '';
  const rendered = [`> **${author}｜${date}**：${first}`];

  for (const line of lines) {
    rendered.push(`> ${line}`);
  }

  return rendered.join('\n');
}

function buildGlobalThreadBlock(entries: GlobalThreadEntry[]): string {
  return [
    GLOBAL_THREAD_START_MARKER,
    GLOBAL_THREAD_CALLOUT_HEADER,
    ...entries.map(buildGlobalThreadEntryMarkup),
    GLOBAL_THREAD_END_MARKER,
  ].join('\n');
}

function parseGlobalThreadEntries(body: string): GlobalThreadEntry[] {
  const entries: GlobalThreadEntry[] = [];
  let current: { author: string; date: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    entries.push({
      author: current.author,
      date: current.date,
      text: current.lines.join('\n').trimEnd(),
    });
    current = null;
  };

  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (/^>\s*\[!ai-thread\]/i.test(line)) continue;

    const m = line.match(ENTRY_LINE_RE);
    if (m) {
      flush();
      current = {
        author: m[1].trim(),
        date: m[2].trim(),
        lines: [m[3] ?? ''],
      };
      continue;
    }

    if (current && line.startsWith('>')) {
      current.lines.push(line.replace(/^>\s?/, ''));
    }
  }

  flush();
  return entries;
}

function cleanMeta(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\r\n|｜:：*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function cleanEntryText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(
      /<!--\s*\/(?:ilc-global-thread|全局对话)\s*-->/gi,
      '&lt;!-- /ilc-global-thread --&gt;',
    )
    .replace(
      /<!--\s*(?:ilc-global-thread(?::\s*全局对话)?|全局对话)\s*-->/gi,
      '&lt;!-- ilc-global-thread --&gt;',
    )
    .trim();
}

function localIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
