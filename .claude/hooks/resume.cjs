// WHERE THE WORK STOOD, TAKEN FROM THE CONVERSATION ITSELF, AFTER A COMPACTION OR A RESUME.
// A compaction keeps only a summary written by the model, so what the assistant was doing, its plan, the files it read and edited and
// where it stopped were lost with the conversation. The whole conversation stays on disk (`transcript_path`, given to every hook:
// https://code.claude.com/docs/en/hooks), so this SessionStart hook (compact, resume) reads its end and prints, within the 10,000
// characters a hook hands over whole: the task list as it last stood, the assistant's last words, the last tools run, the files edited and read.
const fs = require('node:fs');

/** What the printed summary may take, under the hook's 10,000 characters. */
const MOST = 9500;
/** How much of the conversation's end is read: its last records, never the whole file (it grows to hundreds of MB). */
const TAIL = 6 * 1024 * 1024;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch (error) {
    process.stderr.write(`resume.cjs: the hook's input is not JSON (${error.message})\n`);
    process.exit(0);
  }
  const file = input.transcript_path;
  if (typeof file !== 'string' || !fs.existsSync(file)) return;
  process.stdout.write(summary(records(file)));
});

/** The conversation's last records, oldest first. */
function records(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(size - start);
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);
  const lines = buffer.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a record cut at the tail's start: not one of the conversation's */ }
  }
  return out;
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}...` : text);

/** The record's content blocks (a message's), as a list. */
function blocks(record) {
  const content = record.message && record.message.content;
  return Array.isArray(content) ? content : [];
}

function summary(list) {
  let plan = null;
  const words = [], tools = [];
  const edited = new Set(), read = new Set();
  for (const record of list) {
    if (record.type !== 'assistant' || record.isSidechain) continue;
    for (const b of blocks(record)) {
      if (b.type === 'text' && b.text && b.text.trim()) words.push(b.text.trim());
      if (b.type !== 'tool_use') continue;
      const i = b.input || {};
      if (b.name === 'mcp__ccd_turn__update_plan' && Array.isArray(i.items)) plan = i.items;
      if ((b.name === 'Edit' || b.name === 'Write') && i.file_path) { edited.delete(i.file_path); edited.add(i.file_path); }
      if (b.name === 'Read' && i.file_path) { read.delete(i.file_path); read.add(i.file_path); }
      const what = i.description || i.file_path || i.command || i.query || i.url || i.pattern || '';
      tools.push(`${b.name}: ${clip(String(what).replace(/\s+/g, ' '), 160)}`);
    }
  }
  let out = 'WHERE THE WORK STOOD BEFORE THIS COMPACTION, read from the conversation on disk by .claude/hooks/resume.cjs (it does not '
    + 'depend on the summary). Continue from here: the task, its plan and the last steps below are what was being done.\n';
  if (plan) out += `\nTASK LIST AS IT LAST STOOD:\n${plan.map((p) => `- [${p.status}] ${p.content}`).join('\n')}\n`;
  const section = (title, items, n, each) => {
    if (!items.length) return '';
    return `\n${title}:\n${items.slice(-n).map((t) => `- ${clip(t, each)}`).join('\n')}\n`;
  };
  out += section('FILES EDITED (oldest first)', [...edited], 15, 200);
  out += section('FILES READ (oldest first)', [...read], 15, 200);
  out += section('LAST TOOLS RUN (oldest first)', tools, 25, 170);
  // The assistant's own last words: as many as fit, newest kept.
  const head = '\nTHE ASSISTANT\'S LAST WORDS (oldest first):\n';
  const kept = [];
  let room = MOST - out.length - head.length;
  for (let k = words.length - 1; k >= 0 && room > 300; k--) {
    const w = `- ${clip(words[k].replace(/\n+/g, ' '), Math.min(900, room - 10))}\n`;
    kept.unshift(w);
    room -= w.length;
  }
  if (kept.length) out += head + kept.join('');
  return out.slice(0, MOST);
}
