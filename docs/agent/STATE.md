# Work state (injected at every session start and compaction; keep it current at every phase)

Entry point and method of work: `docs/agent/README.md`. Rules: `docs/agent/memory/`. Branch: `otimizacao-geometria`.
Everything before this mission (the work state up to 2026-10-27 evening, its diagnoses, measures and tries): `docs/agent/history.md`.

## THE MISSION (the owner, 2026-10-27 evening): Roadcraft fast for real in the 10 km city, with LOD faithful to the original
Work alone, no subagents, phases -1 to 4 in order. Commit (git-gate unlock for my own verified commit) and push to roadcraft-2-0
(`docs/agent/memory/push-roadcraft-2-0.md`) at the end of each phase. Research the official docs (three.js r186, meshoptimizer, WebGL2, Chrome
DevTools Protocol, V8) before each change and cite the link in the chat.

The 10 km city: the large city of seed 7 over a radius of 8 850 m (~249 000 buildings), opened by `scripts/lib/cameraPath.mjs`.

### Orders this mission supersedes (the mission wins; memory files updated in the same commit)
- "NO BAKING": measuring at runtime the look of each KIND OF BAY the city makes, by rendering emitBay's own geometry with the game's
  materials and lights while the city grows, is NOT a pre-cooked city: nothing is made outside the game nor shipped as a file.
- "No measurements", "do not test midway", "do not open the game until the end", "one F7 measurement": superseded. Measures are this
  mission's tools (the code graph, the camera bench, the far-building sheet), run only at the marked points. During implementation: tsc,
  eslint and the spec of the point changed.
- DETAIL_REACH (1.4 km): removed in Phase 3, after Phase 2 proves the far level faithful.
- Still standing: never ask, decide; never lower quality; never weaken tests; CLAUDE.md honesty.
- FORBIDDEN at the far level: colour constants, "mid tone", multipliers, hand-written light formulas.
- FORBIDDEN to revert the new architecture because a number got worse: fix the cause.

### Phases
- Phase -1, the code graph: `scripts/codegraph/` index (three-resolved GPU facts, deferred callbacks, guarded calls, recursion counted
  once), runtime layer (`runtime.mjs`: precise coverage counts and CPU profile on the bench path, mapped to the .ts by source maps),
  diagnosis queries (`reports/codegraph/diagnosis.md`), permanent rules (`rules.mjs`, ceilings = today's values, in `npm run verify`).
  From then on every fix comes from a diagnosis row, cites it, and the query is rerun to show the row gone.
- Phase 0, the bench: `scripts/bench-camera.mjs` (fixed seed, fixed rig path, per segment CPU/GPU p50-p99-max, frames > 33/50 ms, long
  tasks, draws, triangles, upload bytes, programs; heap and geometries) -> `reports/bench/baseline.json`; far-building sheet extended (5
  building kinds, 300/700/1400/2000/4000 m, Delta E 2000 per face per level against L0) -> `reports/far-sheet/baseline/`.
- Phase 1, frame cost and scale (image identical to the baseline): static instance buffers per cell and level band, one GPU upload queue
  with byte/ms caps, no first-draw compile, far levels simplified to their own screen error (meshoptimizer), fewer objects walked, the
  BatchedMesh indirect texture sent only on change, draw() systems only when their inputs change, clouds and fog removal finished, SMAA/GTAO
  cost at the far view, everything that grows with the map bounded by the view.
- Phase 2, faithful LOD by construction: per kind of bay (the CoverShell key) render the real emitBay geometry with its neighbours with the
  game's renderer, materials and lights in idle slices; a table of apparent reflectance per material slot over the light and view directions
  of the rig's domain (sun/fill/moon by the hour, elevation 20-90 degrees), resolution chosen by Delta E <= 1 against direct rendering; colour
  = sum over slots of slot albedo x table; night windows an emissive slot; the L1 and every far level read the table below the pixel; the
  CoverShell cover and everything orphaned removed. Criterion: far sheet Delta E 2000 <= 2 against L0 everywhere (at most 3 measurement fix
  cycles; never fix the colour).
- Phase 3, one form per view: each cell's level by screen error alone (DETAIL_REACH, DETAIL_REACH_VISIBLE, frameBudget's error scale and
  heldFar/heldCoarse swaps removed; the budget decides only load order and eviction); preload by camera direction and speed and the view's
  neighbours (Cesium preloadFlightDestinations, loadSiblings).
- Phase 4, final validation: bench, far sheet, code-graph rules, tsc, eslint, all specs, test:scale in the background, production build, one
  game pass with native PNG photos (street, district, whole city, night).

### Acceptance (10 km city, the bench path, this machine)
Pan and orbit: CPU p99 <= 16.7 ms, GPU p95 <= 14 ms, no frame > 50 ms. After a zoom: no frame > 50 ms, final levels in <= 2 s. Whole-city
view: triangles <= 3 x screen pixels. Heap and geometries stable (+-5 %) over 10 minutes of path loops. Every metric equal or better than the
baseline. Far sheet Delta E 2000 <= 2 everywhere. Near views identical to the baseline (differences only where something animates).

## PROGRESS
- Phase -1: DONE.
  - `scripts/codegraph/query.py` deleted (query.mjs replaces it). Node 24.22.0. Index: 864 files, 19 751 functions, 69 764 calls, ~7 s.
  - index.cjs: three's GPU calls by resolved declaration (`three:render`, `three:compile`, ...), material vs texture vs attribute
    needsUpdate by type, stored callbacks as `via='deferred'` edges (then/catch/finally, timers, idle/animation frame, addEventListener,
    on* handlers, object literals handed to queue calls), `guarded` 0/1 on every call. query.mjs: deferred edges not followed; a recursion
    (one strongly connected component) adds no heat (createFlatAtlas.askShape no longer tops the ranking). Spec: tests/codegraph/codegraph.spec.ts (5 pass).
  - Runtime layer `scripts/codegraph/runtime.mjs` (shared opener and path `scripts/lib/cameraPath.mjs`; frame recorder `__bench` in
    `src/main.ts`, probe builds only): round B (CPU profile) and round A (precise coverage) in two separate openings; A's coverage MUST start
    before navigation (started later it missed every call inside already optimised code: the first run counted none of the frame's culls).
    Run on the 10 km and the small city -> `reports/codegraph/diagnosis.md` (+ .json): a 50, b 25, c 34, d 25, e 210 rows.
  - Rules `scripts/codegraph/rules.mjs` in `npm run verify`; ceilings `scripts/codegraph/ceilings.json`: static c 71, d 79, e 15; runtime
    c 34, d 25, e 210. Graph shared by `graph.mjs`.
  - First fixes the diagnosis orders (drag, 10 km, ms a frame): createMassCells.syncBases 1.00 self (small city 0.008: grows with the map;
    every base's cells walked on any change); poleStores PartStore.view/sort + WireStore.sort ~1.5 (x10 the small city, uploads outside
    the queue); three's projectObject 3.05 total / renderObject 2.2 (objects walked); ScreenScale.atPoint 55 711 calls a frame.
- Phase 0: DONE (tools and baselines).
  - `scripts/bench-camera.mjs` -> `reports/bench/baseline.json` (+ `-clocks.csv`): 10 km city, ultra, 1920x1080, Chrome window on the
    dev server, `--shared-gpu` (the owner's Chrome held ~20 % of the 3D engine). The first run measured 1 fps in every segment: the city's
    first generation still building behind (renderer 1.3 k CPU s, 5.7 GB); the second run (city read back from the persistent profile,
    opened in 103 s, settled in 27 s) is the baseline. Baseline, per segment (CPU p50/p99/max ms, frames > 50 ms, GPU p95 ms, triangles,
    MB uploaded): district-pan 12.2/57.1/109, 8, 12.4, 1.88 M, 272 MB; street-pan 10.9/27.2/145, 2, 20.1, 5.61 M, 286 MB; zoom-in
    13.8/26.8/36, 0, 16.2; zoom-out 13.1/16.6/18.5, 0, 14.5; orbit 11.1/21.2/73, 1, 13.2, 2.0 M, 136 MB; whole-map 13.9/161/161, 12, 22.8;
    whole-map-settle 7.7/147/162, 4, 23.2, 7.80 M triangles (3 x 1920x1080 = 6.2 M: over). End: heap 2447 MB, 467 geometries.
    Self-check rule corrected: fps <= 1.1 x 1000/median and intervals summing to the segment time (stalls make mean != median legitimately).
  - Far-building sheet extended (5 kinds: glass, masonry, house, shop, glass-office; 300/700/1400/2000/4000 m; CIEDE2000 per face against L0,
    `scripts/lib/deltaE.mjs`, spec against Sharma et al. test data) -> `reports/far-sheet/baseline/`: worst Delta E 7.97, 117 of 125
    level/distance cases over 2.
- Phase 1: starting, in the diagnosis's order.
- Phases 2-4: not started.

## Notes for working here
- `.claude/hooks/git-gate.cjs` refuses git writes unless `.claude/coordinator-commit.unlock` exists: create it for your own verified
  commit, delete it after.
- The owner's Chrome holds ~20 % of the GPU's 3D engine; measures run with `--shared-gpu` and say so.
- The desktop dev window (`npm run desktop:dev`) was closed for this mission's measures (it reloads on every source edit and shares the GPU).
