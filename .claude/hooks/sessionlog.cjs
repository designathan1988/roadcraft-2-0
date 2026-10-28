// THE WHOLE SESSION, WORD FOR WORD, ON DISK, NOT DEPENDING ON ANYONE WRITING IT DOWN.
// SessionStart (compact, resume): reads the whole conversation file every hook is handed (`transcript_path`,
// https://code.claude.com/docs/en/hooks) line by line and writes docs/agent/session-log.md: every prompt of the owner's and every text the
// assistant wrote, as written, in order, with one line for each tool run (its name and what it was run on). Tool outputs are left out (they
// are what the files and commands hold, read again from them). Then it prints where the log is and the order to read its end.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');
const out = path.join(root, 'docs', 'agent', 'session-log.md');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch (error) {
    process.stderr.write(`sessionlog.cjs: the hook's input is not JSON (${error.message})\n`);
    process.exit(0);
  }
  const file = input.transcript_path;
  if (typeof file !== 'string' || !fs.existsSync(file)) return;
  void write(file);
});

const oneLine = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}...` : t; };

async function write(file) {
  const parts = [`# This session word for word (written by .claude/hooks/sessionlog.cjs from ${file}; tool outputs left out)\n`];
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"message"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain || !r.message) continue;
    const at = typeof r.timestamp === 'string' ? r.timestamp.replace('T', ' ').slice(0, 19) : '';
    const content = r.message.content;
    if (r.type === 'user') {
      // The owner's own prompt (a string, or text blocks); tool results are not his words.
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      if (text.trim() && !text.startsWith('<system-reminder>')) parts.push(`\n## OWNER ${at}\n\n${text.trim()}\n`);
      continue;
    }
    if (r.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'text' && b.text && b.text.trim()) parts.push(`\n## ASSISTANT ${at}\n\n${b.text.trim()}\n`);
      if (b.type === 'tool_use') {
        const i = b.input || {};
        parts.push(`- tool ${b.name}: ${oneLine(i.description || i.file_path || i.command || i.query || i.url || i.pattern || '', 220)}\n`);
      }
    }
  }
  const text = parts.join('');
  fs.writeFileSync(out, text);
  process.stdout.write(`THE WHOLE SESSION WORD FOR WORD is in docs/agent/session-log.md (${text.length} characters, written now from the `
    + 'conversation on disk: every owner prompt, every text of the assistant, one line a tool). BEFORE ANY WORK: read its last 60,000 '
    + 'characters (Read with offset near the end) to know what the task was, what was found and what was being done, then docs/agent/work.md.\n');
}
