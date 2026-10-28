// SessionStart hook (every start, resume, clear and compaction): prints the owner's mission, docs/agent/MISSION.md, whole into the
// context, so every session and every compacted one has the full list of what must be done, in order, and the rules.
// Claude Code adds a SessionStart hook's stdout to the context (https://code.claude.com/docs/en/hooks-guide#re-inject-context-after-compaction);
// past 10,000 characters only a 2 KB preview arrives, so past that the start is printed with an order to read the rest.
const fs = require('node:fs');
const path = require('node:path');

/** What a hook may print and still reach the session whole (Claude Code's limit is 10,000 characters). */
const MOST = 9500;
const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');
const mission = path.join(root, 'docs', 'agent', 'MISSION.md');
if (fs.existsSync(mission)) {
  const text = fs.readFileSync(mission, 'utf8');
  if (text.length <= MOST) process.stdout.write(text);
  else {
    const order = `\n\nMISSION.MD IS ${text.length} CHARACTERS, PAST WHAT A HOOK CAN HAND OVER: READ docs/agent/MISSION.md IN FULL NOW.\n`;
    process.stdout.write(text.slice(0, MOST - order.length) + order);
  }
}
