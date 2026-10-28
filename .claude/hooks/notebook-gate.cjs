// Stop hook: a turn that read code, edited or ran commands does not end until docs/agent/work.md (the task's notebook) was written in it.
// Claude Code lets a Stop hook block the end of a turn with {"decision": "block", "reason": ...} (https://code.claude.com/docs/en/hooks);
// `stop_hook_active` true means it is already continuing because of a Stop hook, and then it is let through (no endless loop).
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');
const notebook = path.join(root, 'docs', 'agent', 'work.md');
/** The tools that are work on the task (the notebook must say what they found or did). */
const WORK = new Set(['Read', 'Edit', 'Write', 'Bash', 'PowerShell', 'Grep', 'Glob', 'NotebookEdit']);
const TAIL = 4 * 1024 * 1024;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { process.exit(0); }
  if (input.stop_hook_active || typeof input.transcript_path !== 'string' || !fs.existsSync(input.transcript_path)) return;
  const turn = thisTurn(input.transcript_path);
  if (!turn.started || !turn.worked) return;
  const written = fs.existsSync(notebook) && fs.statSync(notebook).mtimeMs >= turn.started;
  if (written) return;
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'docs/agent/work.md was not written in this turn, which read, edited or ran things. Write in it now what this turn read '
      + '(file:lines), found (file:line), changed and what is next, so the work survives a compaction; then end the turn.',
  }));
});

/** When the owner's last prompt came (ms), and whether the assistant ran work tools since. */
function thisTurn(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(size - start);
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);
  let started = 0, worked = false;
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line.includes('"message"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.isSidechain || !r.message) continue;
    const content = r.message.content;
    if (r.type === 'user' && (typeof content === 'string' || (Array.isArray(content) && content.some((b) => b.type === 'text')))) {
      const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text.trim() && !text.startsWith('<system-reminder>')) { started = Date.parse(r.timestamp) || started; worked = false; }
    }
    if (r.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b.type === 'tool_use' && WORK.has(b.name) && !String((b.input || {}).file_path || '').endsWith('work.md')) worked = true;
    }
  }
  return { started, worked };
}
