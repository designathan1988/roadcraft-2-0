// SessionStart hook (every start, resume, clear and compaction): prints the project's work state and where its method of work is, so a
// new session, account or compaction loses nothing decided or found. Claude Code adds a SessionStart hook's stdout to the context
// (https://code.claude.com/docs/en/hooks#sessionstart).
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');
const state = path.join(root, 'docs', 'agent', 'STATE.md');
process.stdout.write('Read docs/agent/README.md (method of work, rules index) before working. The work state follows.\n\n');
if (fs.existsSync(state)) process.stdout.write(fs.readFileSync(state, 'utf8'));
else process.stdout.write('docs/agent/STATE.md is missing: rebuild it from git log and docs/agent/memory before working.\n');
