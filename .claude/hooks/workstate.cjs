// SessionStart hook (every start, resume, clear and compaction): prints the project's work state and where its method of work is, so a
// new session, account or compaction loses nothing decided or found. Claude Code adds a SessionStart hook's stdout to the context
// (https://code.claude.com/docs/en/hooks#sessionstart), but an output past 10,000 characters is saved to a file and only a 2 KB preview
// reaches the session: the state was lost that way at a compaction (2026-10-27). The state is printed whole while it fits; past the limit,
// the part that fits, cut at a section, and an order to read the file in full.
const fs = require('node:fs');
const path = require('node:path');

/** What a hook may print and still reach the session whole (Claude Code's limit is 10,000 characters). */
const MOST = 9500;
const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');
const state = path.join(root, 'docs', 'agent', 'STATE.md');
const head = 'Read docs/agent/README.md (method of work, rules index) before working. The work state follows.\n\n';
if (!fs.existsSync(state)) {
  process.stdout.write(`${head}docs/agent/STATE.md is missing: rebuild it from git log and docs/agent/memory before working.\n`);
} else {
  const text = fs.readFileSync(state, 'utf8');
  if (head.length + text.length <= MOST) process.stdout.write(head + text);
  else {
    const order = `\n\nSTATE.MD IS ${text.length} CHARACTERS, PAST WHAT A HOOK CAN HAND OVER: READ docs/agent/STATE.md IN FULL NOW, before anything else, and cut it under 9,000 characters (the finished parts to docs/agent/history.md).\n`;
    const room = MOST - head.length - order.length;
    const cut = text.lastIndexOf('\n## ', room);
    process.stdout.write(head + text.slice(0, cut > 0 ? cut : room) + order);
  }
}
