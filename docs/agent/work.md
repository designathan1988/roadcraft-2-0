# The task in hand: its notebook (printed whole at every session start and compaction by `.claude/hooks/notebook.cjs`)

## Task NOW (the owner, 2026-10-28): MISSION.md items 1b to 9 in order, then its End
Install and use the attached skill `reviewing-whole-codebase` (installed in `.claude/skills/reviewing-whole-codebase`). Use: one skill
cycle per mission item, `--scope` = the files of that item (read whole, notes, findings, verify, fix with cited docs); `set-app --none`
because the mission opens the game only once, at its End; after `finish` (hooks removed) run the item's spec and eslint, commit, publish
by `docs/agent/memory/push-roadcraft-2-0.md`. Settings (9e9c35ae): Agent denied, Stop hook holds the turn while `npm run typecheck` fails.
The reading that wrote the mission is done (249 of 249 documents, `reading.md`, `findings.md`, `open-checked.md`); the side tasks of
2026-10-28 are in `history.md`.

## Progress of the goal (MISSION.md)
- 1a DONE (d3a2d41e): the layers' warm sets (roads, signs, furniture, every building part and furniture piece, a broken building's pieces, the tools' previews) put in the scene, hidden, before the opening's catalogue compiles (renderer.ts openingWarm), instead of after the first frame; the structures' sway kept the patch before it in the program key (wind.ts installStructureSway): a signal housing and its lenses no longer share one program. Specs openingWarm.spec.ts, swayProgramKey.spec.ts (fail with the fix undone). Checked, nothing to change: cellInstances.ts:216 posedMaterial patches once at the layer's creation (cellInstances.ts:653); release has no shader error queries (renderer.ts:519).

- 1b DONE (skill cycle 1: renderer.ts 4411, riggedCitizens.ts 1203, crowdAnimation.ts 366 lines read whole; report in `.whole-review/REPORT.md` until the next cycle): re-found the cause at riggedCitizens.ts:823/1094 (the mission's renderer.ts:4112 is now 4150). Walkers are emitted only inside the camera frustum (agents.ts:2198), so "drawn or not" was the impostor cards: they take no palette (emit) but counted as rows, and a body drawn as cards alone ran its pass every frame; also the passes ran with the people layer switched off. Fix: `posed` rows apart from `count` (riggedCitizens.ts:76/807/816/1097), `if (effectSwitches.people)` at renderer.ts:4150. Spec tests/render/palettesDrawn.spec.ts (fails with the fix undone: [2] instead of []); castingMemory, palettePass, citizenPlays, ragdollFrame pass; typecheck and eslint clean. Not covered by a spec: the renderer's people switch (one line).
- Skill defect seen (mine): `done` reads the note's sources only under a heading exactly `## Sources`, while `note` writes `## Sources (pages opened ...)`; worked round by renaming the heading. To fix in the skill after the mission.

## Next
MISSION.md item 1c (render targets reallocated when the canvas flips 1079/1080 px).
