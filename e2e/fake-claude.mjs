// Stand-in for `claude` in e2e. Only print mode (`claude -p`, the background answer where no
// terminal can be opened) does anything: it records the call, answers the letter like a real
// session would — by appending a reply to the note — leaves a transcript behind as Claude Code
// does, and prints the JSON result. Anything else (a version check) just exits.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (!args.includes('-p')) process.exit(0);

const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sessionId = flag('--resume') ?? flag('--session-id');
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const log = path.join(path.dirname(process.env.ILC_FAKE_HARNESS_LOG), 'claude-runs.log');
  fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), prompt }) + '\n');
  const fail = (msg) => {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: msg, session_id: sessionId }));
    process.exit(1);
  };
  if (!sessionId) fail('fake claude: no session');
  const rel = prompt.match(/- 文档：(.+)/)?.[1].trim();
  const passage = prompt.match(/- 划线原文：(.+)/)?.[1].trim();
  const name = prompt.match(/你在评论区的名字：([^）]+)/)?.[1].trim();
  if (!rel || !passage || !name) fail('fake claude: letter not understood');

  const file = path.join(process.cwd(), rel);
  let doc = fs.readFileSync(file, 'utf8');
  const at = doc.indexOf(`{==${passage}==}`);
  let end = doc.indexOf('<<}', at) + 3;
  while (doc.startsWith('{>>', end)) end = doc.indexOf('<<}', end) + 3;
  const resumed = args.includes('--resume');
  doc = `${doc.slice(0, end)}{>>${name}|2026-11-05|reply: 假 Claude 后台${resumed ? '接着' : '第一次'}回复<<}${doc.slice(end)}`;
  fs.writeFileSync(file, doc);

  // `--session-id` starts the session: from now on its transcript exists and the next letter resumes it
  const dir = path.join(process.env.ILC_HOME ?? '', '.claude', 'projects', 'e2e-fake');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'user', cwd: process.cwd(), sessionId }) + '\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId }));
});
