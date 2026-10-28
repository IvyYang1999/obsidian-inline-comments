// Stand-in for `codex` in e2e: records each call, prints Codex's JSON events and
// answers the letter like a real session would — by appending a reply to the note.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.ILC_FAKE_HARNESS_LOG, JSON.stringify({ args, cwd: process.cwd(), prompt }) + '\n');
  const resume = args[0] === 'exec' && args[1] === 'resume';
  const thread = resume ? args[args.length - 2] : '0199e2e0-c0de-7000-8000-00000000c0de';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
  console.log(JSON.stringify({ type: 'turn.started' }));

  const rel = prompt.match(/- 文档：(.+)/)?.[1].trim();
  const passage = prompt.match(/- 划线原文：(.+)/)?.[1].trim();
  const name = prompt.match(/你在评论区的名字：([^）]+)/)?.[1].trim();
  if (!rel || !passage || !name) {
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'fake codex: letter not understood' } }));
    process.exit(1);
  }
  const file = path.join(process.cwd(), rel);
  let doc = fs.readFileSync(file, 'utf8');
  const at = doc.indexOf(`{==${passage}==}`);
  let end = doc.indexOf('<<}', at) + 3;
  while (doc.startsWith('{>>', end)) end = doc.indexOf('<<}', end) + 3;
  doc = `${doc.slice(0, end)}{>>${name}|2026-10-28|reply: 假 Codex 第${resume ? '二' : '一'}次回复<<}${doc.slice(end)}`;
  fs.writeFileSync(file, doc);
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
