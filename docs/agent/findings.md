# Findings: every problem found and every solution decided, from every document read whole (docs/agent/reading.md)

Written as each document is read. Each entry: the problem, where (file:line or the view), its state (FIXED with commit, OPEN, DECIDED
not to change and why), and the solution decided. At the end of the reading these become the mission (docs/agent/MISSION.md).

## docs/agent/BACKLOG.md (34 lines, read whole)
- OPEN 1: far levels at night glow as one beige mass (all far levels share massingMaterial; panes' radiance averaged before tone
  mapping). WIP in scratchpad massingMaterial.night-wip.ts; set aside by the owner (camera, LOD, roads first). NOTE: massingMaterial may be
  gone since 878d21d5 (far levels drawn by kit.shellMaterial + kit.facade): re-read the code before acting.
- OPEN 2: tests/render/cellAffinity.spec.ts fails, also on code before 2026-10-27.
- OPEN 3: roads: a cell needs its 1 km tile held by the page's network (renderer.ts cellHeld, RoadWindowLink): check the view's cells land
  at once after VIEW_STEP_CELLS (cd917b6f).
- OPEN 4: base level: pitched roofs flat at half their rise (massBase.ts recordBase) - check after fe0b4e42 (base = plate).
- OPEN 5: scripts/inGame.mjs cannot see the Electron page (Playwright connectOverCDP lists no page); the scratchpad CDP driver worked.
- OPEN 6: window height flips 1079/1080 px, every render target reallocated (renderer.ts resize, render/screenSize.ts).
- OPEN 7: HALF x3 vertex attributes (parts' instance colours: partCells.ts, farParts.ts, buildingMesh.ts) converted by ANGLE D3D11.
- OPEN 8: F7 misses GPU stalls/saturation (per-draw GPU timing in slow frames, CPU vs GPU per draw, GPU work outside the frame by caller):
  partly done later (gpuTimeline.ts, 6d6bb715/667935e7) - check.
- OPEN 9: people's animation palettes render every frame for every batch (crowdAnimation.ts 279 via riggedCitizens.ts renderPalettes),
  ~950 renders/s, even with the people off screen.
- FIXED: parks' pale streaks (3c172ebd).

## reports/audit-f7/AUDIT.md (689 lines, read whole; audits of 2026-10-25, small city seed 7)
- OPEN P11: `roadcraft/no-silent-catch` suppressed in 79 places in the lint baseline: errors swallowed (the owner's rule: no swallowed error).
- OPEN P19: vehicle hubs and wheels drawn at their coarsest level under a pixel (hubs @7: 2,734 x 30 triangles at V5); partLevelsWork.ts
  never leaves a component out. F11 (leave out by radius) REJECTED: moved surfaces past 0.5 px. Decided right rule: measure each
  component's distance to the rest of the vehicle (its occluders) against the error.
- OPEN P10: zooming into a tower takes the camera through its wall (the owner's call; buildings have interiors).
- DECIDED P7: casterChanges (0.15-0.28 ms a frame) kept: its signature lets the sun cascade stores be kept and patched.
- DECIDED P6: rigged citizens' shadows already cast by the coarsest level per cascade texel.
- DECIDED P48: X4122 warning at boot is three's packing.glsl folded by D3D; not the game's code.
- DECIDED P49/P50: road tile worker silent warning by design; staleClaim a long wait.
- CLOSED P41/P51: no leak; caches bounded.
- Measured facts kept for the work: M18 (camera orbiting 206 s) self time: projectObject 4.2 s, profilerHooks 3.2 s (dev only, F26),
  casterChanges 2.0 s, draw 1.8 s, setProgram 1.5 s, fitInstances 1.45 s, readTick 1.29 s, agents sync 1.28 s. M20 A/B: buildings -4.73 ms,
  GTAO -1.58, shadows -1.31, people -1.04, terrain -0.72, vegetation -0.60, canyon light -0.50, clouds -0.45, env map -0.40, SMAA -0.37.
  M12 (V5): building-lotBox 918 k triangles drawn / 2.09 M held in 322 k instances; shell batch 1.46 M + detail 1.12 M held; car bodies of
  every level kept on the GPU though 0 drawn (~0.5-0.8 MB each, ~40 geometries); 3,182 meshes, 20.5 M triangles if all drawn.
  F20: at V5 the scene pass is bound by its PIXELS (facade shading, GTAO), not triangles.
- FIXED there (do not redo): F1-F33 (frameMark marks, vehicle body ladders asked, signals far level, shadows by texel, far ground stride,
  poles round pieces, light cones past BEAM_FADE, pole behind eye, wires as strips, CELESC poles, per-piece/per-span pole levels, far glass
  towers, building props pictures, sheets timing, governor bytes, atlas mips, casters out of colour pass, crowd pass named, wantedBlocks
  once per still view, dead code (knip 0), pole choices controller, context restore F31/F32).
- OPEN F32 leftover: `INVALID_OPERATION: delete: object does not belong to this context` after a context restore (three keeps the lost
  context's dispose listeners).

## reports/audit-f7/BACKLOG.md (87 lines, read whole)
- OPEN 1c: transmission towers, a new family: only on the owner's order.
- OPEN 2b: far levels' findings: L0 vs L1 glass bands at 350 m (teal vs near-black); masonry masses greyer than L0 at 2 km; the base draws
  glass towers matte black; lab engineBuildings builds masses without kit.finishTone; night views not checked. (Partly addressed by the
  L1-format far levels 878d21d5 on; the 2 km wall gap 107 vs 119 remains, f25d3285 not yet seen in the game.)
- OPEN 5: every model's BASE mesh (the owner's order): inventory of every model (scripts/optimization-sheet.mjs inventory): hidden faces,
  duplicate vertices, vertex cache order (meshoptimizer optimizeVertexCache / optimizeVertexFetch), attribute compression (quantized
  positions, normals, colours). (Welds done later: weld.ts, model audit gate; cache order and quantization not recorded as done: check.)
- OPEN 6: every texture the game holds: format, size, mips read or not, compression (KTX2/Basis), atlases; 13b: textures NOT compressed
  (canvas textures such as the poles' wood, RGBA8 atlases) and their bytes.
- OPEN 7: building-lotBox (914 k triangles at V5) and other shell parts: thin posts and rails left out under half a pixel (BAR_PIXELS).
- OPEN 8: building parts' shadow casters (lotBox-caster 1.54 M triangles on a cascade redraw).
- OPEN 9: JS heap churn ~1 MB/s of garbage at rest; long tasks up to 143 ms (step F22 done; churn not re-measured).
- OPEN 10: in-game photos owed: poles' round pieces close up (F13), rainy night cones close up (F14).
- OPEN 12: EVERYTHING the game draws, one family at a time: research the right method to optimise it AND how it should be built and
  architected (as the wires: ribbon, not tube); change the model's architecture where needed, keep the look, gain performance. Families:
  buildings (shells, masses, parts, lots), roads and junctions, terrain and water, trees and plants, ground cover, street furniture, poles and
  wires, signals and signs, vehicles, people, effects (rain, smoke, fire), sky and clouds, the post chain.
- OPEN 13a: occlusion hides only buildings (renderer.ts buildings.hideOccluded): poles, wires, props, trees, signals, vehicles, people
  behind walls are still drawn: test each layer's blocks/cells against the same CPU depth buffer (colour pass only).
- OPEN 14: shader warning X4122 to be cleared on any GPU (ships on Steam) - but 17d decided to leave it (three's code).
- OPEN 16: at V5 the scene pass is bound by pixels: the facades' fragment cost (shell program, masses, glass), GTAO 1.6 ms, canyon light
  0.6 ms: find what a pixel spends.
- DECIDED 17c: vehicle-lamps (64.5 k triangles): not worth a change.

## docs/agent/history.md (530 lines, read whole)
NOTE: the code was reverted to 7c4de70f on 2026-10-28; fixes made after ca2bcf8e (the code-graph mission) are GONE from the code, but the
causes they found are code facts: they are OPEN again unless re-checked.
- THE OWNER'S ORDER above every other (2026-10-27 evening): ONE FORM PER VIEW FOR EVERYTHING; next categories: buildings (load-state
  stand-ins), trees (near/far forest cards), street furniture and props (impostor ladder 48/16/1.5 px; cells not built show nothing),
  people (impostors), poles and wires (blocks not built show nothing), roadStandIn.ts, terrain levels, water. Roads DONE.
- Buildings: KEPT, DECIDED earlier (before the owner's later orders): frameBudget error scale and the detail byte cap move the screen error
  under load. Since then the owner ordered one form per view (the budget may decide only load order and eviction: the planned Phase 3).
- OPEN: far wall 2 km 107,101,89 vs detail 119,105,88. Prescription: the sky the slab over hides (ambient between slabs) and the
  finish's FAR TONE on the faces CoverShell sums (it takes their raw paint); then the slabs' tops again. f25d3285 (cover keeps the wall's
  material) not seen in the game. Planned Phase 2 (owner's mission of 2026-10-27 evening, cancelled with the revert): per kind of bay (the
  CoverShell key) render the real emitBay geometry with the game's renderer, materials and lights in idle slices; a table of apparent
  reflectance per material slot over light and view directions; Delta E 2000 <= 2 vs L0 everywhere; never fix the colour.
- OPEN: the base level made for the whole map at the opening and never let go (weighs what the plate does since fe0b4e42).
- OPEN (tour 2026-10-27): far building masses 8.4 M triangles at the whole-city view (building-massing-plate 334 k in one draw: more
  triangles than pixels; acceptance: triangles <= 3 x screen pixels); building parts 2.5-2.8 M triangles (brise 533 k); far furniture
  rungs ship 1.8 M triangles their vertex shader throws away (farLadders.ts banded instances); gpuBatchedMesh.ts:92 uploads a DataTexture
  272 times a second; each scene lands 4-6 s after the camera moves; JS heap 2.6 GB rising 313 MB/min, live geometries +486/min (the tour's
  photos were most of it: re-measure); 108 long tasks a minute moving.
- OPEN (camera, measured with real gestures 2026-10-27): GPU saturated (~29 ms of draws a frame p50; Electron 57% of the 3D engine with the
  camera still): clouds bodies quad 8-15 ms EVERY frame (a third of the frame; owner ordered clouds and fog removed), scene pass ~15 ms,
  people's animation palettes (~950 renders/s, ~2 ms a frame), GTAO ~2.5 ms (2.7-4.1 at streets), canyon light ~1 ms; SMAA 8 ms at the far
  view; whole-city GTAO 10 ms.
- OPEN (Record a move, near the ground, CPU): three's render: setProgram 588 ms of it texSubImage2D 293 ms = BatchedMesh indirect textures
  (UINT 8x8/12x12/32x32) sent again at every render of every camera (three r186 BatchedMesh.onBeforeRender sets indirectTexture.needsUpdate
  each call) [fixed in the reverted batch 1 "GpuBatchedMesh: one draw list per camera, sent only when it changed": OPEN again];
  projectObject 1.6 s / 8 s (scene graph walked; 3.05 ms a frame on the 10 km drag); updateBuffer 1.09 s (attributes sent again every
  frame; partly F7's own stacks); setTexture2D 0.71 s (crowd renderPalettes 0.69 s); shadow cascades' render 260 ms; engine.refresh 280 ms;
  casterChanges 202 ms; viewCells.has 107 ms; drawOverlayScreen 167 ms; agents.sync 265 ms; depthFirst.draw 261 ms; lotTool overlay ->
  moveWindow -> lotsIn 357 ms (the zones' window reaches the far plane when the camera pulls back); shader programs compiled mid-game
  (3-34 a move, checkShaderErrors reading getProgramInfoLog: up to 1 s blocked); cameraSolids.landed -> floors.work 351 ms (fixed 16a20691?
  check in code: floors in the solids job).
- OPEN (code-graph diagnosis, 10 km drag, ms a frame; fixes reverted): createMassCells.syncBases 1.00 ms self, grows with the map (every
  base's cells walked on any change; fix was stale bases by the changed cell); poleStores PartStore.view/sort + WireStore.sort ~1.5 ms
  (x10 the small city; fix was walking a block again only when the view could cross a choice's edge); ScreenScale.atPoint 55,711 calls a
  frame; hitch:network/rebuild 252 ms in slow frames (the page's network rebuilt in the frame as the view's tiles arrive); hitch:draw/Render
  624 ms.
- OPEN whole-map passes (rule e, left at the revert): renderer plantAll (doc.trees), trafficMapOf (SimClient.load sends the map whole),
  PlacedProduct.allKeys / BarrierProduct.allKeys (Derived spine's whole path), SurfaceInputs.rebuildAll, TileIndex.fileAll, economy priceAll;
  and three fixed then reverted: ragdoll solids for the whole map (world/solids.ts), the lots overlay without a view (LotTool.overlay), the
  highest road over the whole city (RoadTop.heightIn, main.ts surfaceTop).
- DO NOT REDO (broke the game): the upload queue with a byte cap a frame (uploads.ts sendRange/drainWrites: new roads not showing,
  batches with no triangles), the still scene (stillTree.ts holdStill), the code-graph ceilings as a goal.
- Specs failing at the revert (files the mission did not touch): buildingsVisibleSame, cellAffinity, interiorSolids, surfaceReads x2,
  editor/cityTiles, ui/decimals (main.ts toFixed), scale/census/sceneCensus (first bad between d420de6b and e77a92ac): re-run at 7c4de70f.
- Acceptance of the owner's mission (2026-10-27, 10 km city): pan/orbit CPU p99 <= 16.7 ms, GPU p95 <= 14 ms, no frame > 50 ms; after a
  zoom no frame > 50 ms and final levels in <= 2 s; whole-city triangles <= 3 x pixels; heap/geometries stable +-5 % over 10 min; near
  views identical; far sheet Delta E <= 2. Baseline (bench 2026-10-27): district-pan CPU p99 57 ms, 8 frames > 50 ms; whole-map 12
  frames > 50 ms, 7.8 M triangles; heap 2.4 GB.
- Steps 2/3/4/6 of the GPU-driven plan proven not possible / no effect on three r186 + WebGL (reasons there). Step 1 done bd376121,
  step 0 acc7debf.

## docs/agent/{MISSION,optimization-solution,orders,README,STATE,work}.md (read whole)
- The hooks' defect found: `orders.cjs` writes every UserPromptSubmit into orders.md as an "order", also the app's cross-session delivery
  notices (orders.md 2026-10-28 03:02:15, 03:07:07) and a headless test's prompt (removed by hand): it must skip messages that are not
  the owner's (`[Cross-session delivery notice]`, `<task-notification>`, `Stop hook feedback`, `<command-...>` caveats).
- optimization-solution.md: GPU-driven steps 2/3/4/6 not possible on r186+WebGL (history.md proofs); section 5 = the earlier list.
- README rules: research before implementing and cite; commit+push each verified step; never measure to find a problem; optimizations
  change nothing visible; the game window only when the owner asks.

## docs/agent/memory/*.md (31 files, read whole: rules of work, kept; facts below)
- architecture-state-2026-10-26: still whole-map in the sim process `TrafficBuildingTable` (tables, fine); sim process ~2.5 GB, a job
  process ~2.6 GB, page working set 6.2 GB (outside the heap) on the 10 km city: NOT re-measured since. 28 "[uploads] a program was not
  built in 10000 ms" warnings with the hidden window. Relief maps: heights off the page analytic, cm-level difference possible (noted).
  S1 (road shapes off the page, needs a network replica in a worker) and S3 (nodes/segments in tables) NOT done.
- ships-on-steam-any-gpu: a material within 16 fragment texture units (counting three's shadow maps and patched samplers); GLSL reserved
  words; every console error/warning on any GPU is a bug; the specs' null GPU compiles no shader (a passing spec says nothing about it).
- tool-is-the-road-spec: objects L0 from 48 px, L1 from 16 px, octahedral impostor (64 directions) from 1.5 px, nothing below.
- people-no-makehuman: 16 ready people files; quality over the 3k triangle budget; every face checked close up; L2 300-tri shell removed.
- no-fake-city-elements: far levels allowed only as the game's own HLOD made from the real thing.
- vigia-supervision-lessons: far stand-ins keep the look (an impostor of the real model, never a plain box).

## ARQUITETURA.md (97 lines), docs-optimization-brief.md (27 lines), CLAUDE.md files, .claude/memoria (same bytes as docs/agent/memory but MEMORIA.md, falar-em-portugues.md, buildings-runtime-never-bake.md, read whole)
- OPEN: street-name sign plates cover the whole map (41.6 MB on the 70 k city vs 21.5 MB on the 8 k one): `signLayer` to be bounded by the view.
- OPEN: at the opening 480 shadow draws from the 160 cell masses drawn in the 3 cascades.
- OPEN: occlusion's smallest hideable piece is the 256 m cell (gain only at street height); per-building occlusion needs per-building
  batches.
- FACT: growth split across workers was 3x slower and kept serial under the "same hash" rule (ARQUITETURA); later the tiled growth was
  wired (75fb8a07, S2: cityTiles, >= 97 % of serial) - so the generated city is no longer the serial city: check against the goldens
  (editor/cityTiles spec failing at the revert).
- FACT: reverted as washing the picture (56c1ff5c): ultra shadow 3072, MSAA 4x and full-res AO, and precompiling the post passes.
- TRAP: cooked/cities/manifest.json valid only when its hash matches the generator: `npm run cook:cities` after changing it (doc.ts
  changed the cityGen hash on 2026-10-27: shipped cities may need re-cooking).
- Brief's optimisation rules (still the owner's): same picture with fewer triangles/bytes; LOD ladders where an object has none; hidden
  triangles removed; quantized vertex formats where the shader path takes them; indexed geometry; Uint16 indices; duplicate meshes shared;
  uncompressed textures to KTX2; no new program variants. Source of truth per object: reports/engine-geometry/rows/*.json (3,084
  objects, each with `target` and `advice`) and reports/polygon-geometry-audit.md (per file, line numbers).

## reports/Arquitetura para cidades grandes.md (172 lines, read whole: the research report the architecture was decided from, ~170 sources)
DECIDED solutions (each to check in the code: done / partly / not):
- Document in columns (TypedArrays by dense id, pools for variable data, interned strings), hydrated views in an LRU, undo as diffs,
  binary region saves in a worker. [largely done: record tables, sections, squares]
- Every derived thing by cell near the view, pure `derive(cell, stage, generatorVersion) -> ArrayBuffers` in workers, two LRU budgets
  (CPU and GPU), dirty bitset from edits, cache key = hash(cell bytes + generator version + LOD). Acceptance: NO O(map) loop per frame or
  per edit on the main thread; derived CPU memory constant when the map doubles; an edit rebuilds <= 9 cells.
- Buildings: LOD by projected screen error over each cell's real buildings; BatchedMesh per cell and material, quantized vertices;
  facade details in the shader; CPU occlusion in a worker (MOC style) with LOD2 shells as occluders; shadows: cut casters by screen
  radius (UE r.Shadow.RadiusThreshold 0.03-0.06), shadow LOD (shell beyond the first cascade), far cascades of static buildings cached and
  SCROLLED with the camera (Acton 2012, only new borders drawn), snap anchored to the eye. Acceptance: GPU geometry <= 600 MB at 200 k
  buildings (ultra), <= 500 main draws and <= 300 shadow draws at street and high views, zero buildings missing to 1.4 km.
- Roads and props: document keeps centreline, section, junctions; surfaces/kerbs/marks derived per cell in a worker (S1 still not done);
  gardens, furniture and poles generated deterministically per cell with rand(seed, cell, index, purpose) only where they show,
  InstancedMesh per kind per cell, LOD chain mandatory, shadow only at LOD0; lit poles/windows as emissive + ground decal, never a three
  light per pole. Acceptance: roads+props <= 150 draws; no prop without LOD (automatic check in the asset pipeline); a cell's props <= 2 ms.
- Opening: no growth at open; worker pool warmed at t=0; SHADER WARM-UP at t=0 (compileAsync over a scene with one mesh of every
  material x light combination, lights and environment set) with FEW PERMUTATIONS (shared materials, few defines, no per-object
  onBeforeCompile variants); derived of visible cells from the disk cache by hash else workers; upload <= ~4 ms a frame; on a cold
  GPUCache a warm-up with a progress screen; GPUCache corrupt -> detect link failure, clear, retry. Acceptance: 200 k buildings <= 5 s to
  first playable frame warm (<= 10 s cold), <= 1 s at 8 k, no frame > 50 ms during promotion, shader compile warm <= 0.5 s, serial ==
  parallel generation by hash.
- Simulation: meso queue per link (or 100 m segment) in TypedArrays, event-driven by exit time in time buckets (O(exits per tick));
  bounded storage for spillback; micro window 750 m with Aimsun-style handoff (enter if room, else next tick); NEXT-HOP TABLE per exit
  (reverse Dijkstra per exit, O(1) per new car, re-sliced on edits/travel-time drift); CRP-style cell partition for arbitrary trips; route
  cache per (origin cell, destination cell) with version; FIFO route requests with a fixed budget per tick; buildings SLEEP when nothing
  changes, active ones in round-robin buckets, never a loop over 200 k; publication to the page as DELTA (dirty-link bitset + compact
  Float32Array of changed links in visible cells, transferred). Acceptance: tick <= 4 ms (p99 <= 8 ms) at 200 k, spawn O(1), publication
  <= 64 KB a tick, route queue never > 2 ticks late, deterministic by hash.
- Tiers and governor: initial tier from WEBGL_debug_renderer_info + 5-10 s measured warm-up; budgets per tier (GPU bytes 512 MB-1.5 GB,
  screen error 16 px low / 8 px ultra, cascades, small-caster cut, texture pool); governor by GPU timer p90, fast down slow up; knobs that
  change shaders only when the variant is precompiled; powerPreference high-performance; never switch GPU. Acceptance: 60 fps vsync RTX
  3060 1080p ultra (p99 <= 16.6 ms street and high views of 200 k); >= 30 fps UHD 770 low tier res >= 0.7; <= 1 tier change a minute
  still; NO SHADER COMPILE DURING PLAY (program count constant after warm-up).
- Quality: one HalfFloat chain; MSAA 4x medium-ultra resolved before post; GTAO at HALF resolution reusing depth and normal
  (setGBuffer), faded by distance (street level only; from above vertex-baked AO); height fog analytic in the composite; bloom on
  emissive; Neutral/AgX tonemap; SMAA/FXAA only on low tier without MSAA; no TAA; night windows from the facade grid by a hash per window
  (lit fraction by hour); interior mapping only LOD0/LOD1; PCF soft (r182). Acceptance: post <= 3 ms RTX 3060 1080p, GTAO <= 0.7 ms.
  [Measured later: GTAO 1.6-4.1 ms full res, SMAA 8 ms at the far view: NOT met.]
- Final: process memory < 2.5 GB at 200 k, opening in seconds, 60 fps vsync RTX 3060 1080p ultra, no hole nor box at any distance
  (proven by a per-building-ID coverage mask against forced LOD0).

## reports/catalog-layout-check/gaps.md (15 lines, read whole)
- What the model catalogue cannot measure: clouds (ray marched in the post chain, postprocess.ts CLOUD_SHADOWS), far building levels
  (per cell), vehicles' intermediate levels (run-time simplifier), signals/signs/barriers/flags/far traffic (built only from placed items),
  garments/hair copies, cast bodies, editor ground feedback and 2D gizmos.

## reports/Claude Code obediente e honesto.md (386 lines, read whole: how to make the agent obey; not game problems)
- Process decided there (for the mission's working method): protected rulers (tests, baselines, measurement scripts, ACCEPTANCE.json,
  .claude) denied to edits + a Stop diff against a session-start snapshot; acceptance criteria written BEFORE the work in a protected
  ACCEPTANCE.json checked at Stop; evidence gate by ACTION (code edited -> a verification ran after the last edit, unpiped; visual code
  edited -> a screenshot taken after it opened with Read; "I read X" -> Reads cover all of X; cited URL -> WebFetched); explicit limits
  as mechanical denies by tool category; rules re-injected at compaction; short calm rule card; a reviewer of another family; small
  stages ending in a commit. Known Desktop hook bugs: hooks that never execute on Windows Desktop (#29560), Stop hooks that stop firing
  mid-session (#32055): validate each gate with a canary log.

## reports/codegraph/diagnosis.md (383 lines, read whole: CPU profile + coverage of the camera drag on the large and 10 km cities,
## taken on 7c4de70f's code before the reverted fixes, so every row is the CURRENT code's behaviour)
Per frame of a drag on the 10 km city (self ms / calls a frame), OPEN unless re-checked:
- createMassCells.syncBases (massCells.ts:767) 1.39 ms, grows with the map (0.008 ms on the small city); drawnBy (massCells.ts:551) 3,709
  calls; allocations in its loops (@778, @789, @793): every base's cells walked when any is stale.
- Pole stores: PartStore.view (poleStores.ts:365) 59 calls, sort (poleStores.ts:394) 13 calls with addUpdateRange + needsUpdate
  uploads in a loop @415-416, WireStore.sort (poleStores.ts:676) uploads @708-709, ScreenScale.atPoint (poleStores.ts:130) 55,711 calls
  a frame (x4 the small city): every pole piece and span re-measured and re-sorted and re-uploaded each frame of a move.
- casterChanges (renderer.ts:748) 0.40 ms, allocates a Box3 per caster @809; noteWidest findIndex 339 calls; mix 4,731 calls.
- ROAD SURFACES DERIVED ON THE PAGE IN THE FRAME: draw -> lookProps -> createPropLayer.ringsIn -> ViewCells.ensure -> ViewCells.make ->
  SurfaceInputs.deriveCell (roadSurfaceInputs) -> placeSegment / placeNode -> segmentShapes, rampStretches, crosswalkDistanceAt,
  junctionShapes, RoadMarks.place (Digest.word 0.177 ms), nodeMarks -> fileMarks -> TableItems.get -> TableRows.get/record (459 records
  DECODED a frame, TableReader.value 1,865) - the landscape items decoded on the page per frame of a move. (Inventory S1, still open.)
- SIGN LAYER DERIVED ON THE PAGE: ViewCells.make -> createSignLayer.derive -> standOf -> createInstanceRuns.update ->
  createCellInstances.makeMesh -> dressedMesh -> posedMaterial: `material.needsUpdate = true` (cellInstances.ts:216) = a PROGRAM
  RECOMPILED during the drag (0.084 a frame).
- POLE CELLS DERIVED ON THE PAGE: ViewCells.make -> PoleCells.derive -> build -> PartStore.add/write/reserve, growPart, acrossJunction ->
  nearestFacing -> RoadDoc.polesIn.
- TERRAIN SEAMS RECUT ON THE PAGE IN THE FRAME: draw -> flushSeams -> createFlatAtlas.seamsMoved -> setSeams -> recut -> plateSeams ->
  patchSeam (cellHeight, binarySearch 606, TriangleIndex.inside 398) and texture uploads (terrain.ts 1388, 1715); landNormalsInto 521.
- Uploads outside any budget in the frame: LandLod.select (terrainLod.ts:286) 32 a frame (addUpdateRange + needsUpdate @305-306);
  createTerrainSurface.paintStep texture needsUpdate (terrain.ts:2352) 32 a frame; roadPaint sendTexels (roadPaint.ts:217) 32.7 a
  frame from NetworkFarRoads.followMarks -> RoadMarks.commit (write sorts 223 lists a frame); createCellInstances.reconcile 21 a frame;
  riggedCitizens.finish; transit; wear field; canyon light textures; signLayer.touch; GpuBatchedMesh bufferData/copyBufferSubData on
  growth; sunCascades copyTextureToTexture 5 a frame.
- Camera solids on the page: cameraSolidsKeeper.solids -> settleFootless (cameraSolids.ts:203) 0.116 ms, 419 buildings' foot measured a
  frame through knownFloor -> digestOfCell (420 calls) -> slotNow; canyon light follow -> forEachInAny -> fill -> SolidFiling.has 583.
- Lot overlay every frame: drawOverlayScreen -> LotTool.overlay -> refreshLots -> RoadDoc.lotsIn -> LotStore.in (allocs @207-208) ->
  PointFiling.idsMeeting (sort 1,479) and moveWindow -> settleWindow -> LotOverlayBook.put 88 a frame.
- Road elevation rebuilt inside the frame: draw -> warmRoadShaders -> buildRoadElevation -> ProfileIndex.remove (RerootMap) ; and
  Network.rebuild -> NetworkBuild.rebuild -> takeBakes in the frame (hitch:network/rebuild 252 ms in slow frames).
- Scene walks every frame: updateMatrixWorld three times in draw (renderer.ts 3717, 4002, 4239); drainCompiles traverse (uploads.ts:335)
  and gateUntilBuilt traverse; createOptimizer.beforeRender traverse (optimizationsApply.ts:248); depthFirst traverseVisible
  (depthFirst.ts:62) with depthMaterial 236 calls; sunCascades.measureSphere computeBoundingSphere 2.5 a frame; building layer
  setFromObject (layer.ts 936, 977). three: projectObject 1,552 calls 2.93 ms, renderObject 868 calls 2.22 ms, setProgram 127 calls
  0.99 ms, renderBufferDirect 127.
- Others growing with the map: createCellInstances.visit 606 calls 0.49 ms; CellKeeps.settle sorts its queue every frame
  (cellKeeps.ts:160-163, 4,349 sort callbacks); jobPool dispatch allocations; massCells.choose allocations (@878, @892, @927),
  exposedCells keyOf string keys 1,231 a frame (massCells.ts:50); levelShown 566; createMassCells.near 1,132.
- Totals: frame 13.1 ms of main-thread JS per frame of a drag (draw 12.5 ms with callees), (program) 4.33 ms self.

## reports/codegraph/hot-static.md (452 lines, read whole: what frame (main.ts:2704) CAN reach, ranked by costly work)
OPEN, each a path from the frame to heavy page work (check each in the code):
- CITY GROWTH ON THE PAGE from the frame: frame -> GrowthPool.pump -> GrowthReplica.handle -> designOnLot -> tryOnLot -> furnishLot /
  planLot / stepToSlope / fitToLot / madeToMeasure.flats (sorts and allocations 3-5 loops deep).
- PEOPLE LOADED AND BAKED ON THE PAGE inside the frame: draw -> agents.sync -> drawCar -> placeCarOccupants -> riggedCitizens.drawClip ->
  request -> pump -> load (riggedCitizens.ts:497): new DataTexture, InstancedMesh, Groups per person; loadCookedPerson -> assemblePerson
  (SkinnedMesh per node, cookedPerson.ts:233); bake -> bakeLibraryClip -> clipTransferFor -> transferOnto (citizenWalk.ts:150,
  updateMatrixWorld walks, sorts); bakeRiderClip -> pose -> apply (riderPoses.ts:517, updateMatrixWorld x3 per pose);
  createPersonImpostor (personImpostor.ts:89: new MeshStandardMaterial + InstancedMesh per person -> a program); createPalettePass
  (crowdAnimation.ts:117). The animation clips are baked at run time on the main thread when a person first shows.
- PLAYER BLUEPRINT PHOTOS FROM THE FRAME: frame -> createBuildingWiring.beforeDraw -> photographOlder -> photographBlueprint ->
  createPhotoStudio (creates a WHOLE building kit: createBuildingKit -> createFurnitureGeometries -> rbox/box/cyl/weldGeometry/
  dropHiddenFaces, SIMPLIFIED levels via simplerLevels/compacted) and photograph -> emitChunk -> emitProgram -> emitBuilding (emitRoof,
  emitPolygonRoof, recordBlock, layElement, emitPlinth, emitLots) -> assembleBuildingMeshes -> meshesOf: a second kit and a building
  emitted on the page for the photo of a saved blueprint (the "photo once" of older blueprints).
- CELL JOBS RUN ON THE PAGE: draw -> buildingLayer.update -> MassLevels.flush -> ask -> CellPool.run -> CellPool.onPage -> runCellJob ->
  fileParts -> fileKind (sorts) and MassShellWriter.write -> writeMassShell: a building cell's job on the main thread when no worker
  takes it (onPage path).
- A GPU SYNC READ FROM THE FRAME: draw -> govern -> buildingLayer.setDetailBudget -> keepToBudget -> ShellBatch.remove -> squeeze ->
  GpuBatchedMesh.compact (gpuBatchedMesh.ts:292) -> getBufferSubData (310): reads a GPU buffer back synchronously (stall), then
  bufferSubData.
- PROP BATCHES MADE ON THE PAGE: lookProps -> ringsIn -> ViewCells.make -> FarClass derive -> createPropLayer.batches (propCells.ts:376):
  new InstancedInterleavedBuffer / InstancedBufferAttribute / BufferGeometry per batch (449-453, 488).
- PART CELL MESHES MADE IN THE CULL: cullDetails -> PartCell.choose -> PartCell.make (partCells.ts:506: new InstancedMesh +
  InterleavedBufferAttributes) and makeCaster (325): new GPU objects created during the camera's move.
- Others: road tool verdict while drawing a road runs Network.rebuild -> solveNode -> buildJunction / deriveFromLegs and
  commitDraftInPlace -> splitSegmentAtCuts -> addSegment -> copyRecord/copyNode/cloneRoadSection (deep copies) from drawOverlayScreen;
  roadSurfaceSteps / coarseGeometry (roadLod.ts:10) from warmRoadShaders in the frame; agents.growPart new InstancedBufferAttributes
  (agents.ts:1160); densityCars.tileGeometry new InstancedBufferGeometry per tile write (densityCars.ts:273); element layer impostors
  pictureQuad geometries; ragdoll joltSpec allocations; shapeGround -> storePads -> siteGrading.padFor -> padOf (pads.ts:116, 6 loops);
  parkingOf in road derive (parkingLayout.ts:109); NetworkWindow.askOf -> savedNode copies (doc.ts:3885); travelProfile allocations 8
  loops deep in crosswalkDistanceAt (roadTypes.ts:287); NetworkFarRoads.madeHere -> farPieceCells -> pieceBundle on the page;
  wireGeometry new InstancedBufferGeometry per WireStore reserve (utilities.ts:435); shadowLevels compacted on garden layer creation.

## reports/elements-optimization/* compare summaries (building-part-pictures 21, pole-levels 8, prop-atlas-mips x3 12/12/14, wires 5 lines) and reports/engine-geometry/gaps.md (11), read whole
- FIXED records (F18 poles 31,634 -> 14,834 tri street; F23 atlas mips 0 pixels changed; F16 wires 41,148 -> 21,564; F20 part pictures:
  district facade 800 m 262,556 -> 77,684, tower-sw and tower-nw unchanged 129,040 / 126,115 triangles: their parts not pictured).
- OPEN: towers' parts still 94-129 k triangles each at their sheet views (tower-ne 93,917, tower-se 105,376, tower-sw 129,040,
  tower-nw 126,115): the far parts of a tower barely lighter.
- Street props measured: phone 7,272 triangles, tree 5,158, lamp 4,876, bin 2,058, bench 2,018, hydrant 1,692; ground cover: tallGrass
  54,966, flowers 45,914, grass 36,038, clover 25,704 in their sheets (heavy kinds for the model rebuild item).

## reports/elements-optimization/far-buildings/gate2/sheets/{compare-before-a-b-final (191 lines), roofs-tile3-tile2.9-tile1.4 (131 lines)}.md, read whole
- Historical (before the L1-format far levels, 878d21d5): glass tower walls L0 64,80,75 vs L1 78,86,84 vs cell/tile/plate 72,78,79 vs
  base 13,17,22 (black); masonry walls L0 118,103,87 vs masses 96,93,88 (grey) vs base 92,75,58. The base's glass towers were black.
  The district L1 at V5: 982,506 triangles in 28 draws (1.8-2.4 ms GPU on the sheet).

## reports/far-sheet/baseline/deltaE.md (132 lines, read whole: the far sheet baseline, 5 building kinds x 5 levels x 5 distances)
- OPEN, THE FAR-LOOK GAP IS EVERY LEVEL AND EVERY KIND, NOT ONE WALL: CIEDE2000 of each level's faces against L0 at the same distance:
  worst 7.97, 117 of 125 cases over 2 (acceptance <= 2). Even the facade level L1 differs from L0: glass 3.7-6.2, glass-office 4.3-6.0,
  masonry 2.2-5.5, house 1.6-4.2, shop 0.7-3.0. Cell/tile: masonry 7.4 at 300 m, house 5.2-5.5, glass-office 4.4-6.1. Plate/base roofs:
  glass 5.2-6.1, house 2.5-4.9, glass-office 3.4-4.6. (Taken on the code of 7c4de70f before f25d3285.) The fix must make L1 and every
  coarser level read the SAME look as L0 per pixel (the planned Phase 2: an apparent-reflectance table per material slot, rendered per
  kind of bay with the game's renderer; never fix the colour by hand).

## reports/elements-optimization/vehicle-hubs/summary.md (171 lines, read whole: F11 attempt sheets, rejected)
- OPEN (the owner: "carros estão com muitos triângulos, absurdamente"): every vehicle's FULL model (the "#2" rows, L0) is 10-13.5 k
  triangles: sedan 13,477 shut / 12,457 open, wagon 13,507, suv 13,391, hatch 13,251, pickup 12,311, van 12,663, bus 8,282, truck
  2,109, motorcycle 688, bicycle 430; steering wheels 534; tyre and rim 396; 36 bytes a vertex (44 the truck), never quantized.
  Research reference (session): Cities: Skylines cars ~500-1,000 triangles, community cap 3,500. Rebuild the car models at a proper
  density (the owner: "SE PRECISAR REFAÇA O MODELO"), same look, proven by sheets.
- F11 (leave a component out under the error) REJECTED: surfaces moved 100-500 mm, silhouettes 58-80 % (motorcycle, bicycle,
  steering wheel 73.7 %).

## reports/geometry-optimization-research.md (150 lines) and reports/geometry-replacement-research.md (76 lines), read whole (2026-10-22)
DECIDED techniques (check each in the code: done or open):
- R2: never submit collapsed instances (density cars up to 262,144 x 24 tri, far woods, sign-plate free slots, destruction, poseHidden):
  compact on the CPU (swap-remove, count/draw range) or BatchedMesh setVisibleAt/deleteInstance. [history: far furniture rungs still ship
  1.8 M triangles the vertex shader throws away - OPEN]
- R3/T1: terrain patches 6 -> 4 vertex invocations a cell keeping the data-driven diagonal (rotate corners in the shader); rim one side
  per instance where a border needs it (160 -> 20 tri).
- R4/R2(roads): curve tolerance per far level from its pixel error (4x fewer arc segments far).
- R5: closed cylinders whose caps never show -> openEnded; signal lenses/halos as 12-tri discs (done for signals far, F9).
- R6: mini-roundabout disc as one filled disc (1,440 -> 40 tri); parking lines points only where the kerb bends.
- R7: sky as a fullscreen triangle (960 -> 1).
- R8: Uint16 indices under 65,536 vertices (glTF always widened to Uint32, vehicle body+panel join, far ground, people proxies);
  quantize Float32 attributes (16-bit local positions, oct16/oct24 normals): a static PBR vertex 48 -> 20 bytes.
- R9: shadow pass position-only with meshopt generateShadowIndexBuffer.
- R10/F4: receiver-masked caster culling (Bittner 2011, 3-10x on city scenes); drop casters under a texel (lot elements < 0.2 m).
- R11: hidden internal faces of welded volumes by 2D union per storey band (world/buildings.ts 805-860).
- R12/G1: foliage cards indexed (6 -> 4 vertices) and trimmed to the opaque area; discard only after opaques.
- R13: builder hover samePlain check (editor/buildingTool.ts:1806); delete the never-drawn torso box and head sphere (render/agents.ts:607),
  the unused crowd instanceMatrix growth, boxWithout orphan vertices.
- R14: "built" vs "drawn" triangles kept apart in every count.
- F1: window/door openings near drawn by an exact ray-box recess in the facade shader (frames ~167 k x 56 = 9.4 M triangles in a
  large city -> ~0), no gl_FragDepth, no POM loops far.
- F2: railings and balusters as procedural bars on the existing card past ~20 m (222 -> 12 tri).
- F3: proxy casters in the far cascades (the mass casts, the detail parts do not).
- V1: vehicles ladder 12.8 k -> ~3 k -> ~500 -> 24 by projected size, wheels merged far (store traffic cars LOD0 2.6-3.3 k).
- P1: people LOD by screen height, LOD0 only within a few metres, a simple shadow proxy far (capsule shadows).
- Rules: tiny triangles (< 4-8 px) are the expensive ones; no gl_FragDepth; discard only where nothing else works; procedural patterns
  filtered with fwidth; textures compressed (KTX2 ETC1S/UASTC); few fixed program keys.

## reports/measure-2026-10-26b, measure-2026-10-27 READMEs, model-catalog-all/gaps, rearchitecture/INVENTORY, root-architecture-plan-2026-10-26, sheets-hull/summary, stalls/smoke-small/diagnosis (read whole)
- OPENING (10 km, fresh window, 2026-10-27): shown at 24.1 s (save parsed 7.7 s, surfaces 16.9 s); in a long-open window 41.6 s;
  with cache rebuilt 98 s. OPEN: save read 27 s in an old window; road surfaces waiting on the store lane and tile workers.
- OPEN (architecture spec): tests/arch/imports.spec.ts fails on an import cycle in world (networkBuild -> networkBake -> junction/
  ribbons/doc -> ... -> networkBuild), since 2026-10-26.
- INVENTORY: A1, A3, A4, A5, A7, A10, S2, S5 rebuilt; A2, A6, A8, A9, A11 off the page's path; S1 (road shapes off the page, needs a
  network replica in a worker) NOT done; S3 (nodes, segments, barriers in tables) NOT done (argued: hot path decode would slow edits).
  Still proportional to the roads on the page at a load: tileIndex fileAll, main.ts worldBounds, roadTop allCells, the sim start
  (trafficMapOf).
- ROOT PLAN principles (decided): the page holds the document and the view; every derived thing a pure per-cell function off the page,
  budgeted, kept on disk by hash; no step covers the whole map; threads sized by cores and RAM, not the page's cage; the opening waits
  only for its first picture; acceptance on the 10 km city and on the weak-machine profile (core/weakMachine.ts); no frame > 50 ms while
  opening/filling.
- HULLS: car hulls cut 17-27 % by error-bounded stations (sedan 14,670 -> 11,606) - still ~11-12 k triangles a car (see vehicles).
- STALLS (small city smoke run): CPU-bound frames inside three's render; a 73 MB buffer allocation + 42 MB GPU copy in one frame by
  GpuBatchedMesh.buffer/flush/compact (gpuBatchedMesh.ts 183, 386, 411) when a batch grows or packs; program compiles with
  getProgramInfoLog waits (3-10 ms) inside scenePass.render; canyon light uploads ~1 MB in a frame; 400-460 drawElementsInstanced a frame.

## reports/model-audit/models.md (260 lines, read whole: every model the game builds, 141 models, 255 pieces/levels)
- OPEN (vehicles): car L0 = shell 6,032-8,500 + interior 956-1,466 + roof 252-1,204 + glass 356-672 + trim 460 + steering wheel 540
  triangles; the shell's level 1 is 36 triangles: the ladder jumps from ~8 k to 36 in one step (no middle level in the model file; the
  run-time simplifier fills between). Bus interior 6,172.
- OPEN (non-indexed geometry): street and forest tree bodies (broadleaf 202 tri / 606 vertices, ipe 132/396, broadleafTall 112/336,
  bush/hedge 80/240, conifer 18/54) and ground rocks (36/108) are NOT indexed (3 vertices a triangle).
- OPEN: sky dome sphere 32x16 = 960 triangles (fullscreen triangle decided, R7); bookshelf 1,814; officeChair 727; phone 590.
- Tree foliage cards counted as flat triangles (cards, by design).

## reports/model-catalog/gaps.md (130 lines, read whole)
- The catalogue tool could not sheet ~115 of the test city's layers (TypeError `indices.getX is not a function` on GLBufferAttribute
  indices of the shell batches and far roads; `reading 'count'` on instanced/batched layers): a tool fault, so the per-object audit of
  building parts, casters, far cells, density cars, garden trees and lots has NO sheet. Any model work on those kinds needs its own sheet.

## reports/polygon-geometry-audit.md (4,121 lines, 2026-10-22: per-file audit of every GPU primitive) - read in parts, notes per part
Lines 1-450 (summary, chunk g00, start of g01):
- Budgets in code: perfBudget.ts 44-47 VIEW_BUDGETS street 16 M tri / 1,000 draws, district 16 M / 1,100, map 8 M / 400, GPU p95 12 ms;
  VRAM budgets L0 shells 300 MB, parts 150, masses 120, tiles 60, plates 15; textures 600, targets+shadows 300, JS heap 1,500.
- Largest sources then: shells ~16 tri a bay + 3-4 parts; parts frame 56, door 72, railing 252, louvre 136; terrain plate 204,800
  tri at full; COOKED PEOPLE 28.7-45.3 k tri at LOD0 (53 bones, 13 morphs, ~84 B a vertex); procedural crowd L0 26,756; density cars
  24 tri, cap 262,144 = 6.29 M worst case; near cars ~12.8 k body; traffic signal head 532 tri; phone booth 570.
- OPEN unless fixed since (check): furniture RoundedBox 300 tri per box (bookshelf ~54,600 - later fixed? model audit shows bookshelf
  1,814: FIXED); terrain rim 160 tri with 120+ zero-area; non-indexed ground patches; mini-roundabout disc 1,440 tri; parking lines a
  point a metre; ARC_TOL 8 mm on every level (core/ring.ts, re-flattened on every flatXY call: CPU, no cache); closed cylinders with
  hidden caps (sign posts, piers); sky 960 tri; collapsed instances still submitted; unused crowd instanceMatrix; dead torso box and head
  sphere (agents.ts:607); boxWithout orphan vertices; Uint32 where Uint16 fits; non-indexed cards/props/signature buildings (box 36 v);
  welded buildings keep both blocks whole (world/buildings.ts 805-860: internal faces drawn and cast); lawn polygon under every other lot
  surface; road tongues/node caps/mouth strips overlapping rings unless unioned; builder hoverElement rebuilds the ghost on every pointer
  move (buildingTool.ts:1806); lab wireframe on released arrays (gpuOnly.ts 17-18).
- Clothing proxies 575 items 6.27 M tri (largest 155,930; street items capped STREET_TRIANGLES 16,000, wardrobe.ts:30); procedural hair
  4,730-46,180 tri (afro): [people were later replaced by 16 ready files: check].
- g01: drawAllLots rebuilds every lot group on a mode/use change (O(lots), @rebuild); the zoning proposal holds every street-land lot of
  the region as its own group.
Lines 451-4121 (chunks g01 end to g14 and the cooked assets), all read. State: the audit is of 2026-10-22; each item OPEN unless the code
now says otherwise (to check at step 3 of the task):
- Lab only (not the game): wireframe view throws on released arrays (gpuOnly.ts 17-18 -> updateWireframeAttribute); posing.ts:305
  new Float32Array + BufferAttribute every frame; bodySculpt/sculpt/reshape rebuild whole meshes per dab; faceRig 52 morph targets.
- Page frame work found: E7 node drag rebuilds the network every max(50 ms, 1.6 x cost) (nodeMover.ts 22-23, 64-68); main.ts overlay
  (Canvas2D) projects the road draft every 2 m with a height read per point each frame; junction glyphs over every junction on screen.
- People data: Morpher.shape writes 19,158 x 3 floats per body, 64 PCA passes; expressions 52 dense arrays 11.95 MB CPU cached once;
  procedural hair strands up to ~184 k tri per style (longStraight) drawn for the nearest 8 people (hairStrandPeople);
  procedural hair cards: afro 46,180 tri, sum of 28 styles 386,240 tri; CPU nearestThree per vertex on generation.
- Crowd (proceduralCrowd.ts): instanceMatrix allocated and doubled but never written (64 B/instance) (:1231, :335-336); aRefs stored
  Float32; DoubleSide on closed skin/cloth; frustumCulled false on every piece; L0 skin = full 26,756 tri for up to 30 people;
  gpuRows.ts:144 a new DataTexture per row write; crowdAnimation palette 1-2 draws per class per frame (= item 1b).
- riggedCitizens.ts: citizenRow buffer of 1000 floats per level mesh regardless of capacity (:647); setting a face sets
  mesh.count = CAPACITY so three allocates the morph texture for 1000 instances (:189-193); cooked people LOD0 28.7-45.3 k tri.
- Vehicles (agents.ts): growPart never frees old GPU buffers until context loss (:1443); shell/shellLite separate InstancedMeshes only
  to toggle castShadow; dead torsoGeometry and headGeometry made and disposed (:600-607); helmet sphere 720 tri; car body ~12.8 k tri
  at L0; steering wheel 316-540 tri; bus interior ~5,000 tri; bicycle spoked wheel 416 tri; vehiclePanels Uint32 index always.
- Blast: debris meshes frustumCulled false and all matrices rewritten whenever any piece moves (blast.ts 670-689); crater matrices
  rewritten every frame while any crater exists (691-706).
- Barriers: railing ~100 tri/m of thin shadow-casting boxes (bars every 0.14 m).
- Buildings: frame/louvre boxWithout orphan vertices; GpuBatchedMesh index always Uint32 and worldGeometry re-expands positions to
  Float32 (+50 %) (gpuBatchedMesh.ts:44, shellBatch.ts 248-272); farParts frustumCulled false (one draw a kind over the town) and
  remove() re-uploads the whole tail (farParts.ts:76); flags PlaneGeometry 24x12 = 576 tri each, rebuilt whole on every set,
  frustumCulled false; lantern ~982 tri; furniture RoundedBox 300 tri a box (bookshelf ~54,600 t; model-audit later shows 1,814: FIXED);
  signature buildings all non-indexed, every tiny box casts, extra roofing cap box per facade box, 20-40 draws each x cascades;
  fracture JS number[] per triangle (GC), unindexed 52 B/vertex rubble kept forever with degenerate blanked pieces;
  cellInstances triangles counter counts all live instances, not drawn.
- Terrain: unindexed patches (6 v a cell, 4 corner evaluations per vertex = ~6x fetch work); rim 160 tri with 120+ zero-area;
  map slab unindexed 4,608 tri; water unindexed with a constant (0,1,0) normal array.
- Far ground: skirts double-sided on all 4 edges, all patches one undivided draw.
- Sky: SphereGeometry 32x16 = 960 tri where a fullscreen triangle does (environment.ts:147).
- Density cars: cars inside the micro window folded to a point but still submitted (up to 262,144 x 24 tri).
- Far woods / plant impostors: thinned trees collapsed in the vertex shader, still submitted.
- Elements: index widened to Uint32 always (elements.ts:86); Mushroom_Laetiporus 3,216 tri, no LOD below the 1-px cut.
- Low-poly trees: cards unindexed (6 v where 4), body unindexed by design; crown drawn behind cards (overdraw).
- Ground cover rocks keep an unused uv attribute.
- Street props non-indexed (propGeometry part()); phone booth 570 tri (spheres 90 %); drain/tree-pit hidden faces.
- Sign posts closed cylinders (16 of 32 tri invisible caps); sign plates frustumCulled false, freed slots degenerate inside drawRange,
  drawn into every cascade; signal lens and halo closed cylinders (48 tri where a 12-tri circle does), 532 tri a lit head;
  piers 16-seg closed cylinders with 32 of 64 tri hidden caps; poles: insulators 40 tri x 3 per arm and cap 40 tri with no levels,
  mast keeps unused base-cap vertices; wire strip normals all-zero array; wires DoubleSide.
- Transit: sleepers every 0.7 m as separate shadow-casting boxes (~26 tri/m).
- Road paint is meshed geometry per colour per tile (no decal); every skirted band adds a ring of triangles.
- World data (drives triangles): mini-roundabout disc = 18 overlapping stroke rings ~1,440 tri where a 40-tri disc does
  (markings.ts 452-464); parking/no-parking lines 1 point a metre even on straight streets (parkingLayout.ts 172, 180, 186-191);
  ARC_TOL 8 mm everywhere (bulb ~75 segments, curb returns 11-17); leg tongues/node caps/mouth strips overlap (union needed);
  mouth strip code duplicated (mouthOverlap.ts and surfaces.ts 91-113); lawn polygon under every non-rectangular lot
  (zoning.ts 613-621); 400-station cap on road elevation (long roads coarser); stale comment terrain.ts 49-50;
  outlined towers never occlude (cameraSolids.ts:233); structuredClone/JSON clones break record interning.
- Importer: no decimation, Uint32 refs/index, 44 B a vertex (import-makehuman-pack.py).
- Counters that lie: script triangle counts ignore drawRange/batches; cellInstances and others count built, not drawn.
- Imported proxies 575 items 6.27 M tri (the whole catalogue; the street cap STREET_TRIANGLES 16,000 applies at choice).

## reports/sheets-weld/summary.md (127 lines) - weld of models, all same triangles, 0.0 mm moved, 100 % silhouette
- Welding (indexing) cut vertices with no visible change: held props 28-49 % fewer vertices (cup 288 -> 148); street props bin 22 %,
  hydrant 30 %, lamp 22 %, postbox 18 %; facade props pot 27 %, table 30 %; furniture lamps 24-28 %; cars 11-34 % fewer vertices
  (van 15,132 -> 9,972) and car triangles 1-5 % fewer. Bookshelf 1,814 tri (the 54,600 of the audit is FIXED). Sky dome still 960 tri.
  State: a sheet of a proposed weld; check in the code whether the weld landed (heldProps.ts, propGeometry.ts part(), carBody merge).

## reports/Verificação rápida sem suítes.md (89 lines) - research, fast verification layers
- DECIDED as advice: tsgo whole program (~2 s), eslint on changed files, `vitest related`, a sim state hash per tick (Factorio),
  frozen-clock headless smoke at 0.1 % pixel tolerance; full suite only before push. verify.mjs accepts 1.5 % because time is not frozen.
  Not a game problem; process only (the owner now orders tsc/eslint/spec of the point only).

## reports/Vias e mobiliário urbano otimizados.md (128 lines) - research, roads and street furniture
- Recommended (research, not decided by the owner): roads as a profile swept per segment with stations by sagitta tolerance, junction
  plates cut at mouth lines, markings evaluated analytically in the road shader (no polygon per mark), kerb as profile vertices,
  one sampler2DArray + hex tiling, props in Instanced/BatchedMesh with LOD by pixels and no shadow for small props, emissive + bloom for
  lamps, wires with Persson's 1-px clamp; arcs at eps 2-5 cm (the game uses ARC_TOL 8 mm); ear-clipped fans are the worst case.
  State vs the game: the game's roads were rebuilt since (one form, 8e1e9f25, 6c7361fb, tool-is-the-road-spec); the paint is still
  meshed polygons per colour per tile (polygon audit g07 #8) - an OPEN candidate, but a change of look must not happen.

## reports/why-10km-cities-fail-2026-10-26.md (149 lines)
- Cause: architecture (page CPU memory/time), not GPU (7-14 ms at every size). 10 km: 111,274 buildings, 153 s to show, 95 s generating
  on one worker, page died twice (heap 3,039 MB; process 2.7 -> 7.8 GB during the whole-map fill after the reveal).
- Page work for the whole map (OPEN unless fixed since, check): one elevation solve for the whole network on the page
  (renderer.ts 2425-2432); the fill builds every road tile of the network's extent (2393-2395, "3.4 GB peak"); string keys per block
  (2354-2358); data of distance-limited meshes resident for the whole map; document as Maps of objects (doc.ts 153-176, lotStore.ts:35)
  with Map indexes (cells.ts 64-67, poleIndex.ts 27-29, pointFiling.ts:22); worker pool sized by cage room (jobPool.ts 296-310);
  openCityNow one worker for the whole city then the whole snapshot applied on the page (main.ts 2179-2231); 422 ms stalls.
- DECIDED: columnar document, derived data per cell bounded by the view with budgets and LRU, parallel generation in utility
  processes, the simulation owning its state in its own process (later: architecture-state-2026-10-26 says tables and save done,
  the simulation worker left). Acceptance: heap flat when the map doubles (<= 1.3 GB), opens playable, no frame > 50 ms filling in,
  nothing disappears or changes.

## lab-reports/tour-2026-10-27T15-29-08.md (783 lines) - F7 city tour, 17 stops, RTX 3060, ultra, build 51c3de4
- CPU 19.1 ms at street views, 98 % in drawing (CPU-bound at street 3-7 and 7-7, 47 fps): casterChanges renderer.ts:744 (1,027 ms
  self), draw renderer.ts:3429, drawOverlayScreen main.ts:3002 (216 ms self), measureHitch core/hitch.ts:2 (174 ms), syncBases
  massCells.ts:771, cellInstances visit :1038, castShadowKey shadowCasters.ts:67, cellKeeps settle :153, flatAtlas sync :659,
  plateMesh face :48; postprocess render 9.4 ms with ~50 % inside three.
- GPU: far building masses 84 % of triangles at the city view (8.38 M tri; massing-plate 333.8 k tri one draw); building parts 58 %
  at street (2.76 M, brise 532.8 k tri / 22.2 k instances); GTAO 4.1 ms (23 %); canyon light 1.3 ms; clouds 1.3 ms; SMAA 1.1 ms;
  street furniture 35 % at districts (2.33 M tri).
- WASTE (OPEN unless fixed): far ladders send every instance of a block and the vertex shader drops those out of band: 1.78 M tri
  shaded and thrown away (street lights 724.7 k, bins, benches, hydrants) - fix: sort instances into their rung on the CPU
  (farLadders.ts); street-lights-mid 88 tri over 1.2 px; oak 202 tri over 0.1 px (trees drawn far finer than pixels).
- Buffers made as the game runs: cellInstances.ts:253-254 instancePoseA/B 4.61 MB/s; partPose.ts:38-39 2.75 MB/s; shellBatch.ts
  :274-275 position/shellPaint 2.16 + 1.44 MB/s; buildingMesh.ts:4485/4490 1.44 MB/s; farParts.ts:442 re-sent 1.52 MB/s;
  gpuBatchedMesh.ts:92 DataTexture re-sent 404 a second (= item 1d).
- jobPool.ts:174 and processWorker.ts:147 message listeners ~0.3 ms a frame each beside the frame.
- Heap +317 MB/min (1,816 -> 2,907 MB), 627 geometries +347/min, 216 programs +7/min (compiles during play = item 1a),
  22-112 long tasks a minute, 8 hitches > 50 ms.
- Copies held twice: terrain-ground geometry x56; car-bus body-lite x3; building-lotBox and -caster; lotSides and -caster.
- Loading: views land after 1.1-5.8 s and the triangles jump while landing (4.4 M -> 2.2 M -> 7.3 M): one form per view not held
  (= item 2a).

## lab-reports/tour-2026-10-27T15-03-34.md (678 lines) - the tour before, build dafe5f9 (26 min earlier)
- roadPaint.ts:219 DataTexture re-sent 634 a second, 18.53 MB each = 11,755 MB/s (fixed by the next tour: absent at 51c3de4; check).
- CPU 21.6-23 ms at every street view (39-42 fps, CPU-bound): PoleStores.view poleStores.ts:360 (2,094 ms self), cellKeeps settle
  :150 (1,270 ms self), PoleStores.atPoint :130 (803 ms), casterChanges, drawOverlayScreen main.ts:3002 (421 ms), digest word
  core/digest.ts:72, viewCells has :148. The next tour shows poles gone from the top (fixed between dafe5f9 and 51c3de4).
- Same far ladder waste 1.77 M tri, same buffers made (cellInstances 6.34 MB/s), terrain.ts:1373 DataTexture re-sent,
  gpuBatchedMesh.ts:92 388 a second, 84 long tasks + 153 long frames a minute, geometries +412/min, programs +7/min.

## lab-reports tiny files (shadow-shapes-AB-V5, shadow-shapes-AB-time-V5, inventory-all-V0, far-stride-AB-V5, far-stride-AB-V0)
- One word each ("A/B", "A/B time", "inventory"): empty stubs, no findings.

## lab-reports/rec-*.md (8 recordings, 2026-10-19 to 2026-10-26; 1,278 lines in all) - old builds (main 703e305d/adf7f2d4, b7fc6388)
- rec-2026-10-26T00-12-33 (173): small city; GTAO off saves GPU 1.5 ms (13 %); top CPU: profilerHooks.ts:36 anonymous (the lab's
  own hook, 123 ms), three projectObject, fitInstances instanceBounds.ts:5 (92.6 ms), measureHitch, readTick simClient.ts:548,
  levelOfDetail layer.ts:983, riggedCitizens draw :854, pickCitizenModel citizenCasting.ts:213, viewCells has :148; heap +2.3 MB/s.
- rec-2026-10-20 00-43, 00-20, 00-15 (188 + 186 + 183): 1,278 draws, 9.8 M tri, building-part-cells 432 draws / 5.73 M tri /
  418 k instances (draw count since cut); CPU 10-19 ms, half inside three (projectObject, setProgram, bindVAO, multiplyMatrices
  = per-object cost); simClient send :384 and readTick :509 (543 ms self) and fleetGrid place :32; drawVehicle agents.ts:2193;
  castersIn / measureSphere sunCascades.ts:340/223; 180-330 ms long tasks every ~5 s (periodic stall); geometries +53..+277/min,
  textures +27..+44/min; heap +44..+174 MB/min.
- rec-2026-10-20T00-04-20 (103): 234 s play, 2560x945; 236 frames > 50 ms, hitches up to 3,040 ms, 115 long tasks = 13.3 s;
  shader programs 249 -> 283 compiled during play (each next to a long task); 4,640 geometries +781/min.
- rec-2026-10-19 22-43, 22-41, 22-18 (171 + 142 + 132): toggling shadows/bloom compiled 70-219 programs in a minute (232 -> 451),
  stalls of 2.9-13.7 s and a 9,462 ms long task; sim step 24-93 ms; switching a setting recompiles everything.
- State: the per-object CPU cost and program compiles are the same open items (1a, the walk/draw cost); the old numbers are not
  the current code's (builds before many changes); no new item beyond: profilerHooks.ts:36 hook cost in the lab, fitInstances,
  simClient readTick/send cost, periodic long task.

## lab-reports/move-*.md (8 camera-move recordings, 2026-10-27 16:35-17:01, build cd917b6 = in 7c4de70f, the current code; 1,781 lines)
Read whole: 17-01-29 (252), 17-00-50 (255), 16-50-14 (280), 16-46-53 (221), 16-44-15 (215), 16-40-33 (194), 16-37-28 (206), 16-35-11 (158).
These are the real-gesture measures of the camera drag the mission's item 1 rests on. OPEN causes, by line:
- Uploads in the frame (25-2,206 MB/s while moving):
  * caller postprocess.ts:125 (the scene RenderPass, i.e. three uploading scene data at draw): texSubImage2D of 144x1 / 352x1 /
    48x1 / 96x1 / 112x1 / 32x1 / 240x1 / 80x1 FLOAT rows of 16 MB each (656 MB in 41 calls; 18,124 MB in 2,483 calls at the opening
    move 16-35) and 1x1 / 2x1 / 9x1 UBYTE of 8 MB each: data textures re-sent whole for a row change (three re-sends a DataTexture
    whole on needsUpdate) - the BatchedMesh indirect/matrix textures and other data textures (= item 1d, and wider than BatchedMesh:
    find every DataTexture written per frame; fix: addUpdateRange-style partial upload or a texture that does not change);
    bufferSubData 13,756-37,047 calls a move (up to 323 MB).
  * gpuBatchedMesh.ts:84 bufferData 38-100 MB (12-110 calls, up to 13 MB each: arena reallocation on growth), :295 and :227
    copyBufferSubData 22-71 MB (compaction/growth copies), :176/:190/:324 bufferSubData; uploads.ts:732 warm draws 1x1 with
    bufferData 20-61 MB; crowdAnimation.ts:276 texSubImage2D 159x1668 FLOAT 4 MB each (188-445 MB a move) = palettes re-sent whole;
    sunCascades.ts:376 1024x1024 texSubImage2D; canyonLight.ts:228 500x500.
- Palettes: crowdAnimation.ts:276 renders 1,161-4,652 a move outside the frame (renderPalettes riggedCitizens.ts:1145 / agents.ts
  :1823, 691-942 ms page) (= item 1b).
- Synchronous GL queries: getProgramInfoLog / getProgramParameter from postprocess.ts:125, sunCascades.ts:601/635/376,
  uploads.ts:329/732, crowdAnimation.ts:276: up to 698 ms + 343 ms in one move (23.7 ms a frame at 16-37): three's
  checkShaderErrors / program status read right after a compile blocks until the driver finishes - fix with
  KHR_parallel_shader_compile + compileAsync before first draw and `renderer.debug.checkShaderErrors = false` in release
  (three r186 docs) (= item 1a); programs still compiled in the move: 3-13, from uploads.ts:344 (no draw), building-lamp,
  shell-batch-facade depth, shell-batch-detail.
- Page work in the frame: casterChanges renderer.ts:498 (150-200 ms self a move); lot tool overlay drawOverlayScreen main.ts:3532
  -> lotTool overlay :782 -> refreshLots :828 -> moveWindow :897 -> doc.lotsIn :233 -> lotStore.in :195 (253-357 ms a move: lots
  queried every frame while the lot window moves); cameraSolids landed :246 -> foundation floorHeight :235 -> floors work :17
  (renderer.ts:1817) 326-351 ms; buildings geometry workOutLayout :650 / groundBays :625 / spansAgainst :353 (bay layouts in the
  frame); tableRows get :187 / rowOf :127 / recordTable readRow :705 / value :591; changes rectAround :119; viewCells has :74;
  engine refresh core/engine.ts:65; flatAtlas update :1066; plateFollow follow :13; lookProps propCells.ts:864; cellInstances
  append :612; sunCascades :624/:1113 anonymous; memoryCounters isAttribute :3 / add :55 (counting memory in the frame);
  partCells get triangles :377 (counter in the frame); processWorker.ts:192 message handler; agents sync :1827; readTick
  simClient.ts:662; network/rebuild step up to 115 ms in the frame.
- three per-object cost: projectObject 1.6-1.8 s with callees, setProgram 1.2-1.4 s, setTexture2D/uploadTexture 0.8-1 s,
  beginQuery/endQuery/createQuery (the lab's own timer queries, 300 ms - lab cost only).
- Vertex formats ANGLE converts (= item 1e, wider than listed): HALF x3 (lotBox, lotSides, frame, pot, acUnit, foliage, table,
  fin, louvre, lounger, dish: partCells/farParts/far-parts pictures), SHORT x3 normalized (rigged citizens @1 levels), USHORT x3
  normalized (building-massing-base), UBYTE x3 (terrain-ground and terrain-rim position template).
- GPU stalls behind: utility-wires 197 ms once, canyon-light 100-203 ms, sign-plates 58-137 ms with page time (sign texture upload),
  citizen card 66 ms; whole frames 120-165 ms GPU at the opening move (16-35/16-37: everything far, gardens-far-cells 20 ms,
  massing-plate 19.6 ms, Mesh ShaderMaterial (GTAO) 30 ms at 2560x1080).
- Late frames: 7-46 a move, 70-1,142 ms, almost all waiting on the CPU (page 32-1,140 ms).

## lab-reports/diagnose/*-large/report.md (40 runs of scripts/diagnose on the large city 8,102 buildings, 2026-10-22 13:43 to 10-24 06:53)
Read so far whole: 2026-10-24T06-53-46 (96), 10-22T21-49-19 (98), 19-36-11 (94), 19-17-06 (93), 19-12-52 (94). Findings (the same
across runs unless said; numbers of builds before many changes):
- Opening the city 17.6-35.8 s; page stalls 25-31 times (10.8-23.1 s in all, worst 1.8-10 s) on: getProgramParameter
  COMPLETION_STATUS polled from uploads.ts:291 (renderer.ts:4044-4075) 2,149-5,618 calls, 0.3-2.75 s, worst 2.27 s; postprocess.ts
  :331/356/417/432 program waits up to 1.4 s; uploads.ts:260/306 (warm uploads) up to 6.1 s; core/digest.ts:31 addPlain 0.43-0.53 s;
  recordTable.ts:405 value 519 ms; intern.ts:202 canon on reopen.
- Reopen 12.1-25.2 s (page stalled up to 5.6 s); save 10-20 ms with a 114-180 ms long frame.
- Flying allocates 176-262 MB/s: shellBatch.ts:248 worldGeometry (Float32 positions re-made, 375-658 MB a flight),
  cellInstances.ts:876-885 (379-608 MB), proceduralCrowd.ts:1430 (159 MB), postprocess render, agents.ts:1821/2216; GC 256-327 ms.
- Navigation: 76-233 frames over 25 ms of 330-637, p99 67-117 ms, worst 117-233 ms; top self time cellInstances.ts:876/881/885
  (0.8-1.5 s), derivedCache.ts:59 onsuccess (IndexedDB reads on the page, ~210 ms), renderer.ts:716-724 (casterChanges), sunCascades
  .ts:263-270, agents sync :2150 / :2216 / :1933, readTick, poleCells look :96 / view :222, instanceCull.ts:18, derivedCache :162.
- Shader programs compiled during play: 13 at district (3 standard "no program like it", signal-frame-depth, BONES skinned), 4-6 at
  street (building-part-acUnit, pot, foliage + depth), 2 at map (density-cars-v1), 2 navigating (louvre + its depth).
- Shadows in flight: 356-650 passes, cascades redrawn whole 68-270 / 50-114 / 28-35 times (noStore 72-330, refit ~70).
- GPU over the 12 ms budget at street (p95 16-31 ms), district 12.6-15.5 ms; GTAO ~1.6 ms everywhere.
- Map view 448 draws vs 400 budget (road-network 320 draws; far-forest 58) [fixed since? roads in one form].
- Quality: 10.9-21 % of pixels differ from a supersampled reference at street/district (aliasing, fine detail shimmer), 3-6 % map.
- Map view: world not done loading in 20 s.
- Console error (06-53): "A clip of a body could not be baked; its stand-in plays instead TypeError ... getComponent" (people).
- Code: gpuBatchedMesh.ts:310 getBufferSubData (a GPU sync read); peopleLab/polish.ts:241 and signals.ts:189 onBeforeCompile
  without own customProgramCacheKey; quality settings no code reads: optimizationsQuality.ts grassBlades, vegetationDistance,
  impostors, birds, rain, mist, waterfalls (unread: changing the tier changes nothing).
- Also read whole: 19-06-17 (92), 19-03-43 (92), 18-59-01 (96). Same findings; new lines: gardens.ts:75 gardenPack allocates 77 MB a
  flight; shellBatch add :61 (176 ms) and farParts add :191 (150 ms) in the flight; plantImpostors.ts:406 (impostor bake) waits on a
  program 46-53 ms; recordTable.ts:405 value 103-164 ms in the flight; street view GPU scene 35 ms p95 99 ms once (18-59).
- Also read whole: 18-50-27 (97), 18-41-51 (95), 18-10-46 (96). Same findings; new: instanceBounds.ts:5 fitInstances 60-77 ms in
  the flight (bounding spheres refit on the page); renderer.ts:1323 67 ms; lab gpu probe.ts:109 program queries (lab only).
- Also read whole: 18-02-50 (99), 17-54-46 (92), 17-51-56 (93). New: street view 27.9-28.4 M triangles vs 16 M budget and district
  21.2 M (17-54) with 751-815 draws; gpuBatchedMesh setGeometryAt :169 441 ms in the flight; changeBoxes.ts:31 78-166 ms;
  partCells get triangles :392 519 ms (a counter in the flight); gardens.ts:38 310 ms; instanceCull.ts:18 293 ms; massCells.ts:230
  171 ms; simClient applyParked :710 168 ms; instanceRuns matrixInto :63 147 ms; GC 2.1 s in one flight (17-51, worst frame 934 ms);
  reopen 21.6 s once (GC 1.7 s).
- Also read whole: 17-48-31 (98), 17-38-39 (96), 17-31-48 (96). New: occlusion.ts:204 layQuad 73 ms in the flight (CPU occlusion
  raster); casualties.ts:107 397 ms at the opening (blood decal meshes built at the opening); cellInstances.ts:507 704 ms at the
  opening; street 26 M tri (17-48); skinned crowd programs compiled at district (USE_SKINNING, BONES 53, PLAYS 4).
- Also read whole: 17-26-04 (98), 17-15-56 (96), 16-56-24 (95). New: changeBoxes.ts:31 up to 902 ms in a flight (shadow change
  boxes computed on the page); memoryCounters.ts:86 71 ms in the flight (counting memory each frame); renderer.ts:964 1,140 ms at the
  opening (warm-up); map view scene 29 ms / SMAA 6 ms GPU once (17-26: the map view drew 133 ms frames); district 18.5 M tri.
- Also read whole: 16-15-16 (97), 16-03-28 (98), 15-55-46 (97). New: uploads.ts:287 warm uploads stalled the page up to 8.1 s at the
  opening (16-03, opening 41.3 s, reopen 24.9 s); derivedCache.ts:95 onsuccess 230-264 ms in the flight (IndexedDB on the page);
  gpuBatchedMesh compact :292 71 ms in the flight; cellInstances.ts:496/663 414 ms at the opening; street 20.6-23.5 M tri, district
  14-15 M; GPU p95 38.6 ms at street once.
- Also read whole: 15-48-16 (96), 15-39-57 (96), 15-33-05 (94). New: one program wait 6.66 s at the opening (15-33, opening 35.3 s);
  postprocess.ts:356 one wait 1.57 s; sunCascades.ts:250 allocates 404 MB a flight once; street 22-24 M tri, district 21-21.7 M,
  934 draws at street once.
- Also read whole: 15-21-25 (92), 15-16-46 (96), 15-09-19 (93). New: world/buildings/grid.ts:55 cellAt 1,094 ms at the opening;
  BatchedMesh keeps sortObjects and perObjectFrustumCulled true (gpuBatchedMesh.ts:69, shellBatch.ts:201): a sort and a frustum test
  of every instance in every pass, each shadow cascade included (check: sortObjects=false / per-object cull off where the cells do
  the culling); district 34.4 % pixels off the reference once (15-09, GTAO at 0.47 ms: a quality switch in that build); street 948-975
  draws and 23.9-24.7 M tri.
- Also read whole: 15-05-43 (95), 14-59-18 (96), 14-49-16 (96). Same findings (BatchedMesh sort/cull flag, program waits up to 1.8 s,
  district ~34 % off the reference in these builds, street 22-25.6 M tri, reopen 20 s once, save 24 ms with a 204 ms frame).
- Also read whole: 14-36-36 (98), 14-30-37 (95), 14-24-01 (92). New: canyonLight.ts:372 dispose 2,000 ms at the opening (a render
  target or texture disposed and remade); uploads.ts:287 6.7-6.8 s page stalls (opening 35 s, stalls 27 s, worst 10.5 s);
  fencedCompile.ts:59/71/81 (an earlier compile scheme, polled COMPLETION_STATUS 4,258 times, 2.36 s; file may be gone now - check);
  lab gpu probe.ts:104 2.6 s in one flight (the lab's own probe, lab only).
- Also read whole: 14-15-48 (92), 13-57-22 (93), 13-51-26 (93). New: natureTrees.ts:156 1,574 ms at the opening (the nature tree
  warm-up forest built on the page); derivedCache.ts:94 onsuccess 562-808 ms in a flight (IndexedDB results handled on the page);
  digest.ts:72 word 371-396 ms at the opening; intern.ts:72 381 ms on reopen; fencedCompile.ts no longer exists (replaced since).
- Also read whole: 13-48-32 (91), 13-43-54 (91). New: elements.ts:70 553 ms in one opening frame (element glTF read on the page);
  editor/persistence.ts:646 2,311 ms in one frame on reopen; gpuBatchedMesh.ts:307 getBufferSubData ran (hot) in 13-43.
- All 40 diagnose reports read whole (3,799 lines). The diagnose series is of builds of 10-22/24 (main.ts:2636-2705, renderer.ts
  3205-3297 = older layout); the line numbers are not the current code's: every item above is to be re-found in the current code.

## lab-reports/diag-2026-10-27T16-49-45.md (857 lines) - F7 diagnosis, view still, build cd917b6 (= current code)
- GPU 155 ms a frame at 2560x1080 (GTAO 35.7, clouds 30.6, SMAA 24.3, canyon 12.2, scene 52 ms; the earlier diag 2-3 ms each: the GPU
  was contended in this one, "grown" from 2.16 -> 35.7): the passes still cost per pixel (GTAO, clouds, SMAA, canyon at full res).
- Re-sent with the SAME content every frame (needsUpdate set without a change) (OPEN): agents.ts:1202 far car parts (car-hatch-far,
  suv-far, truck-far, bicycle-wheels@7, bicycle-spokes@4, bike-bicycle-body/trim/steering/cranks, vehicle-lamps, vehicle-shadows
  24/24 frames); riggedCitizens.ts:1066 (citizen @1 and @card attribute 24/24) and :1076; densityCars.ts:548 193 a second (1.19 MB/s)
  and densityCars.ts:276-286 geometry rebuilt (writeTile :488 / update :569 47 ms); signals.ts:383/386/391 far lenses and halos;
  citizenPlays.ts:32/83 DataTexture 0.67 MB/s; crowdAnimation.ts:287 DataTexture 6.4 a second, :276 texSubImage2D 159x3156 FLOAT
  7.66 MB whole; wear.ts:130; gpuBatchedMesh.ts:92 44.6 a second.
- Matrices worked out every frame for objects that never moved: 41 (blast 9, room-light 6, gore 4, Object3D 3, casualties 3).
- Page work in the frame: casterChanges renderer.ts:748/498 (33 ms), plantCells.ts:33 sync (76 ms with callees), world/cells.ts:157
  someAt (32 ms), viewCells.ts:124 (31 ms), layerCells.ts:343 covers (30.5 ms) and :216/:183 unpackCover (16.8 ms), cellInstances
  .ts:1183 update / :563 / :372 file / :612 append, store.ts:180 nearIds (16 ms), plateFollow.ts:28, ui/healthPanel.ts:259 (17 ms,
  an interval), jobPool.ts:174 message 5.4 ms/s; "nature" step 32 ms in 15 frames.
- Held twice: terrain-ground x62, terrain-rim x62, bus body-lite x3, truck body/@7, truck body-lite/@7, lotBox/-caster, five car
  wheel geometries identical, sedan/wagon trim, glass/glassDark, bus doors x4, bus/truck wheel, blast-debris/gore-cuffs.
- Finer than the pixels: trees oak 202 tri at 0.1 px (214 instances), cypress cards 140 tri at 0.1 px, palm 240 tri at 0.1 px,
  terrain-ground 6,144 tri over 6 px, citizen @1 1,668 tri over 1.2 px.
- Heap +859 MB/min (1,846 MB); 223 long frames a minute; 232 programs (+0).

## lab-reports/diag-2026-10-27T16-46-21.md (751 lines) - view still, cd917b6
- GPU 13-14.3 ms a frame (77 % busy) at a district view: scene 8.9, GTAO 2.2, canyon 1.0, clouds 0.95, SMAA 0.8; far masses 1.38 M tri
  (38 %) in 24 draws; parts 761 k tri / 136 draws / 240 k instances; gardens far cells 557 k tri; lotBox far 14,141 draws timed in 179
  frames (= 79 instanced draws a frame), water / lotSlab / lotRail 24 a frame each.
- Page work: draw 9.7 ms a frame; viewCells look :111 / has :74; terrain settle :2606; cameraMotion get moving :143 (32 ms!);
  farParts choose :96; targetBytes.ts:49 liveTargets (31 ms: counting targets in the frame); poleCells look :134; profiler beginFrame;
  layer.ts:743 update; memoryCounters fields :100 (counting in the frame); processWorker.ts:33 walk (recursive, 50 ms);
  three getParameters 135 ms (material program parameters recomputed: needsUpdate / per-draw program lookups), needsUpdate 142 ms,
  bindVertexArray 172 ms.
- Re-sent: densityCars.ts:548 494 a second (3.14 MB/s); agents.ts:1202 1,977 a second; agents.ts:1194 glow; gpuBatchedMesh.ts:92 387
  a second; signals.ts:383/386/391; the same far car / wheel / hub / bicycle buffers with the same content 24/24 frames.
- Same held-twice list; same trees finer than pixels.

## lab-reports/diag-2026-10-27T16-43-38.md (707 lines) - view still, cd917b6
- GPU 12.4 ms (79 % busy): far masses 1.86 M tri (49 %) in 32 draws (massing-plate 235 k tri one draw); gardens 907 k tri / 454 k
  instances in 9 draws (gardens-far-cells 3 ms a frame, the biggest draw); GTAO 1.9 ms; draw 9.8 ms CPU.
- Page work: drawOverlayScreen main.ts:3002 (45 ms self), viewCells.ts:186 look (45 ms), casterChanges :748 (41 ms), flatAtlas.ts:940
  updatePaint (41 ms) and terrain.ts:2271 updatePaint (28 ms) (paint updated in the frame with the view still), postprocess.ts:459
  targets (32 ms), cellInstances.ts:348 / :682 shadow, core/perfBudget.ts:29 stepBudget (24 ms), editor/lotTool.ts:703 refreshLots
  (23 ms, lots refreshed with the view still), terrainLod.ts:392 write / :366 visit (recursive); three setProgram 907 ms total,
  getBindingState 185 ms, copy 114 ms, postMessage 114 ms, onBeforeRender 528 ms (per-object callbacks).
- Same buffers re-sent 24/24 with the same content (far cars, wheels, hubs, bicycle, motorcycle parts: agents.ts:1202 2,074 a second);
  densityCars.ts:548 443 a second; signals.ts:383.

## lab-reports/diag-2026-10-27T16-40-01.md (667 lines) - whole-city-ish view still (zoom 0.675), cd917b6
- GPU 13.9 ms (82 % busy): far masses 2.52 M tri (55 %) in 18 draws; gardens 1.66 M tri / 828 k instances in 16 draws
  (gardens-far-cells 4.9 ms a frame = the heaviest draw: far garden pictures, 2 tri a plant); road-far-blocks 1 ms.
- "Gone" since the report before (16-36-56), i.e. seen there: densityCars.ts:408 DataTexture re-sent 86,922 MB a second (!) and
  densityCars.ts:605 2.85 MB/s; massCells.ts:264-271 geometry buffers made 5.8-11.5 MB a second each (position, normal, color,
  facade, facadeGrid, glazingSeed: mass cells rebuilt while the view was still).
- Page work: casterChanges :748 163 ms self; cellInstances.ts:758 append 100 ms and :1038 visit 90 ms (recursive x11);
  drawOverlayScreen 54 ms; agents sync :1846 216 ms with callees; viewCells has :148; candidateKeep.ts:25 CandidateKeep 34 ms (an
  object made in the frame); memoryCounters isAttribute :35; changes.ts:274 since; flatAtlas.ts:928 update; shadowCasters.ts:67
  castShadowKey; three getBoundingSphereAt 148 ms (BatchedMesh per-instance cull), copy 117 ms, onBeforeRender 358 ms.
- Held twice adds: building shutter/lamp/louvre geometries identical, concrete/water/fin identical (kit unit boxes duplicated).

## lab-reports/diag-2026-10-27T16-36-56.md (658 lines) - whole map (zoom 0.352), view still, cd917b6 - CPU-BOUND 33 ms, 25 fps
- HIGH (OPEN): densityCars.ts:408 the road-line DataTexture (9.32 MB) sent again WHOLE 9,325 times a second = 86,922 MB/s, from
  writeLine densityCars.ts:364 / readLines :417 / update :569 (6.5-6.7 ms a frame): each road line written re-sends the whole
  texture. Fix: write the lines into the array and upload once (or addUpdateRange-style partial texSubImage of the rows changed),
  never a whole-texture upload per line. Also densityCars.ts:605 DataTexture 3.2 MB re-sent; densityCars.ts:276-286 tile geometry
  rebuilt 51.5 a second (aLink/aMove/aPaint/position/normal).
- massCells.ts:264-271 mass cell geometry made again 3.5 a second, 3.32 MB each (position/color/facade/facadeGrid 11.5 MB/s,
  normal/glazingSeed 5.8 MB/s) with the view still: cells remade although nothing changed (check why: levels flipping, plates?).
- far masses 5.83 M tri (97 %) in 32 draws; massing-plate 157.6 k tri over 219 px (1 tri a pixel).
- Page work: cellInstances.ts:1038 visit 73 ms (recursive x11); world/cells.ts:157 someAt 51-67 ms; cellKeeps.ts:153 settle 176 ms
  with callees; casterChanges 38 ms; renderer.ts:2262 refresh; flatAtlas update :928 / ask :772; streetFurnitureLayer get
  triangles :575 (24 ms, a counter); world/doc.ts:424 node; openLots.ts:242 rebuild (lots rebuilt in the frame); grid.ts:128 near;
  poleStores.ts:335/416/626 uploads; utilities.ts:439-443 wire geometry rebuilt 4.3 a second; farForest.ts:245-249 rebuilt 2.8 a
  second; cellInstances.ts:248-254 / :1024-1025 geometry made 7.3 and 90 a second.
- One frame 2,268 ms; 20 late frames, all waiting on the CPU; geometries +256/min; error events in healthWatch.ts:91 /
  fieldReport.ts:101 (0.2 a second: errors being raised while still).

## lab-reports/diag-2026-10-27T16-33-41.md (541 lines) - whole map (zoom 0.096), view still, cd917b6 - GPU-BOUND 171 ms, 5 fps
- HIGH (OPEN): far masses 21.85 M tri (96 %) in 98 draws; building-massing-plate 333.8 k tri over 94 px (12 tri a pixel), drawn
  588 times in 12 frames (49 a frame: plate drawn once per cell/pass?) at 76.5 ms + depth-first 25 ms a frame. Fix: a plate level
  chosen by screen error (one rung coarser past a size), not the same 333 k-tri plate at every zoom.
- densityCars 180 draws (45 % of draws) for 177 k tri: one mesh per tile; merge per tile group / instancing.
- Terrain 90 draws (terrain-ground 528 calls in 12 frames); terrain-ground 512 tri over 0.4 px, terrain-rim 256 tri over 0.3 px:
  a level chosen by size is missing for the far terrain tiles; terrain-ground x38/x20 and terrain-rim held twice (same geometry).
- Post passes at the whole-map view: Clouds 12.9 ms (p95 77.8), GTAO 10 ms, SMAA 8.2 ms, canyon light 3 ms: postprocess.ts:125
  scene render 1,327 ms over 12 calls; depthFirst.ts:69 300 ms.
- CPU in drawing 24 ms: casterChanges renderer.ts:748 34 ms, flatAtlas.ts:910 29/46 ms, terrain.ts:1626 sampleGrid 17 ms (in the
  frame), plantCells.ts:33 sync 16 ms; three setValueV2fArray 25 ms, applyMatrix4 19 ms, needsUpdate 17 ms (attributes marked again).
- densityCars.ts:548 attribute re-sent 145 a second; densityCars.ts:276-286 tile geometry rebuilt; gpuBatchedMesh.ts:92 DataTexture
  29 a second; cellInstances.ts:1024-1025 3.4 a second.
- JS heap 1,910 MB, +540 MB/min over 3 min (a leak or unbounded cache at the whole-map view); 155 long frames a minute.
- 41 static matrices every frame (blast 9, room-light 6, gore 4, casualties 3); held twice: bus body lite x3, truck bodies x2,
  car wheels x5, sedan/wagon trim, shutter/lamp/louvre, concrete/water/fin, glass/glassDark, bus doors x4, bus/truck wheel,
  blast-debris = gore-cuffs.

## lab-reports/diag-2026-10-27T15-25-24.md (326 lines) - centre zoom 0.45, view still, 51c3de4 - 60 fps, headroom
- far masses 9.16 M tri (94 %) in 40 draws; building-massing-plate 327 k tri even at zoom 0.45 (OPEN, same as above).
- jobPool.ts:174 message listener 27 ms a second (209 calls/s) with the view still: the job pool answering all the time while
  nothing changes (OPEN: find what is posted every frame when still).
- Page work with the view still: cellInstances.ts:1038 visit 112 ms (x11 recursion), cellInstances.ts:1240 cull 34/165 ms,
  flatAtlas.ts:659 sync 67 ms, flatAtlas.ts:928 update 50/117 ms, cellKeeps.ts:153 settle 57/108 ms, terrain.ts:2476 settle 34 ms,
  terrain.ts:2271 updatePaint 33 ms, propCells.ts:790 lookProps 32 ms, natureTrees.ts:156 31 ms, streetFurnitureLayer.ts:70 step
  49 ms, hitch.ts:2 measureHitch 49 ms (the game's own counter), simClient.ts:412 send 2.8 ms a frame (sim sent every frame while
  still), processWorker.ts:33 walk 5 % (recursive x3).
- gpuBatchedMesh.ts:92 DataTexture re-sent 413 a second (view still). 134 long frames a minute.
- Terrain 26 draws; terrain-ground 2 k tri over 1.9 px; terrain-ground x56 / terrain-rim x56 held twice; vehicle parts held twice;
  41 static matrices every frame.

## lab-reports/diag-2026-10-27T14-59-21.md (572 lines) - centre zoom 0.45, dafe5f9 - CPU-BOUND 30.5 ms, 31 fps
- HIGH (OPEN in that build): roadPaint.ts:219 DataTexture 8 MB re-sent 789 a second = 6,311 MB/s (gone in 51c3de4: recheck in the
  current code that roadPaint uploads only the rows written).
- casterChanges renderer.ts:744 104/146 ms (the shadow caster scan over every object, every frame: make it proportional to
  what changed); digest.ts:72 word 38 ms (hashing in the frame); junctionPiece.ts:85 ringRun / :54 returnSteps / :186 squareRun
  62 ms (junction pieces derived in the frame: road surfaces derived on the page, roadSurfaceSteps roadSurfaces.ts:200 4.8 ms a
  frame, roadSurfaceInputs.ts:356 wakeRect / :351 wakeTile / :697 visits / :365 deriveCell / :56 derive 3.2-3.4 ms a frame);
  changeBoxes.ts:31 addChangeBox 28.5 ms; viewCells.ts:148 has 28 ms, viewCells.ts:332 make 3.6 ms a frame, :173 ensureMany 3.4 ms
  a frame; regionIndex.ts:37 fromRings 27/46 ms; recordTable.ts:606 readRow 26 ms; poleStores.ts:226 shadow 25.5 ms;
  memoryCounters.ts:100 fields 24 ms (a counter in the frame).
- Made as the game runs (view at rest after a move): roadLod.ts:12-17 road LOD geometry 10.7 a second (0.21 MB roadSection + pos/
  normal/color/uv); utilities.ts:439-443 wires 34.5 a second; poleStores.ts:335 re-sent 48 a second (3.9 MB/s), :621/:411/:704;
  terrain.ts:1373 DataTexture 0.62 MB 2.4 a second, terrain.ts:1689-1691 seam geometry and :1700 texture 2.4 a second;
  massCells.ts:262-269 4.36 MB a cell 0.3 a second, massCells.ts:117-118 base; farForest.ts:245-249 10 a second;
  cellInstances.ts:248-254 / :1024-1025; farBlockBatches.ts:129 DataTexture 3.6 a second; gpuBatchedMesh.ts:92 174 a second.
- JS heap 2,232 MB +717 MB/min; 26 long tasks and 165 long frames a minute; geometries +151/min.
- far nature tree buffers re-sent (1/24 frames each, 12 kinds x2 layers).
- Wheels held 5 times per level (@1/@2/@3/@5 copies): each car kind has its own byte-identical wheel geometry per LOD rung;
  bus/truck wheels the same; terrain-ground x50.

## lab-reports/diag-2026-10-27T14-56-08.md (522 lines) and 14-51-22.md (533 lines) - district zoom 2.63, view still, dafe5f9 - 60 fps, GPU 16 ms
- building-part-cells 2.1 M tri in 227 draws (47 % of draws), 346 k instances, 9 programs; building-awning 124 k tri.
- building-shell-batch-facade 532 k tri (30 instances).
- HIGH (OPEN): far street furniture cells drawn with the NEAR models: street-bins-near-unsimplified-far-cells 182 tri over 0.2 px
  (672 instances), benches-near-unsimplified-far-cells 164 tri over 0.4 px (700), hydrants-near-unsimplified-far-cells 164 tri
  over 0.2 px (238), street-lights-near-far-cells 132 tri over 2 px (674), street-lights-mid 88 tri over 2 px: the far cells use the
  near/unsimplified geometry ("-near-unsimplified-far-cells"); the far rung must use the coarse model chosen by screen size.
- planted/nature trees: full trees (202-240 tri) and cards (80-240 tri) both drawn at 0.1-0.3 px: a tree far rung (or none past
  sub-pixel, drawn by the far forest) is missing; palm cards = 240 tri, as heavy as the full palm (the card level is not lighter).
- terrain-ground 12.7 k tri over 9.3 px.
- CPU 12.5-13 ms in drawing: renderer.ts:1618 anonymous 41 ms; cellKeeps.ts:150 settle 26/81 ms, :153 22 ms, :156 17-33 ms;
  poleStores.ts:360 view 22/39 ms, poleStores.ts:130 atPoint 17 ms (later fixed per earlier finding: recheck); casterChanges
  renderer.ts:744 20 ms; signLayer.ts:390 sync 17 ms; streetFurnitureLayer.ts:490 sync 16 ms; viewCells.ts:354 touch 16 ms,
  viewCells.ts:148 has 58 ms, viewCells.ts:308 trim 29 ms; main.ts:3002 drawOverlayScreen 16 ms; sunCascades.ts:299 sphereOf
  51 ms, sunCascades.ts:75 updateMatrices 18/35 ms (shadow cascade bounds recomputed every frame with the view still);
  layerCells.ts:216 unpackCover 28.5 ms; terrainShaping.ts:78 sampleCorners 27 ms; renderer.ts:3001 natureStands 26/54 ms;
  terrain.ts:2433 get ecologyRevision 26 ms (a getter that computes); candidateKeep.ts:14 keepCellOf 24 ms; hitch.ts:2 19 ms.
- three hot leaves: needsUpdate 3.4-7.2 % (attributes/uniforms marked again), multiplyMatrices 5.6-6.1 % (matrices of static
  objects), getBindingState 6.3 %, bindVertexArray 4.8 % (many draws).
- gpuBatchedMesh.ts:92 DataTexture re-sent 363-402 a second with the view still (three BatchedMesh indirect texture).
- lab-only: usage.ts:59 idle 452 ms a call; lab/window.ts:183 2D context asked 126 times (the lab window, not the game).
- JS heap +1,397 MB/min; geometries +118/min; jobPool.ts:174 60-75 calls a second while still; 86-94 long frames a minute.
- profilerHooks.ts:23 geometry made (instancePoseA/B, aSphere, aBlock): the profiler hook wraps creation, the real makers are
  cellInstances / partCells.

## lab-reports/coverage-2026-10-19T22-42-23.md (950 lines) - V8 coverage, 25 s session, old build
- 46.1 % of mapped lines ran; 6,680 of 11,391 functions never ran; 102 src files never loaded on the page (workers, desktop, tests,
  or dead). Coverage of a short session: low coverage is NOT proof of dead code (tools and editing were not used).
- knip (static, the real dead-code evidence): 6 unused files (src/lab/inspector/describe, dom, entity, raycast, related, state),
  83 unused exports and 58 unused types (list in the report, e.g. render/markings.ts:7 re-exports, cellArrays.ts massGrid/snorm16/
  cellShellGrid, flatAtlas.ts writeFarNode, instanceCull.ts:32 markRange, roadLod.ts:5 blockBuffers, farTiles.ts:216
  aggregateBoxes, sim/meso/tileFeed.ts TileLinkFeed), 7 unresolved imports in scripts/*.mjs (quality.ts, partPose.ts, finishes.ts).
  OPEN (low): recheck with knip on the current code; delete what is dead (no visible change). Not a frame cost.
- Of note for the frame: files at 95-100 % run (cellInstances 95.7 %, profilerHooks 96 %, partPose 95.5 %, natureTrees 93 %,
  sunCascades 93 %, plantCells 92 %): the per-frame paths. render/fogLayer.ts and cloudShadowStamp.ts run (item 3 removes them).

## lab-reports/capture-V5-moving.md and capture-V5-after-F14.md (1 line each)
- Both hold only a 7-character stub (no content): nothing to record.

## lab-reports/auditoria-2026-10-19.md (182 lines) - measured audit, small city 1,348 buildings, main build of 10-19
- P-01 lot surfaces (bLots: lotBox/lotRail/lotSlab, buildingMesh.ts:902-905, world/buildings/lots.ts:54): 2.3 M tri in the district,
  building-lotBox 146 k tri / 14.6 k instances; -4.4 ms district if off. Solution proposed: merge lotBox/lotSlab per material/cell,
  a slab/quad for small lots, lotRail only near. OPEN (recheck what lots draw now; see also the polygon audit "lawn polygon
  under lots").
- P-02 shells (bShell) 326 draws for 959 k tri (~2.9 k tri a draw): merge shells by finish into one batched draw per cell. Later
  work (shellBatch / building-shell-batch-facade) did part of it: recheck the draw count.
- P-03 facade details (bFacadeDetails: railing, roofRailing, awning, column, water, lamp, wash, fin, louvre, brise): 138 draws,
  1.55 M tri in the district: LOD by screen size (kept close).
- P-04 detailed walls (bDetail) 342 draws/882 k tri in the district.
- P-05 shadows: partCells.ts:290-300 customDepthMaterial per part; static shadow cache by region, update only when sun/geometry
  changes; fewer far casters (casterChanges per frame is the CPU side of this).
- P-06/P-07 GTAO / clouds / SMAA small at 1080p (clouds come out by the owner's order, MISSION item 3).
- P-08 1,197 draws in the district: merge batches.
- P-09 cells of the whole explored area stay resident: renderer.ts setActiveTiles has no caller (main.ts:1904 "NO WORLD BY TILES IS
  OPENED"): 374 -> 2,185 geometries, 121 -> 340 MB geometry, 252 -> 540 MB textures after visiting 4 corners. Memory grows with
  the area EXPLORED, not the area seen. OPEN: release cells far outside the view (a large radius) without tiles, keeping the
  single-map document (the owner's decision stands).
- P-10 full save JSON.stringify(doc.toJSON()) 31.7 ms / 10.5 MB for 1,348 buildings (main.ts:798-812 serializedDoc,
  store.ts:240-244 toText, editor/history.ts:72-77 whole snapshot for undo): O(n) per autosave/undo. Solution: incremental save
  per tile/record (TiledSaves / chunkedSave already exist) and undo by patch. OPEN: recheck what the save and the undo do now.
- P-11 simulation step 10.5 ms, the governor cuts population to 44 % (populationGovernor.ts HIGH_MS 6.5): profile the worker per
  system before changing.
- P-12 opening: a 217 ms frame and a 1.91 s LoAF (people/body/proxy.ts 141 ms, three checkMaterialsReady 179 ms): compile people
  and cell materials before the first view (MISSION 1a).
- P-13 bParts 37.5 % of the district GPU (432 draws, 418 k instances, 20 kinds x runs x cells: partCells.ts runsOf/make/choose).
- P-14 opaque sort by depth: -0.95 ms street, +0.8-3.8 ms CPU: not adopted.
- P-15/P-16 people/vehicles 1.4 M tri / 80 draws; simClient readTick decode per frame (4.5 % in a player profile).
- Kept (not to touch): compileAsync/drainUploads/drainCompiles, scene.matrixWorldAutoUpdate=false + updateMoving, gpuOnly,
  populationGovernor, the lab code (usage.ts readVram 170 ms every 5 s is lab, not game).

## reports/vigia/buildings-inventory.md (110 lines) - read-only inventory of what a building draws (2026-10-23)
- Inventory of shell faces (buildingMesh.ts emitters), the 28 kit part kinds and their levels, furniture (40 kinds: bookshelf
  1,814 tri, officeChair 820, plant 462, bars 438, shelf 370), lot plants, windows (shader), far levels, signature/landmarks, flags.
- OPEN (read, not measured): FarPartBatch built at layer.ts:174 right after the kit, before MeshoptSimplifier.ready: the far batch
  probably draws the 9 simplified props (pot, foliage, bush, chair, table, airer, dish, lounger, bike) at their full L0. Check in
  the current code; fix: build (or rebuild) the far batch after the simplifier is ready, with the coarse level.
- emitLantern 982 tri + flag; flag cloth flagLayer.ts:106 a 24x12 plane = 576 tri per flag (no LOD); clock 160 tri as 16 lotBox;
  roofRailing 78 tri at L0; railing 222 tri per piece (21 boxes); tank 136; vent 84; interior stair 120.
- Buildings have NO impostor; signature-* and flag-cloth are in no memory group (perfBudget.ts:76).

## reports/vigia/entregas/39282f65-786dc8f4.md (41) and 39282f65-a6eb9ce6.md (56) - catalogue "hidden triangle" ruler
- The catalogue's hidden-triangle rule was wrong (an open strip counted as hiding): fixed in a6eb9ce6 (measure.ts: hides only when
  closed or open along one plane). On 759af93f: 1,662,866 tri, hidden 188,568 (old rule) -> 96,424 (new). Lab tool only.
- Stage 1 geometry 1,662,866 -> 1,501,550 tri was ready after it (see the later notes).

## reports/vigia/entregas/39282f65-etapa1/**/gaps.md (7 x 11 lines) and 39282f65-regua/** (gaps 11, comparacao 23)
- The same text in each: the catalogue cannot measure clouds (ray marched), vehicles' run-time intermediate levels, editor
  feedback; with --no-game no copies/costs/draws. Hidden per group (new rule): far facade L1 45,777 of 756,308; made to measure
  23,357 of 379,290; functions 17,806 of 379,792; masses ~0. OPEN: the far facade L1 still holds ~6 % hidden triangles (removed by
  the rebuild of the models, MISSION item 5).

## reports/vigia/entregas/601adfb7-etapa1 (fichas-antes 24, fichas-depois 24, lado-a-lado 24) - people LOD ladder
- People cooked levels before: L0/L1/L2/L3 total 83,031 / 63,967 / 24,261 / 9,936 (mh_59 L0 11,590, L1 10,688, L2 8,188: a
  broken ladder); after: L0/L1/L2 60,975 / 26,520 / 4,786 (L2 ~300 tri each, L0 error 0.22-0.25 % of height). FIXED (601adfb7, the
  people ladder rebuilt). Atlas bytes unchanged ~10 MB for 16 people.

## reports/vigia/entregas/a40805b3-506b4736.md (109 lines) - stage 1 of the buildings: one program, one emitter
- FIXED 506b4736: program.ts MassProgram/MassRecorder; buildingMesh.ts:4161 emitProgram the one walk; runCellJob reads cached
  programs (cellWork.ts:130 JobPrograms); old emitMassing/emitBase deleted; an edit re-walks only that building (key: id + record
  digest + ground digest + paving + floor + tone; cellWork.spec.ts:185).
- Known defects left (OPEN): the program cache is per worker (32 MB LRU) and jobs go to any worker, so re-walks across workers
  still happen (fix: route a cell's jobs to the worker that holds its programs, or a shared cache); the facade level and the detail
  are still two walks when asked at different times; stale comment engineBuildings.ts:35; lotGround closures kept in the summary.

## reports/vigia/entregas/a40805b3-719e6551.md (48 lines) - stage 0: the facade-view stall
- The stall blamed on 6a2ba7be was NOT the building code: it happened only in the shared working copy with another session's broken
  road code (roadSurfaces.ts:288 "paintBase is not defined") and "[uploads] a program was not built in 10000 ms"; clean worktrees of
  both versions ran 4/4 views. Run-to-run photo noise 0.14-0.43 % (the yardstick for "no visible change"). DECIDED.

## reports/vigia/entregas/a40805b3-759af93f.md (137 lines) - stage 1b of the buildings
- FIXED 759af93f: (b) floor-relative program (lots apart, program.ts:89 LotsProgram; Float64 points, a Float32 defect found and fixed);
  (c) near and far in one walk within 2x the L0 reach (massCells.ts:29 PAIR_REACH, :886; fence posts / drains only(NEAR)
  buildingMesh.ts:3275/:3443); (a) cell affinity in the job pool (jobPool.ts:54/:489/:534, AFFINITY_LOOK 32; cellAffinity.spec);
  (d) tile/plate/base joined from per-cell slices kept in the derived cache (cellPool.ts:33/:42/:289, cellArrays.ts:301 joinMass).
- 0 % triangle change by design; 482/482 catalogue sheets identical.
- Left OPEN: an owner worker busy -> the job walks again on another worker; slices from earlier sessions stay until the fingerprint
  changes; the join from kept slices was tested only in Node; cellRequests.want never passes `hole` to pool.run; lint debt
  (cellPool.ts:22-25 module state, :278 a silent catch; layer.ts and massCells.ts over 800 lines); 26 failing specs of roads and
  arch/layers (three imported by src/dev/people*) that were already failing. Next ordered then: kit railing 222 -> 44 tri.

## reports/vigia/entregas/a40805b3-etapa1/** and a40805b3-etapa1b/** (gaps x7 of 11 lines, comparacao 15, comparacao-catalogo 15)
- The same gaps text (see above). Stage 1: only the council masses changed (cell 244 -> 148, tile 180 -> 84); stage 1b: 0 objects
  differ. Nothing new to fix.

## reports/vigia/entregas/fda9a8e2-85f4e048.md (72 lines) and fda9a8e2-etapa1/summary.md (57 lines) - road paint in the shader
- FIXED 85f4e048: lines along roads are data in two float DataTextures read with texelFetch (roadPaint.ts:29, reserve :41, set :56),
  drawn analytically in the asphalt shader (roadEdges.ts:18 CARRIAGEWAY_PAINT); -2 draws a straight road, -7 at an avenue junction.
- OPEN (this is the root of the later 6.3 GB/s re-send, diag 14-59-21 roadPaint.ts:219): the paint table is a whole DataTexture;
  each road's look writes its row (roadSurfacePass.ts:46) and the whole 8 MB texture is marked for upload. Blocks of the table are
  never freed (every new document, each warm-up, takes a new block of >= 64 slots for the session). Fix: write the rows and upload
  only the changed rows once per frame (texSubImage of the dirty row range: three r186 Texture has no addUpdateRange, so keep a
  dirty row span and upload it with a sub-image in onUpdate / or a per-frame flush), free a document's block when it is let go.
- Still polygons (stage 2 not done): turn arrows, bus legends, stop lines, crosswalks, mini-roundabout islands, tapers, parking
  lines, approach legends (see the polygon audit: parking lines 1 point a metre, mini-roundabout ~1,440 tri).
- Road vertices are 56 bytes each in every layout (summary table, "Bytes/vertex 56 -> 56"): a heavy vertex; candidates for
  packing (normal oct-encoded, uv/section as half or short) where the format is read natively by D3D11 (4-component, not 3).
- Broken lines on a curved road never checked (no curved layout in the catalogue).

## reports/vigia/library-research-buildings-people-objects.md (47) and library-research-roads-terrain-lod.md (54) - 2026-10-24
- No library generates procedural buildings for three.js; the game already does instancing/LOD/crowd GPU skinning/interior windows
  by its own code. The gaps are geometry discipline (hidden faces, heavy kit and props, broken LOD ladders), not libraries.
- Candidates only if they beat ours on a measured case: InstancedMesh2 (per-instance LOD, shadow LOD, BVH culling),
  BatchedMesh + batched-mesh-extensions (official webgl_batch_lod_bvh); meshoptimizer 1.3 (we have 1.2.0: LockBorder chunk LODs,
  Sparse, Regularize for skinned, simplifySloppy/Prune for far levels); three-mesh-bvh for raycasts; earcut 3.2 refine();
  Delaunator + Constrainautor for terrain with road/lot breaklines; Terrain3D clipmap pattern for editable terrain.
- The owner's rule (library-eval-unbiased): never use the game as the yardstick; prototype each library's best use and let the
  owner decide. DECIDED: no library adopted.

## reports/vigia/objects-inventory.md (86 lines) - everything drawn that is not a building or road surface
- People: 16 cooked bodies, one SkinnedMesh each, drawn as 4 InstancedMeshes per body (one per level) + 1 card
  (riggedCitizens.ts:535-570); GPU skinning by a palette pass (crowdAnimation.ts:229-236); 13 face morphs on L0 only.
  HIGH (OPEN in that build, recheck): "Today no person loads": the cooked manifest hash 62cf9d765ce349d9 did not match the cook
  code's hash (INVENTARIO.md:10). cooked/procedural/*.bin (38 files) ORPHANED, nothing reads it.
- Vehicles: one InstancedMesh per part per style; 7 levels at run time by meshoptimizer (partLevelsWork.ts:9-14); hidden triangles
  NOT removed (hatch 109); L0 ~14-15 k tri a car (shell 9,720), bus 8,872 (interior 6,172), wheel 404, spoked 672, far 24-96.
- Street furniture: lamp 132 -> far 32, bin 182, bench 164, hydrant 164, postbox 92, phone 560, drain 108, tree pit 90 (each near ->
  a 12-tri box under 12 px). HIGH (OPEN): in far blocks they are drawn with the full near mesh (propCells.ts:405-427) = the
  "-near-unsimplified-far-cells" of the 14-51/14-56 diags. Fix: the far block uses the far rung.
- Signal head 412 tri (frame 52, visors 6x12, lenses 6x36, halos 2x36; signals.ts:116-127), no LOD. Barriers per 70 m: railing
  6,996 tri (boxes of 12), fence 864, guardrail 648. Utility wires 64 -> 2, 9 wires a span; transformer 56.
- Landscape glTF (elements.ts:70): flowers 755-1,690 tri, mushrooms 880-3,216, clover 379-615, tallGrass 326-622: heavy small props.
- Rain 10,000 segments; exhaust 4,000 points; sky dome 960; flags 576.

## reports/vigia/PROTOCOL.md (58 lines) - the VIGIA stage protocol (old multi-session era)
- One stage = one commit with evidence (before/after measurement by the same command, photos), a delivery note, the VIGIA re-runs.
  Superseded by the owner's later rules (no subagents, no measuring, the main session commits). Nothing to fix.

## reports/vigia/roads-analysis.md (77 lines) - where the road polygons are
- Verge mesh (roadSurfaceReads.ts vergeTop, VERGE_ACROSS 6 strips + skirts) duplicates the shaped terrain (elevation.ts:213-221
  SHAPE_INNER/SHAPE_SHOULDER/BATTER): half or more of every road's triangles; skirts/walls on every band; the 76.8 m tile cut
  (4 meshes a band); footway and kerb as separate bands. Solution decided: delete the verge (terrain shaped to the footway edge), one
  swept cross-section per side, no skirts at ground level, pieces whole in their owner's block. FIXED later by the roads work
  (8e1e9f25, 6c7361fb "roads in one form": straight 140 m 412 -> 58 tri, per the stage-1 spec).

## reports/vigia/roads-stage1-junction-spec.md (102 lines) - the junction spec (the owner's tool is the spec: 178/114/50 tri)
- Junction: plate from its outline only (earcut+refine flat; Delaunator+Constrainautor crowned); kerb arcs with nested equal-angle
  stations n = 8/4/2 by level (L0 < 90 m, L1 90-350 m, L2 > 350 m), mouths identical at every level; L2 no kerb face; kerb top from
  the shader; footway corner from its outline; ramps as exact planes. Targets: four-way <= 260/200/90, straight <= 58/58/12, min
  altitude >= 5 cm, hidden 0.
- Then stage 2 (OPEN unless done; recheck): road vertex 56 -> <= 32 B (normal Int8x3 / 10-10-10-2, colour Uint8 norm, uv Int16/
  Float16, roadSection relative to its block) with proof the painted lines do not shimmer; one material for carriageway/footway/
  kerb via vRoadPaintSlot (roadEdges.ts:79); roads beyond ~1.5 km painted into the terrain paint texture (terrain.ts:283), no road
  geometry there (the Far Cry 4 virtual-texture approach).
- The polygon audit found junctionPiece.ts ringRun/returnSteps/squareRun in the frame (diag 14-59-21): the junction pieces derived on
  the page (MISSION item 4, road surfaces derived on the page).

## reports/vigia/study-all-scopes.md (281 lines) - the VIGIA's study of all scopes (2026-10-24)
- Roads (then): the WIP rewrite (straight 412 -> 58 tri, 16 -> 3 draws, no verge/skirts, 10 m grid, exact ramps, conformed terrain
  with Delaunator+Constrainautor, renderer.ts:1781 -> terrain.ts:2371 -> terrainLod.ts:129) was not committable; junction plate in
  fans (pieceMesh.ts:166-171), arcs at 1 cm (junctionPiece.ts:231), kerb top its own band, seamsOf locks the plate outline
  (pieceMesh.ts:110-116 + junctionPiece.ts:135-136: the far level cannot simplify, L1 -4 %), vertex 56 B (surfaceTiles.ts:28-33),
  11 draws a junction, map shrunk 18.4 -> 17.9 km. Later roads commits (8e1e9f25, 6c7361fb) did the "one form"; OPEN to recheck in
  the current code: map size >= 18.4 km, vertex 56 B, seamsOf, renderer.ts:2659 warm-up TypeError.
- Buildings, where the triangles are (25-floor tower, 142,350 tri at L0): balcony plants 52,692 (37 %: pot 14,700, foliage 21,696,
  bush 16,296), balcony furniture 27,284 (19 %), fins and edges 27,428 (19 %), non-window frame parts 16,236 (11 %), glassRail
  7,728; shell 910. Apartments 5 floors 11,020 (railing 5,040); house 2,066.
- HIGH (OPEN, the costliest defect in a real city, found by reading): layer.ts:174 builds FarPartBatch in the call that makes the kit
  (layer.ts:83); farParts.ts:64 takes levels.at(-1) then, while the meshopt levels of the 9 props arrive later (kit.ts:200,709-711)
  and are never picked up (farParts.ts:94-95,277): EVERY building beyond ~280 m draws its balcony plants and furniture at full L0,
  permanently (~80,000 of ~95,668 L1 tri for the tower). The catalogue reads levels before meshopt is ready
  (src/lab/catalog/kits.ts:41-44). Fix (B2): rebuild the far batch when the levels arrive (or make the levels before the batch);
  test that a far batch never draws a prop at L0 once its levels exist; same far image.
- B3 (OPEN): balcony plants and furniture as the plants' octahedral impostors beyond N px (plantImpostors.ts, the real picture,
  2 tri), same render up close. B4 (OPEN): non-window frame parts 44 -> <= 12 tri, glassRail 12 -> 2, fins/edges merged where
  coplanar; same image. (These are MISSION item 5, rebuild of the building parts.)
- People: L0 over 3,000 for 14 of 16 bodies, L1 over 800 for all 16; the new cooker was lost (only in the transcript); people load by
  per-file sha256 (cookedLoad.ts:8-17, cook-plugin.ts:100-110); cook-plugin.ts:196 copies untracked CREDITS.json and
  LICENSE-MakeHuman-CC0.txt (a clean clone fails to build: OPEN, recheck); citizenLocomotion.spec.ts:171 failing (feet overlap
  0.53 mm). Licence points: DECIDED not raised (the owner's order, no-licence-concerns).
- Vehicles/props/vegetation: cars 49-121 hidden tri never removed; bus and truck shells never simplify; door open-state parts have
  no levels; far blocks draw every bench/bin/hydrant at the near mesh (propCells.ts:417). b46c5894 fixed it with 12-tri boxes and
  837f1866 REVERTED it because boxes are not the same model: the right fix is the prop's octahedral impostor (V1). Signals 412 tri
  a head, 216 lenses + 72 halos: lenses/halos in the shader of one face plus a far level (V2; signals.ts:456 notes 1 M tri at a close
  view of a large city). Railing barrier 6,996 tri / 70 m: beyond N px a card with the bars in alpha. glTF ground cover (up to 3,216
  tri) offline gltf-transform simplify + 2 levels (V4). Vegetation: body + cards above 48 px, impostor below, no middle level.
- Libraries pasted by the owner: none replaces what the game does (three-roads, YUKA, graphology, SkyscraperGenerator WebGPU-only,
  etc.). DECIDED.

## reports/otimizacao/INVENTARIO.md (2,733 lines) - every model the game draws, on 837f1866 (read in chunks; notes per section)
- Lines 1-53 (header and groups): 2,499 objects, 2,129,596 tri, "every one not optimised". People cast cooked = 0 tri: the cooked
  people were stale (cooked as 62cf9d765ce349d9, code gave c20e4c2f976a25dd after 57cab9fe changed core/rng.ts): they did not
  load in the game. Later (601adfb7 / study-all-scopes) people load by per-file sha256: recheck in the current code that the cast
  loads and that a change of rng.ts cannot silently drop every person again.
- Lines 55-138 far facade (L1): residential tower large lot 157,990 tri at L1 vs 163,142 at L0 (made to measure, line 144): the far
  facade level of the towers is ~97 % of L0 (the balcony props at L0, the FarPartBatch race, and runs not merged); hidden 26,635.
  Vertices ~2x triangles everywhere (almost no shared vertices); 64-88 bytes a vertex at L1.
- Lines 140-217 made to measure / functions: 104 bytes a vertex at L0 (heavy vertex); all Uint16 index.
- Lines 219-270 roads (837f1866, before the "one form" roads): straight 2,598-5,020 tri, junction four-way 7,420-12,228 tri, L1
  saves ~50-80 %; 56 B a vertex.
- Lines 272-288 vehicles: cars 13,600-15,310 tri L0 and L1 = 36 (no middle level in the catalogue; run-time meshopt levels exist),
  hidden 49-121 a car, bus hidden 769 of 8,872, truck 202 of 2,464; index "Uint16 + none" (part of the car unindexed).
- Lines 290-304 presets; 306-315 far forest: one plate 7,300-7,400 tri (2 per tree, ~3,700 trees).
- Lines 317-323 interiors cut open: 128 bytes a vertex.
- Lines 325-590 (shell pieces, emitBay / emitLot / emitLots / emitTerrace / emitPlinth / emitRoofPlant / emitBuilding): Index
  "none" for every piece, vertices = 3 x triangles (unindexed, 36 B a vertex); emitLot of a flat lot 50 x 48 m = 266 tri (2 per 3 m
  cell on a flat lot: a flat lot needs 2), emitLots slabs 52-84 tri for flat 0.3 m slabs; emitRoofPlant flat roof plant 0.02 m
  thick = 20 tri; emitTerrace 960 tri for a 37 m terrace. OPEN: lots and flat pieces triangulated from the outline (earcut) when
  flat, not a 3 m grid; shell pieces indexed (welded) where the face shares vertices.
- Lines 591-2040 (shell pieces, cont.): hundreds of 2-tri quads (emitBay reveals and sills, flushBand storey bands 3-55 cm, emitRoof
  parapet/eave strips, emitStreak sill streaks), each unindexed (36 B a vertex, 3 vertices a triangle). Many pieces have a zero
  extent in one axis (planes) and some are 1-tri. Nothing per piece is heavy; the cost is the count and the unindexed vertices.
  OPEN: weld/index the shell (meshopt or shared corners) and merge coplanar runs (flushBand pairs are always a top quad + a face
  quad of the same band; the far level should drop bands under a pixel).
- Lines 2042-2050 editor previews: building ghost apartments 12,256 tri (full L0 for a preview); railway preview 100 m 2,700 tri.
- Lines 2052-2078 landscape glTF (elements.ts): mushrooms/2 3,216 tri, flowers/2 1,690, mushrooms/1 880, flowers/1 755, all Uint32
  index for < 65 k vertices (Uint16 would do), no levels (V4: offline simplify + 2 levels).
- Lines 2080-2088 barriers 70 m: railing 6,996 tri / 13,992 vertices (583 boxes of 12), no levels; fence 864, guardrail 648.
- Lines 2090-2133 interior furniture: 96 B a vertex; bookshelf 1,814, officeChair 820 (177 hidden), plant 462 (148 hidden),
  ceilingLamp 260 (90 hidden): drawn in cut-open interiors, ruins and the box behind panes.
- Lines 2135-2401 masses cell/tile/plate: 44 B a vertex; cell 2-244 tri, tile 2-180, plate 2-112 (light per building; the plate
  level's cost at the whole-map view is the COUNT of buildings in one 333 k-tri mesh, diag 16-33-41).
- Lines 2219-2233 water: lake stamp 40 m 4,624 tri UNINDEXED (13,872 vertices), river 160 m 864 unindexed. Terrain far patch
  2,560 tri with 256 hidden (skirts); edge slab 512 unindexed.
- Lines 2403-2437 part models: bike 240, railing 222 (L1 12), foliage 192 (125 hidden of 192!), bush 168, airer 168, table 146,
  dish 146, pot 112 (42 hidden), chair 78, lounger 66: the 9 props have NO level in the catalogue (meshopt at run time only, and
  the far batch race above).
- Lines 2439-2518 plants: low-poly trees 52 B a vertex, "none + Uint16" (part unindexed), palm 480 (83-91 hidden), oak 282;
  impostor 2 tri. Street furniture: phone 560 tri with 240 hidden (43 %), drain 108 with 56 hidden, tree pit 90 with 32 hidden,
  bin 182, bench 164, hydrant 164, lamp 132 (L1 32): only the lamp has a level.
- Lines 2501-2505 signals: a signalised junction 4 heads = 1,648 tri, 72 B a vertex, no level.
- Lines 2520-2602 base level 2-76 tri; 2604-2611 transit 140 m track 996 tri; 2613-2628 far road network straight 16 tri,
  junction 120-188 tri, Uint32 index for < 256 vertices; 2630-2645 utility pole span 642 tri (lamp beam 144, transformer 56,
  cap 40, insulator 30), only the mast has levels (24/12/6).
- Lines 2647-2711: sky dome 960; flag 576 (no level); ground cover scrub 60 tri with 18-25 hidden, rocks 36, unindexed; signs
  26-56 tri, 64 B a vertex, "Uint16 + none"; effects: rain 19,998 vertices (320 KB), exhaust 3,999 points; held props unindexed
  with hidden faces (cup 96 with 24 hidden).
- Lines 2713-2733 people cast cooked: all 16 at 0 tri (stale cook hash: no person loaded on 837f1866; see the header note).

## reports/otimizacao/MODELOS_NAO_USADOS.md (11 lines)
- public/models/elements all used; public/models/people (313 MB MakeHuman) never ships (dev tools only); rocketbox motion JSON
  (14 MB) in use; the build carries ~30 MB of source maps (vite.config.ts build.sourcemap true): a config choice, left. DECIDED.

## reports/otimizacao/predios/antes/gaps.md and depois/gaps.md (11 lines each): the same catalogue gaps text; nothing new.

## reports/otimizacao/predios/REPORT.md (67 lines) - procedural buildings research and step 1 (6a2ba7be)
- Studio method: parametric description -> kit instances + facade shader; split grammar; interior mapping; LOD by screen-space
  error with merged proxies far away. WebGL2 limits: no indirect draw/compute; BatchedMesh slows past ~100 k items (three #28776).
- Faults found then: one building emitted five times (emitChunk near/far, emitMassing x3, emitBase) - FIXED 506b4736 (one
  program); an edit rebuilt its whole 2 km plate - FIXED 759af93f (per-cell slices); every bay laid as its own wall faces - FIXED
  6a2ba7be (facade runs, -7.6 % shell); "Quantization is undone on the GPU (shellBatch.ts back to Float32; gpuBatchedMesh.ts
  32-bit indices)" - OPEN (recheck: shellBatch dequantizes to Float32, gpuBatchedMesh index always Uint32, polygon audit too);
  the kit's near models carry most triangles (railing 22 %, plants 21 %, shell 15 %, fins/slabs 13 %, chairs/tables 7 %,
  frames 6 %) - OPEN (MISSION item 5).

## reports/otimizacao/rejeitado/AUDITORIA.md (62 lines) - why the optimization rounds were rejected (and reverted)
- Reverted: 900c6ecc vehicles, f5cb7e5b roads, 35f64239 vegetation, 73a97cbb glass rail, b46c5894 street furniture far blocks.
  Reason: the "after" models were not the same model (boxes for furniture; holes and other crowns for plants; rims as two discs,
  faceted tyres, a ridge on the bus roof; road fans of needles from ARC_TOL 8 mm at every level).
- Root cause in code for roads: ARC_TOL = m(0.008) (core/scalar.ts:39) holds for every level, no caller passes opts.arcTol
  (core/offset.ts:56) - OPEN (recheck after the roads "one form"; polygon audit has "ARC_TOL 8 mm" OPEN too).
- The rule for any redo (DECIDED): accept a level only by its geometric error (two-sided Hausdorff in pixels at the distance it
  is drawn) and a silhouette comparison; far levels must be simplifications of the model itself, never substitutes.

## reports/otimizacao/rejeitado/mobilia/NOTAS.md (12 lines) - far street furniture
- propCells.ts far blocks of 4x4 cells draw every bench/bin/hydrant by the NEAR model (city 4242 district: 3,427 bins x 182,
  3,582 benches x 164, 1,212 hydrants x 164) while the near layer already swaps to a colour box under 12 px (streetFurnitureLayer
  farBox). The box fix gave -1.31 M tri but was REJECTED (a box is not the model). OPEN: the far block must use a real far level
  of the same model (the prop's octahedral impostor, the plants' system) chosen by screen size.

## reports/otimizacao/rejeitado/pecas/NOTAS.md (15 lines) - building parts
- Where the part triangles are (city 4242 district): far brise racks 1.11 M (46 k racks x 24), far lot boxes 0.96 M, columns
  0.48 M, antennas 0.38 M, plants 0.63 M, glass rails 0.30 M, chairs 0.26 M.
- Glass rail far 12 -> 4 tri applied then reverted with the round (73a97cbb). Brise as a box with slats in the shader REJECTED
  (shimmer +1 %, MSAA does not smooth discarded slats). Splitting lot posts from walls: -1.8 % tri, +10 draws: a tie, not taken.

## reports/otimizacao/rejeitado/predios/NOTAS.md (6 lines)
- Buildings already in three levels (detail to ~280 m, facade, mass); party walls removed (partyWalls.ts); 406 buildings of the
  big city: no face-to-face triangles, 24 zero-area slivers. Terrain: the far ground draws its drawRange only; the inventory's
  327,680 is the capacity. DECIDED: nothing to change there.

## reports/otimizacao/rejeitado/REGISTRO.md (173 lines) - the register of the rejected (reverted) model rounds
- Vehicles (reverted 900c6ecc, faults per AUDITORIA): body by curvature stations not a 145x46 grid; round parts 6-10 sides; unseen
  faces not made; quantized vertices (normal Int8, colour Uint8: 36 -> 18 B, KHR_mesh_quantization); tyre 256 -> 60, rim 148 ->
  40; total 98,970 -> 18,856 tri. Found on the way (OPEN, recheck: may have gone with the revert): vehicleLevels.ts SHED bug (a
  dropped level kept being pointed at, a level carried unused); tyre/rim without normals (faceted), 11 -> 9 programs; bus seat
  boxes inside the passengers' thighs (interiorSolids.spec).
- Roads (reverted f5cb7e5b): adaptive refinement instead of the 3.2 m grid, 1 cm tolerance checked at mid AND quarter points,
  skirts only where there is a drop, frame-exact texture copies; big city road layers 5.84 M -> 3.12 M tri. Found on the way:
  the old refinement did not keep its tolerance; the quarter-read cache compared edges with swapped ends (13 k tri where 900
  do); road workers read the terrain point by point and restarted a tile per missing point (4-12 passes a tile): fixed by a 4 m
  grid read first (small city 12.8 s -> 4.4 s). Superseded by the roads "one form" (8e1e9f25/6c7361fb); recheck that the road
  workers do not again read terrain point by point.
- Vegetation (reverted 35f64239): quantized vertices (half positions, Int8 normals, Uint8 colours, Uint16 uv, Int16 card corners:
  oak 30,616 -> 10,952 B, same coverage within 0.02 %); hidden roots/coconuts removed (palm 480 -> 388); cards trimmed to the
  atlas reach; a MEDIUM level (48-128 px) from the near model with a measured card scale per species (oak 282 -> 116); painted-woods
  trees given the far picture and the medium level (before: full model at every distance). The AUDITORIA rejected the medium
  levels for changing the crown (lost lobes, bushFlowering lost its pink flowers). OPEN: the 48-128 px band still draws the full
  near model; a medium level must be accepted by silhouette/Hausdorff, not by eye.
- Street furniture far blocks (reverted b46c5894): see above (boxes rejected; the impostor is the right far level).
- Building parts: glass rail far 12 -> 4 (reverted 73a97cbb with the round; it lost the edge band); brise in shader rejected
  (shimmer); lot posts split: a tie.

## reports/otimizacao/rejeitado/vegetacao/NOTAS.md (20), veiculos/NOTAS.md (18), vias/NOTAS.md (18)
- The same text as the matching sections of REGISTRO.md (read above). Nothing new.

## reports/otimizacao/vias/ARQUITETURA.md (39 lines) - the road architecture decided
- DECIDED (research): a segment is a strip along its centreline, a junction a separate plate whose edges meet the segments at the
  mouths (vertices bit for bit twice); plates triangulated alone (earcut + refine / CDT), never fans; markings in the surface
  shader (analytic along roads; a per-tile cell lattice at junctions after Nehab & Hoppe 2008, MSDF glyphs for arrows/words);
  thin triangles cost 10-20x per pixel under ~8x8 px. Layers: (1) plates apart, (2) markings along roads in the shader (done,
  85f4e048), (3) junction markings in the shader (stop lines, crosswalks, arrows, legends, islands, tapers, parking lines: OPEN),
  (4) strips by sagitta.

## reports/otimizacao/vias/summary.md (57 lines) - a road sheet of an intermediate step
- Straight 140 m roads 2,598-5,020 -> 342-474 tri; junctions -58 to -78 %; bridges/tunnels/raised unchanged (+-1 %); surface moved
  up to 209 mm on local bends/junctions (a visible move, at the time); 56 B a vertex everywhere (still OPEN, stage 2 of roads).
