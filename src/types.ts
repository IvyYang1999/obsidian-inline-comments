export type CommentType =
  | 'agree'
  | 'disagree'
  | 'question'
  | 'important'
  | 'note'
  | 'reply';

export interface CommentEntry {
  author: string;
  date: string;
  type: CommentType;
  text: string;
}

export interface Annotation {
  /** Unique id derived from position: `ann-{from}` */
  id: string;
  /** The raw text that was highlighted */
  highlightText: string;
  /** Ordered list of comments / replies in this thread */
  comments: CommentEntry[];
  /** Start offset of `{==` in the document */
  from: number;
  /** End offset of the last `<<}` in the document */
  to: number;
}

export const COMMENT_TYPE_META: Record<
  CommentType,
  { label: string; emoji: string; colorVar: string }
> = {
  agree:     { label: '认同',   emoji: '🟢', colorVar: '--ilc-agree'     },
  disagree:  { label: '不认同', emoji: '🔴', colorVar: '--ilc-disagree'  },
  question:  { label: '疑问',   emoji: '🟡', colorVar: '--ilc-question'  },
  important: { label: '重要',   emoji: '🔵', colorVar: '--ilc-important' },
  note:      { label: '备注',   emoji: '⚪', colorVar: '--ilc-note'      },
  reply:     { label: '回复',   emoji: '💬', colorVar: '--ilc-reply'     },
};
