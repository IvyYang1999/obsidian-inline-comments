/**
 * Consecutive plain replies by the same author on the same day read as one
 * message: the panel shows one header for them and counts them as one unread.
 * Markers (resolve / react) are not entries and do not break a run.
 */
interface Entry { author: string; type: string; date: string }

const MARKERS = new Set(['resolve', 'react']);

/** For each entry index: the index of the entry that heads its run (itself when it starts one) */
export function runHeads(comments: Entry[]): number[] {
  const heads: number[] = [];
  let prev = -1;
  comments.forEach((c, i) => {
    if (MARKERS.has(c.type)) { heads.push(i); return; }
    const p = prev >= 0 ? comments[prev] : undefined;
    const continues = c.type === 'reply' && !!p && p.author.toLowerCase() === c.author.toLowerCase() && p.date === c.date;
    heads.push(continues ? heads[prev] : i);
    prev = i;
  });
  return heads;
}

/** Unread count where a run counts once: `unread(i)` says whether entry i is an unread reply */
export function countUnreadRuns(comments: Entry[], unread: (i: number) => boolean): number {
  const heads = runHeads(comments);
  const runs = new Set<number>();
  comments.forEach((_, i) => { if (unread(i)) runs.add(heads[i]); });
  return runs.size;
}
