// SessionStart hook (every start, resume, clear and compaction): prints the task's notebook, docs/agent/work.md, whole into the context,
// so a new session or a compacted one has the task, what was read, what was found and what is next without having to choose to read it.
// Claude Code adds a SessionStart hook's stdout to the context (https://code.claude.com/docs/en/hooks-guide#re-inject-context-after-compaction);
// past 10,000 characters only a 2 KB preview arrives, so past that the start is printed with an order to read the rest.
const fs = require('node:fs');
const path = require('node:path');

/** What a hook may print and still reach the session whole (Claude Code's limit is 10,000 characters). */
const MOST = 9500;
const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');
const notebook = path.join(root, 'docs', 'agent', 'work.md');
const head = 'THE TASK IN HAND, its notebook docs/agent/work.md printed whole: continue from its "Next".\n\n';
if (fs.existsSync(notebook)) {
  const text = fs.readFileSync(notebook, 'utf8');
  if (head.length + text.length <= MOST) process.stdout.write(head + text);
  else {
    const order = `\n\nWORK.MD IS ${text.length} CHARACTERS, PAST WHAT A HOOK CAN HAND OVER: READ docs/agent/work.md IN FULL NOW, and cut what is done out of it.\n`;
    process.stdout.write(head + text.slice(0, MOST - head.length - order.length) + order);
  }
}
