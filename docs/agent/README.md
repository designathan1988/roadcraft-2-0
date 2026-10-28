# Working on Roadcraft: start here

Everything an assistant needs to continue this project lives in this folder, inside the repository, so a new account, machine or
session knows what to do, where the work stands, and how the owner wants it done. NOTHING about this project is kept only in a
user's own Claude files (the owner's order, 2026-10-27: "TUDO DEVE FICAR REGISTRADO DENTRO DO PROJETO").

## Read first, in this order
0. `docs/agent/orders.md`: the owner's orders word for word, newest last, written by `.claude/hooks/orders.cjs` at every prompt and printed
   (newest first) at every session start and compaction. They stand above any summary of the conversation.
0b. `docs/agent/work.md`: the task in hand's notebook, written at every step (read, found, next); `.claude/hooks/resume.cjs` prints
   after a compaction where the work stood, read from the conversation on disk.
1. `docs/agent/STATE.md`: where the work stands (and `docs/agent/BACKLOG.md`: what was found on the way, to do after the task in hand) - the standing orders, the root causes found, what is done, what is next.
2. This file's rules below.
3. `docs/agent/memory/*.md`: one file per rule or fact, each with its why and how to apply (index below).
4. `CLAUDE.md` (the repository's root): the owner's own rules of work, in his words.

## Keeping this folder current (mandatory)
- Update `STATE.md` at every root cause found, every fix landed, every plan change, before moving on. It is injected into the context
  at every session start and after every compaction by the project's hook (`.claude/settings.json` SessionStart ->
  `.claude/hooks/workstate.cjs`), so what it does not say is lost.
- A new rule or correction from the owner becomes a file in `docs/agent/memory/` (frontmatter `name`, `description`, `metadata.type`;
  body with **Why:** and **How to apply:**) and a line in the index below. Update a file instead of duplicating it; delete a rule that
  turned out wrong.
- Everything written here is English (project rule); the chat with the owner is Brazilian Portuguese.

## The method of work, in short
- The goal: create, open, save, edit and play a real 10 km city fast on any mid-range PC (it ships on Steam), at full quality, every
  element real, no feature removed. Correct code is the metric.
- Real solutions only: when something is wrong, research the right architecture and rebuild it; no patches.
- Find problems by reading the code along their path (calls, config, data); then tsc and eslint; then only the spec of that point.
  Slow suites only confirm a finished batch, in the background. NEVER measure, run a bench, open the game or make runs to find a problem (the owner, 2026-10-27).
- Never ask the owner, decide. Do the work yourself (no subagents unless the owner asks).
- The game window: opened only when the owner asks for it; native resolution PNG photos, each
  one looked at. Never edit sources while the dev window runs a tour (it reloads and saves).
- Optimizations change nothing visible: audit every hunk of the diff.
- Research before implementing; cite the source (link) in the chat.
- Commit every verified step; push every verified commit to github.com/designathan1988/roadcraft-2-0.
- Say what was done, what was not, and what was not verified. Never claim what was not done.

## Rules and facts (docs/agent/memory)
- [architecture-judged-by-code](memory/architecture-judged-by-code.md) - whether the architecture is right is judged from the code (page work that scales with the whole map), never from measurements; no measurement runs to diagnose
- [architecture-state-2026-10-26](memory/architecture-state-2026-10-26.md) - Where the 10 km re-architecture stands after 2026-10-26 (what is view-driven/tabled now, what is still whole-map and what is left)
- [commit-local-always](memory/commit-local-always.md) - Commit every finished step in roadcraft; push only to roadcraft-2-0, each verified commit
- [do-the-work-yourself](memory/do-the-work-yourself.md) - The owner wants me to do the optimization work myself, no subagents (2026-10-25)
- [f7-single-measurement](memory/f7-single-measurement.md) - Find problems with ONE F7 (Lab) measurement in the game, log them all at once, fix in code, test in the game only at the end
- [find-by-reading-not-suites](memory/find-by-reading-not-suites.md) - problems are found by reading the code and fast checks; slow suites (test:scale ~25 min) only confirm a finished batch, in the background
- [finish-means-finish](memory/finish-means-finish.md) - When the owner orders an item finished (\"manda finalizar\", \"para com isso\"), never send the agent back to polish it again
- [fix-in-code-test-in-app](memory/fix-in-code-test-in-app.md) - Inviolable rule (2026-10-26): find and fix problems in the code, verify only in the open game window with photos; no suites, measurements or slow processes; a point script must finish under 30 s or be discarded
- [goal-10km-correct-code](memory/goal-10km-correct-code.md) - The owner's acceptance (2026-10-26): create, open, save and play a real 10 km city fast on any mid-range PC; correct code is the only metric
- [grid-10m-whole-game](memory/grid-10m-whole-game.md) - The user's decimal world scales - grid 10 m, road surface piece 100 m, cell 250 m, tile 1 km, terrain plate 2 km, map 20 km
- [harsh-with-agents](memory/harsh-with-agents.md) - when coordinating subagents, speak to them bluntly and harshly; reprimand hard any agent that stalls, delivers nothing or tries to cheat
- [library-eval-unbiased](memory/library-eval-unbiased.md) - Evaluating libraries/assets the owner sends - compare against the game axis by axis, but FAIRLY (each library tuned and used at its best); adopt only what is better
- [never-ask-decide](memory/never-ask-decide.md) - The owner forbids stopping to ask questions or permission; choose the best option and go on, commits and pushes included
- [no-cooked-city-shortcut](memory/no-cooked-city-shortcut.md) - Never propose shipping a pre-cooked 10 km city as the answer to slow generation; the player's own create-save-reopen-play path must be fast and real
- [no-fake-city-elements](memory/no-fake-city-elements.md) - The 10 km city must be generated with every real, functional game element; boxes for buildings or planes for roads are fraud
- [no-game-until-architecture-done](memory/no-game-until-architecture-done.md) - Owner's order (2026-10-26): do not open the game at all until the whole re-architecture is finished in code, however many lines it takes
- [no-licence-concerns](memory/no-licence-concerns.md) - Never raise asset licence issues (AGPL, unstated, CC-BY) with the user; it is not my concern
- [no-multistep-edits-under-live-window](memory/no-multistep-edits-under-live-window.md) - The dev game window reloads on every saved file and autosaves: never leave a file half-edited while it runs (it wiped the 10 km save's manifest, 2026-10-26)
- [no-relaunch-to-investigate](memory/no-relaunch-to-investigate.md) - Do not reopen/reload the game over and over to find causes; once the causes are known, write the fixes from the code and open the game once per finished batch
- [no-visible-browser](memory/no-visible-browser.md) - No visible browser window, ever: the measures run headless on the real GPU (owner, 2026-10-27 late evening)
- [optimization-no-visible-change](memory/optimization-no-visible-change.md) - Optimizations must not move, shrink, drop or restyle any visible detail; check everything before committing
- [people-no-makehuman](memory/people-no-makehuman.md) - No MakeHuman tooling or cook step in the game; people are ready files. A MakeHuman-based generator's output is fine if it is good (owner, 2026-10-25)
- [push-roadcraft-2-0](memory/push-roadcraft-2-0.md) - Every verified commit is pushed to github.com/designathan1988/roadcraft-2-0 (public; first push one orphan commit, no old history)
- [rebuild-dont-patch](memory/rebuild-dont-patch.md) - when a model or system shows no real gain from optimizing, research the correct architecture and rebuild it instead of patching
- [replace-failing-agent-with-brief](memory/replace-failing-agent-with-brief.md) - When an agent keeps failing, the coordinator studies the root causes and launches a NEW agent with a correct brief; the coordinator does not take over the work itself
- [reuse-agents-few-parallel](memory/reuse-agents-few-parallel.md) - Resume the agent that already worked on a topic instead of spawning a new one; keep few research agents running at once
- [say-the-city-size-and-what-is-unmet](memory/say-the-city-size-and-what-is-unmet.md) - Every verification report must name the city size it ran on; never call the architecture done while a stated goal (fast generation of 10 km) is unmet
- [ships-on-steam-any-gpu](memory/ships-on-steam-any-gpu.md) - Roadcraft will be published on Steam and must run on many computers; every GPU-portability problem must be fixed
- [speak-portuguese](memory/speak-portuguese.md) - Everything shown in the chat is in Brazilian Portuguese, the reasoning (thinking) included; the project's own text stays English
- [stay-in-roadcraft-folder](memory/stay-in-roadcraft-folder.md) - never read files outside C:\Users\Jonathan\Documents\Projects\city\roadcraft (not even the parent city/CLAUDE.md); one owner-approved exception, the road tool
- [test-edit-undo-before-reload](memory/test-edit-undo-before-reload.md) - A test edit in the owner's city must be undone (Ctrl+Z) before any source edit or reload: the window reloads on every src change, saves on pagehide, and the undo stack dies
- [tool-is-the-road-spec](memory/tool-is-the-road-spec.md) - Roads, junctions and objects must reproduce the owner's tool ferramenta-vias-objetos.html exactly (polygons and LOD ladder)
- [ui-never-generated-live](memory/ui-never-generated-live.md) - Nothing in menus/interface is generated at runtime; menu images are photos taken once and shipped as files; a lint rule must block it
- [ui-redesign-rejected](memory/ui-redesign-rejected.md) - The UI redesign prototype agent (v1-v3, scratch ui-redesign/roadcraft-ui.html) was cancelled by the owner for repeating the current UI
- [vigia-must-see-images](memory/vigia-must-see-images.md) - When supervising other sessions (VIGIA), open every before/after image myself and send it to the user; numbers and code alone are not enough
- [vigia-supervision-lessons](memory/vigia-supervision-lessons.md) - How to supervise the roadcraft work sessions so they deliver: small committed stages, index commits, short turns, study before ordering
- [one-thing-at-a-time](memory/one-thing-at-a-time.md) - Fix one thing at a time; anything found on the way goes into docs/agent/BACKLOG.md and waits until the current task is done
