---
name: reviewing-whole-codebase
description: Reads every file of any project to its last line with internet research at every step, writes a durable note that describes each file line range by line range, finds every problem by tracing the code, verifies and fixes each one in the code with cited official documentation, and only then tests the running application in Google Chrome with human-like gestures and high-resolution screenshots. Hooks enforce all of it and restore the work after auto-compaction, /compact, /clear or a new session.
when_to_use: The user asks to read, analyze, audit or review a whole codebase or folder completely, without skipping anything, find and fix all errors, and test the application as a real user.
argument-hint: "[fix|audit] [folder] [goal]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" *) PowerShell(node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" *) Bash(node "${CLAUDE_SKILL_DIR}/scripts/browser.mjs" *)
---

# Reviewing a whole codebase

Arguments: `$ARGUMENTS`

The work lives in `.whole-review/` at the project root. Hooks record facts the model cannot fake (line ranges returned by Read, pages opened with WebFetch, edits, commands, screenshots looked at) and the script refuses every step those facts do not support. Ledger: `node "${CLAUDE_SKILL_DIR}/scripts/ledger.mjs" <command>`. Browser: `node "${CLAUDE_SKILL_DIR}/scripts/browser.mjs" <command>`. Always in exactly that form.

## Rules for the whole task

1. **Research on the internet all the time, never from memory.** Every time the work depends on how a language feature, library, framework, API, tool or platform behaves (reading a file that uses it, judging a finding, choosing a fix), open its official documentation for the installed version with WebFetch at that moment, and cite it. One search at the start is not research: each file, each decision and each fix needs its own. The hooks record what was opened and when; citations of pages not opened for that purpose are refused. Search results alone are not reading: open the page.
2. **Read every listed file to its last line with the Read tool**, chunk by chunk as `next` says. Only ranges the hook recorded count.
3. **Understand while reading.** After each chunk, describe it in the file's note: what each line range holds, contracts, state, data flow, who it uses and who uses it, and the sources researched for it. `done` refuses an incomplete note, and a code file's note without pages opened while reading it.
4. **Write each problem into `FINDINGS.md` the moment it is seen** (`suspected`, with `What:`, `Proof:`, `Effect:`, `Check:`).
5. **Nothing is run, tested or measured during the code work** (phases read, verify, fix): no tests, benchmarks, measurements, scripts or app runs. A hook allows only the ledger, the declared static check (type checker or linter), git read commands, `ls` and version queries. Everything is decided by reading the code and its documentation.
6. **No change to project files before phase fix** (a hook denies it), and in phase fix only for the finding in hand (`work F-NNNN`) after researching it.
7. **The application is tested only when the whole code block is done** (phase apptest): in Google Chrome through `browser.mjs`, with human pointer paths, real clicks, drags, typing and scrolling, a high-resolution screenshot after every gesture, every screenshot looked at and analysed, every console, page and network error triaged. Browser MCP tools are blocked: their gestures are robotic.
8. **Knowledge comes from the record, not memory**: before using what an earlier file does, open its note or Read it again. Keep `.whole-review/CURSOR.md` current.
9. **Do not stop before `finish` succeeds.** Stop for real only on a recorded blocker or when the user asks to pause (`pause`).
10. **Project instructions come first** (CLAUDE.md and similar) for commands, commits, language and scope.

## Start

1. If `.whole-review/state.json` exists, run `status` and continue from NEXT; never start over.
2. Read the project's instructions and manifests to find its static check (type check or lint) and how the app starts and on which URL.
3. `init --mode fix|audit --goal "<the user's request, word for word>"` plus `--scope <folders>` if the user named some and `--check "<static check command>"`. Then `set-app --start "<command that starts the app>" --url <url> [--suite "<its test suite>"]`, or `set-app --none "<why there is no UI>"`.
4. Read `.whole-review/INVENTORY.md` and tell the user what will be read and what was skipped and why.

## Phase 1: read everything

Repeat until `next` says every file is read: `next` gives the chunk; `note <file>` creates the note; Read exactly that chunk; research on the internet everything those lines rely on (WebFetch the official docs) and describe the chunk in the note (`- a-b what these lines hold`; blank lines need no entry; ranges over 120 lines only as `(uniform: why)`); record problems and cross-file questions. Lines over 2,000 characters: `show <file> <a> <b>`. When the file is covered, finish the note (Summary, contracts and data flow, depends on / used by, problems, to check elsewhere, `## Sources` with the pages opened while reading it) and run `done <file>`. The method: [references/method.md](references/method.md) (read it whole first).

## Phase 2: verify every finding

`phase verify`. For each suspected finding: `work F-NNNN`; Read again its lines and each link of its proof; WebFetch the documentation that decides it; then `confirmed` (with `Proof:` and `Source:`) or `rejected` (with `Rejected because:` and `Source:`). A defect seen in the app test starts as `app:<screen>` and must be traced to its code (`path:line`) before it is confirmed.

## Phase 3: fix (fix mode)

`phase fix`. Order the confirmed findings by severity and shared cause; use the notes' "used by" to list who each change affects. For each: `work F-NNNN`; WebFetch how to do it correctly for the installed version; edit (the hook allows it only now); Read the changed lines and every affected caller again; update the notes; mark `fixed` with `Fix: path:line, ...`, `Fix source: <URLs opened before the edit>`, `Verified by: re-read path:a-b`. Run the static check as a plain command (no pipe, no `|| true`); it must pass after the last edit. Blocked: `Blocker:` and `Tried:`.

## Phase 4: test the application (after all the code work)

`phase apptest` opens a round. Read [references/app-testing.md](references/app-testing.md) whole. Start the app with the declared command (in the background), then `browser.mjs start --url <url>`. Use the app as its users would, task by task, on desktop and then `viewport mobile`: every screen, control, form, menu, drag, keyboard path, empty/error/long-content state. Read every screenshot, describe it in the round's `ANALYSIS.md` under its scenario, record every defect of any kind (function, layout, text, contrast, alignment, feedback, usability, console errors) as a suspected finding with `Evidence:`. `browser.mjs stop` when done. If anything was found: `phase verify`, `phase fix`, and a new `phase apptest` round. When a round finds nothing: `finish`.

## Finish

`finish` refuses while anything is open. It writes `.whole-review/REPORT.md` and removes the hooks and permissions. Tell the user what the report shows: files and lines read, skipped and why, research made, findings by status with sources, fixes and how they were checked, app-test rounds with screenshots and errors, what is blocked and why. Claim nothing the report does not show.

## After compaction, /clear or a new session

The SessionStart hook prints the progress, next action, the file or finding in hand, the app-test round state, CURSOR.md and the open findings. Read CURSOR.md and FINDINGS.md in full, run `status`, continue from NEXT; if this skill's text is gone from context, Read `${CLAUDE_SKILL_DIR}/SKILL.md` again.

## Commands

Ledger: `init`, `status`, `next`, `note <file>`, `done <file>`, `show <file> [a] [b]`, `skip <file> --reason "..."`, `set-check "<cmd>"`, `set-app ...`, `work F-NNNN`, `phase verify|fix|apptest`, `pause`, `resume`, `finish`, `install`, `uninstall`, `context`. Browser: see references/app-testing.md.
