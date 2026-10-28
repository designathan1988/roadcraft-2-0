# The task in hand: its notebook (printed whole at every session start and compaction by `.claude/hooks/notebook.cjs`)

## Task NOW (the owner, 2026-10-28 03:20): READ EVERYTHING, WHOLE, IN CHUNKS, before rewriting the mission
"LEIA TODA A CONVERSA, HISTÓRICO, DOCUMENTAÇÕES PARA COMPREENDER A FUNDO O QUE FOI ACHADO, DECIDIDO, ESTUDADO ... LEIA TUDO, EU DISSE
TUDO, EM CHUNKS, INTEGRALMENTE, TUDO, TOTALMENTE". The mission (MISSION.md) missed what the reports found (the people loading the whole
catalogue, things updated/created/copied every frame for nothing, what is not optimized, every problem already found).
MISSION.md is NOT ready: do not start its items; it is rewritten at the end of this reading.

How (keeps working across compactions):
1. `docs/agent/reading.md` lists all 249 written documents in order; read the first one not marked [x], whole, in chunks (Read
   offset/limit to its last line), then mark it [x].
2. After each document, append to `docs/agent/findings.md` every problem, its place, its state (FIXED commit / OPEN / DECIDED and why) and
   the solution decided. Commit reading.md and findings.md every few documents.
3. When every document is [x]: check each OPEN finding in the current code (file:line), then rewrite MISSION.md with every open problem
   and its real solution, and the two prompts in docs/agent/prompts/; verify every reference; tell the owner what was read (files, lines).
Already read whole before this list: the conversation text (session-log.md without tool lines, 8,258 lines).
Not readable whole, say so at the end: 16,272 raw JSON files (2.7 GB) and the conversation file's tool outputs (241 MB).

## Progress
- 249 of 249 documents read whole (2026-10-28); findings in docs/agent/findings.md (1,111 lines); code check in docs/agent/open-checked.md; MISSION.md and prompts/session.txt, goal.txt rewritten from them (2026-10-28).

## Progress of the goal (MISSION.md)
- 1a DONE: the layers' warm sets (roads, signs, furniture, every building part and furniture piece, a broken building's pieces, the tools' previews) put in the scene, hidden, before the opening's catalogue compiles (renderer.ts openingWarm), instead of after the first frame; the structures' sway kept the patch before it in the program key (wind.ts installStructureSway): a signal housing and its lenses no longer share one program. Specs openingWarm.spec.ts, swayProgramKey.spec.ts (fail with the fix undone). Checked, nothing to change: cellInstances.ts:216 posedMaterial patches once at the layer's creation (cellInstances.ts:653); release has no shader error queries (renderer.ts:519).

## Next
MISSION.md item 1b (people's palettes only for the batches drawn).
