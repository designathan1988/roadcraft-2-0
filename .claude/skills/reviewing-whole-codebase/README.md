# reviewing-whole-codebase (Claude Code skill)

Reads every file of any project to its last line with internet research at every step, writes a note that describes each file line range by line range, finds and proves every problem in the code, fixes it with cited documentation, and only then tests the running application in Google Chrome with human-like gestures and high-resolution screenshots. The work survives auto-compaction, `/compact`, `/clear` and new sessions.

## Install

Copy this folder to `~/.claude/skills/reviewing-whole-codebase/` (all projects) or `<project>/.claude/skills/reviewing-whole-codebase/` (one project). Needs Node 18+, and for the app test Google Chrome plus Playwright (taken from the project; if absent: `npm install --prefix <skill folder> playwright-core`). Run `/reviewing-whole-codebase [fix|audit] [folder] [goal]`.

## Phases

`read` (every file, chunk by chunk, researched and noted) → `verify` (each finding re-read and researched) → `fix` (each confirmed finding researched, edited, re-read; static check) → `apptest` (Chrome, human gestures, screenshots, errors) → back to verify/fix if the app test found defects → `finish`.

## What is enforced, and how

Facts come from Claude Code hooks (code.claude.com/docs/en/hooks), not from the model's word:

| Rule | Mechanism |
| --- | --- |
| Every line is read | PostToolUse on Read records the ranges returned (subagent reads do not count); `done` refuses a file with an unread line; lines over 2,000 characters are read with `show` |
| Each file is understood | `done` refuses a note that does not describe every non-blank line range; wide ranges only as `(uniform: why)`, listed in the report |
| Research all the time | PostToolUse on WebFetch/WebSearch records each page and search with the phase, the file being read and the finding in hand; a code file's note must cite pages opened while reading it; each decision (`Source:`) and each fix (`Fix source:`, opened before the edit) must cite pages opened for that finding; search results alone do not count |
| No change before its time | PreToolUse denies edits to project files except in phase fix, for the confirmed finding in hand (`work`), after research for it |
| Nothing run, tested or measured during the code work | PreToolUse on Bash/PowerShell allows only the ledger, the static check, git read commands, `ls` and version queries before phase apptest; in apptest also the app start command, its test suite and the browser driver |
| A finding is decided on the current code | confirm/reject is refused unless its lines were Read again in phase verify |
| A fix is real | `fixed` needs `Fix: path:line` with edits recorded under that finding, and `Verified by: re-read path:a-b` of the changed lines read after the last edit; the static check must pass after the last edit (piped or `|| true` runs do not count) |
| Real-user app test | browser automation MCP tools are denied; `browser.mjs` moves the pointer on WindMouse paths with Fitts's-law timing and overshoot, dwells before pressing, holds buttons, drags past the threshold, types with uneven timing, scrolls in uneven bursts; a 3840x2160 (desktop) or 1170x2532 (mobile) screenshot after every gesture; console/page/network errors logged with ids |
| Every screenshot analysed | a round closes only when every screenshot was Read and has a line in ANALYSIS.md, every error id is triaged, a click, keyboard use and scrolling happened, desktop and mobile were tested, Chrome was closed |
| App defects go back to code | an app-test finding must be traced to `path:line` before it is confirmed; a code change after a round started requires a new round |
| Nothing is left open | the Stop hook holds the session while work is open (lets go if nothing moved since the last hold) |
| Parallel tool calls lose nothing | every read-modify-write of the state is under a file lock |

## What keeps the work across compaction

Everything is in `<project>/.whole-review/`: `state.json` (inventory, ranges read, research, edits, commands, app-test rounds), `INVENTORY.md`, `notes/<path>.md`, `INDEX.md`, `FINDINGS.md`, `CURSOR.md`, `apptest/round-N/` (shots, log, ANALYSIS.md), `compactions/`, `REPORT.md`. The SessionStart hook puts the progress, the next action, the file or finding in hand, the app-test round state, CURSOR.md and the open findings back into context.

## Tests

- `node tests/run-tests.mjs`: every ledger command, gate and hook, fed the same JSON Claude Code sends.
- `node tests/browser-e2e.mjs`: drives real Google Chrome on an instrumented page and checks that pointer paths are curved and uneven, presses dwell and hold, drags drop, typing timing varies, scrolling is uneven, and screenshots are high resolution.
