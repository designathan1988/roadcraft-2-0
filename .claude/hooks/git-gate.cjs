// Nothing reaches git without the coordinator (the owner's order, 2026-10-24): every command that writes history, the index or the
// working copy through git is refused unless the coordinator has unlocked it for its own commit. Agents edit files; only the coordinator,
// after checking them, commits. Local only: not part of the game.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const UNLOCK = path.join(__dirname, '..', 'coordinator-commit.unlock');
// git verbs that change history, the index, refs or the working copy's files.
const WRITES = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+(commit|push|reset|stash(?!\s+(?:list|show)\b)|restore|clean|rebase|merge|cherry-pick|revert|am|apply\s+--cached|update-index|update-ref|branch\s+-[dDmMf]|tag|checkout\s+(?:--\s|\S+\s+--\s|-[bBf]\b|\.)|switch|rm\b|mv\b|add\b)/;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch (error) {
    process.stderr.write(`git-gate: unreadable hook input: ${String(error)}\n`);
    process.exit(1);
  }
  const command = String(event?.tool_input?.command ?? '');
  // Commands that only point git at a scratch index (the coordinator's snapshots) write no real history.
  const snapshot = /GIT_INDEX_FILE=/.test(command);
  // Only a subagent is refused: Claude Code hands a hook `agent_id` only when it fires inside a subagent or teammate
  // (https://code.claude.com/docs/en/hooks, "agent_id"). The main session is the coordinator and commits without an unlock file, which
  // auto mode cannot write anyway: `.claude/` is a protected path (https://code.claude.com/docs/en/permission-modes).
  if (!event?.agent_id || !WRITES.test(command) || snapshot || fs.existsSync(UNLOCK)) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'git-gate: this git command changes history, the index or files through git. Only the coordinator commits, after verifying the change. Agents: do not run it; report your change to the coordinator instead.',
    },
  }));
  process.exit(0);
});
