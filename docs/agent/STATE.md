# Work state (injected at every session start and compaction by `.claude/hooks/workstate.cjs`)
KEEP THIS FILE UNDER 9,000 CHARACTERS: Claude Code cuts a hook's output past 10,000 to a 2 KB preview, and the state is lost at the
compaction (it happened on 2026-10-27: only the first lines reached the session). What is finished or old goes to `docs/agent/history.md`.

## ABOVE EVERYTHING (the owner, 2026-10-27)
- NO MEASURING: no bench, runtime layer, stall runs, far sheets; find and fix problems ONLY by reading the code and the static code graph;
  verify ONLY with tsc (`npm run typecheck`), eslint and the spec of the point. The game is opened only when the owner asks.
- Work alone, no subagents; never ask the owner, decide; commit each verified item (git-gate: create `.claude/coordinator-commit.unlock`
  in its own command before `git add/commit`, delete it after). Chat in Brazilian Portuguese; everything in the project in English.
- An optimization changes nothing visible and removes nothing. THE OWNER'S GAME WINDOW IS OPEN and reloads on every edit under `src/`:
  a broken edit breaks the game in front of the owner at once.

## REVERTED (the owner, 2026-10-27 night): "volte para o estado anterior à criação do banco de dados"
The game's code (src, tests, scripts, eslint.config.js) is back to 7c4de70f, the last commit before the code graph's database (ca2bcf8e)
and everything after it: the phases -1/0/1, the stall tooling, the frame contracts (still scene, upload queue, solids, RoadTop...). The owner:
the game was worse in everything (graphics, functions, slower opening, new roads not showing). Kept: CLAUDE.md (compact instructions),
.claude (hooks), docs, reports. The history keeps every reverted commit (git log) if any piece is wanted back. Nothing else to do until the
owner gives a new order.

## THE OWNER'S LATEST ORDERS (2026-10-27 night, newest first)
- "Pesquisa na internet e corrija o problema do compact": the context lost at compaction. Done from the official docs: this file under the
  hooks' 10,000-character cap (`workstate.cjs` never cuts silently); `CLAUDE.md` "# Compact instructions" (keep the owner's orders verbatim,
  the mission, what is broken or uncommitted); the coordinator checklist given whole once a session and after each compaction, one line on
  other prompts (`.claude/hooks/coordinator-checklist.cjs`, SessionStart added in `.claude/settings.local.json`).
- "Veja tudo que você quebrou e fez errado; faça direito": audit every change of this mission for breakage by reading the code.
- "Não dá para criar vias, elas não aparecem": see BROKEN below.

Entry point and method: `docs/agent/README.md`. Rules: `docs/agent/memory/`. Branch: `otimizacao-geometria`. History: `docs/agent/history.md`.

## CURRENT MISSION: the frame contracts by the code graph (the owner, 2026-10-27 night)
`node scripts/codegraph/rules.mjs [--list] [--ceil]` checks what `src/main.ts:frame` reaches: c an upload outside the queue
(`uploads.ts` drainUploads/drainWrites/drainWarm), d a scene walk or recompile, e a loop over a whole-map collection, f a material made or
needsUpdate outside the compile gate, g a read that waits for the GPU. Goal: all five at ZERO (exceptions only in
`scripts/codegraph/exceptions.json`: effects' fixed small uploads, the instruments), each fix citing its chain and file:line, `--ceil`,
commit per item, the rules' output printed in the chat at the start and the end.
- Start: c 68, d 79, e 15, f 32, g 1 (`reports/codegraph/rules-start.txt`).
- Now (c2be8794): c 0, d 0, e 5, f 0, g 0; ceilings {c 0, d 0, e 5, f 0, g 0}.
- Left in e (whole-map passes run when the diary cannot say what changed): renderer `plantAll` (doc.trees), `trafficMapOf`
  (SimClient.load sends the map whole to the sim), `PlacedProduct.allKeys` / `BarrierProduct.allKeys` (the Derived spine's whole path;
  their chain went through RoadTop, check `--list` for the one left), `SurfaceInputs.rebuildAll`, `TileIndex.fileAll`, economy `priceAll`.
- Done in e: ragdoll solids by cell (`world/solids.ts`), the lots overlay always round the view (`LotTool.overlay` needs a view),
  the highest road over the screen's ground only (`RoadTop.heightIn`, `main.ts` surfaceTop).
- Done in c: the upload queue in `uploads.ts`: `sendRange`/`sendSpan`/`sendWhole` (what arrived, `UPLOAD_BYTES` a frame), `sendThisFrame`
  (the frame's own state, counted first), `sendCopy` (copies; `thisFrame` for a batch's packed indices), `drainWrites` once a frame before
  the draw (`renderer.ts`); new textures handed to `queueUpload`; palettes: `sendPalettes` before the drain, `renderPalettes` after. Specs
  that read what was sent call `tests/render/support/drained.ts` first.
- Done in d: the scene is a still tree (`stillTree.ts` holdStill(scene)); whatever moves as an object calls `updateMatrix()` where it moves.

## BROKEN / TO WATCH (the owner reported, 2026-10-27 night: "new roads do not show")
- Found by reading: `GpuBatchedMesh.compact` sends its packed indices later (bbbfadf7); a growth right after a packing
  (`setGeometrySize`, the far road batches `networkFarRoads.ts` / `farBlockBatches.ts`, `shellBatch.ts`) copied the index buffer before
  they were in it and the old buffer took them away: batches drawn with no triangles. Fixed (56f77c1a, 7aeaf0d9: the unsent indices move
  to the fresh buffer). Also found and fixed: the queue held what arrived behind the frame's own state, one array a frame (3b20d820),
  and capped writes to arrays already drawn (c2be8794: every write now sent before the draw, drained again right before post.render).
  NOT confirmed in the game. If roads still do not show, read next: the road paint tables (`roadPaint.ts` sendTexels
  / dataTable now queued), the queue's order (`drainWrites`), the still scene (`stillTree.ts`).
- Specs failing that the mission did not touch (files unchanged): buildingsVisibleSame, cellAffinity, interiorSolids, surfaceReads x2,
  editor/cityTiles, ui/decimals (main.ts toFixed), scale/census/sceneCensus.
- Uncommitted, not mine to commit now: `.claude/settings.json` (owner), `scripts/lib/flightRecorder.mjs`, `scripts/stalls*.mjs` (the
  cancelled stall mission's tools).

## Notes
- The speed mission's phases (-1 and 0 done, 1 in progress) and the stall mission are in `docs/agent/history.md`; both are paused.
- Push procedure: `docs/agent/memory/push-roadcraft-2-0.md` (not asked in this mission).
