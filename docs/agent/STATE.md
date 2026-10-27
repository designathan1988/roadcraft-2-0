# Work state (injected at every session start and compaction; keep it current at every milestone)

Entry point and method of work: `docs/agent/README.md`. Rules: `docs/agent/memory/`. Branch: `otimizacao-geometria`.

## The owner's standing orders (latest first, 2026-10-27)
- Everything about the project is recorded INSIDE the project (this folder), never only in a user's Claude files.
- Context must not be lost at compaction: this file is injected by the project's SessionStart hook; update it.
- The camera is slow to move and zoom, and the quality is low: fix it at the root. "QUERO SOLUÇÃO REAL EM TUDO, SEM MAIS REMENDOS":
  change the architecture, the models, anything, so it works right.
- Fix everything BEFORE any new city tour; no game window until the code is done, then one pass with photos (native PNG, window
  maximized).
- Building LODs look like boxes and the originals take too long to show; roads do not load in most points.
- Later: redo the heavy models (cars etc.) and the 7 runtime-painted textures (blast, signature, casualties, elements, lowPolyTrees,
  signs, utilities).

## Facts from the last tour report (lab-reports/tour-2026-10-27T15-29-08.md, 10 km city, RTX 3060, ultra)
- Street views: frame 21 ms (47 fps), CPU 19 ms, almost all of it "drawing": `postprocess.ts` scene pass, 9.3 ms a frame inside
  three's render (draw submission: `bindVertexArrayObject`/`getBindingState` hot, `projectObject` and shadow `renderObject`
  recursing 6-7 deep over the scene graph). ~490 draws. GPU 15-19 ms.
- GTAO 2.7-4.1 ms GPU (it reads the scene's depth: no second scene pass).
- Far building masses: 8.4 M triangles at the whole-city view (`building-massing-plate` 334 k in one draw): more triangles than pixels.
- Building parts 2.5-2.8 M triangles (brise 533 k); far furniture rungs ship 1.8 M triangles their vertex shader throws away
  (`farLadders.ts` banded instances).
- JS heap 2.6 GB rising 313 MB/min, live geometries +486/min: a leak or an unbounded cache (to find by reading).
- 108 long tasks a minute while moving.
- `gpuBatchedMesh.ts:92` uploads a DataTexture 272 times a second.
- Each scene lands 4-6 s after the camera moves.

## Root causes found by reading code
1. Buildings look like boxes before loading: `src/render/buildings/massBase.ts` (the top level, drawn wherever nothing finer stands) is
   plain prisms with one 5-6-5 paint per vertex, pitched roofs flattened at half their rise; `massingMaterial.ts` base branch has no
   facade attributes, so no windows and no night lights (a black box at night).
2. Detail late on approach: `src/render/buildings/cellPool.ts` `KEPT_KINDS` leaves out 'cell' (the detail), so it is rebuilt by a worker
   at every approach and every launch; old kept keys of a cell are never forgotten when replaced (the store only grows).
3. Roads: `src/render/mesh/roadResidency.ts` builds detailed blocks only for cells the view wants, `BRING_PER_LOOK = 3` a look; the root
   far level (`networkFarRoads.ts`, a 1 km tile a job, painted by `applyRoadFarPaint`) stands meanwhile.

## Done and committed
- f0c830c3 menus show ready photos (`src/ui/photos`), lint rule `no-live-interface`.
- 51c3de4c diagnosis: reports, tour, hidden work, waste.

## In progress (uncommitted)
- Tour photos at native PNG (`src/lab/doctor/tour.ts`, `report.ts`, `scripts/vite/labReports.ts` `/__lab/shot`).
- `docs/agent/` (this folder), the project hook `.claude/settings.json` + `.claude/hooks/workstate.cjs`.

## Next (in order)
1. Keep the detail 'cell' in the derived cache, forget a cell's superseded kept keys.
2. The base level with the facade grid (windows, night lights) and real roof shapes.
3. Roads: build the wanted cells without the per-look throttle starving the view; prefetch round the view.
4. Camera cost: the scene graph and draws per frame; the heap growth; the DataTexture uploads.
5. tsc, eslint, the points' specs; commit; push; then one tour with photos.

## Notes for working here
- `.claude/hooks/git-gate.cjs` refuses git writes unless `.claude/coordinator-commit.unlock` exists: create it for your own verified
  commit, delete it after.
