// The owner's acceptance tests are the coordinator's alone (the owner's order, 2026-10-24): no agent may write, move or delete anything under
// tests/acceptance/, so a change that does not do what was ordered fails there and cannot be made to pass by editing the test. The coordinator
// unlocks it for its own edits with .claude/coordinator-acceptance.unlock. Local only: not part of the game.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const UNLOCK = path.join(__dirname, '..', 'coordinator-acceptance.unlock');
const PROTECTED = /tests[\\/]+acceptance([\\/]|$)/i;
// Shell commands that only read or run the tests.
const READ_ONLY = /^\s*(npx\s+(vitest|tsgo|tsc|eslint)\b|cat\b|head\b|tail\b|grep\b|rg\b|ls\b|wc\b|git\s+(diff|log|show|status)\b|Get-Content\b|Select-String\b)/i;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch (error) {
    process.stderr.write(`acceptance-lock: unreadable hook input: ${String(error)}\n`);
    process.exit(1);
  }
  // Only a subagent is refused (`agent_id` is present only inside one: https://code.claude.com/docs/en/hooks); the main session is the coordinator.
  if (!event?.agent_id || fs.existsSync(UNLOCK)) process.exit(0);
  const tool = String(event?.tool_name ?? '');
  const input_ = event?.tool_input ?? {};
  let touches = false;
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') touches = PROTECTED.test(String(input_.file_path ?? input_.notebook_path ?? ''));
  else if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input_.command ?? '');
    touches = PROTECTED.test(command) && !command.split(/&&|\|\||;|\n/).every((part) => !PROTECTED.test(part) || READ_ONLY.test(part));
  }
  if (!touches) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'acceptance-lock: tests/acceptance/ holds the owner\'s acceptance tests and only the coordinator writes them. Make your code pass them; report to the coordinator if you believe one is wrong.',
    },
  }));
  process.exit(0);
});
