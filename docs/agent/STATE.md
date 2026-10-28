# Work state (injected at every session start and compaction by `.claude/hooks/workstate.cjs`)
KEEP THIS FILE UNDER 9,000 CHARACTERS AND TRUE. It is what comes back after a compaction: a stale line here is a lie told to the next
context (2026-10-28: it still named the reverted code-graph mission as current). Rewrite it at once when a task starts, ends or changes.
What is finished or old goes to `docs/agent/history.md`.

## ABOVE EVERYTHING (the owner)
- NO MEASURING: no bench, probes, stall runs, sheets; find and fix problems ONLY by reading the code; verify ONLY with tsc
  (`npm run typecheck`), eslint and the spec of the point. The game is opened only when the owner asks.
- Work alone, NO subagents; never ask the owner, decide; commit each verified item (the git and acceptance gates refuse
  only subagents, by the hook's `agent_id`: the main session commits with no unlock file). Chat in Brazilian Portuguese; everything in the project in English.
- An optimization changes nothing visible and removes nothing.

## WHERE THE GAME IS
The game's code (src, tests, scripts, eslint.config.js, package, desktop) equals 7c4de70f (src at a21b2fc2), restored by 7d424a23 and
published to roadcraft-2-0 (publish cbda5016). The code-graph mission and everything after ca2bcf8e are reverted (history.md).

## TASKS, IN ORDER (the owner's words are in `docs/agent/orders.md`)
0. NOW: the owner's goal of 2026-10-28: build `docs/agent/optimization-solution.md` section 4, steps 0-6, in order, each committed and
   published with tsc and its spec; no questions, no subagents, no measuring, the game opened once at the end for photos compared with
   7c4de70f (`imageCompare.ts`). Progress and next step: `docs/agent/work.md`. Done: step 0 (acc7debf), step 1 (bd376121). Steps 2, 3, 4, 6 not
   done, each with its proof in the code (work.md); step 5 = the far wall's cover share given its material back. Left: the photos.
   READ FIRST: the plan's section 5 (`optimization-solution.md`) lists what was decided earlier and must be kept or still done: one form
   per view for everything (the buildings still capped by budgets, `layer.ts` 303-318), clouds and fog out, the drag causes found with
   gestures, heavy models and run-time textures, the whole-map work left, the base built for the whole map, no fake and no compensation.
1. DONE (b42f2003 and the notebook hook): the context lost at compaction (orders of 2026-10-28 02:00-02:20). Findings:
   - This session already runs on the 1M window: it compacted 9 times, each at ~968k tokens (compactMetadata.preTokens in the
     transcript). A bigger window does not exist; `/autocompact` only makes it compact sooner.
   - What comes back from disk after a compaction (https://code.claude.com/docs/en/context-window#what-survives-compaction): the
     project-root CLAUDE.md, the plan written in plan mode, up to five recently changed files read again, invoked skill bodies, and the
     output of SessionStart hooks matching `compact`. Everything else is a summary.
   - The docs' prescription for long work (https://code.claude.com/docs/en/best-practices#keep-cost-and-context-down): one task per
     session, `/clear` between unrelated tasks, the task written to a file and a fresh session started from it.
   - What went wrong on 2026-10-28 02:21: the hooks handed back THIS file stale (a reverted mission as current) and another session's
     coordinator checklist (agents, roads SCOPE) through `.claude/settings.local.json`. Fixed: this file rewritten true, the checklist's
     hooks removed from the local settings.
   - The analysis is done in a fresh session (the owner, 2026-10-28), started from the notebook.

## AFTER A COMPACTION, IN THIS ORDER
1. The owner's orders printed above (`orders.cjs`, word for word, newest first): obey the newest.
2. "WHERE THE WORK STOOD" printed above (`resume.cjs`, from the conversation on disk).
3. `docs/agent/work.md` whole, and continue from its "Next".

## OPEN ISSUES (not confirmed fixed)
- The far buildings' wall gap is ~10% darker than the original (107,101,89 vs 119,105,88).
- Not mine, untracked: `scripts/*.tmp.mjs`, `play.mjs`, `inGameMarks.mjs`, `stalls_trace.py`, `tools/claude-gates/`, `research_notes/`.

Entry point and method: `docs/agent/README.md`. Rules: `docs/agent/memory/`. Branch: `otimizacao-geometria`. History: `docs/agent/history.md`.
Push procedure: `docs/agent/memory/push-roadcraft-2-0.md`.
