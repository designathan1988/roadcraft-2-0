# THE MISSION (the owner, 2026-10-28): printed whole at every session start and compaction by `.claude/hooks/mission.cjs`

Make Roadcraft create, open, save, edit and PLAY a real 10 km city fast on a mid-range PC (it ships on Steam, any GPU), with the
graphics quality and every feature it has today. Work through the items below IN ORDER, ONE AT A TIME, to the end. Progress goes in
`docs/agent/work.md` (what was read, found with file:line, changed, the commit, what is next). Never stop to ask; decide.
Written from all 249 documents read whole (`docs/agent/reading.md`); every problem, its source and the decided solution are in
`docs/agent/findings.md`; what was already re-checked in the current code is in `docs/agent/open-checked.md`. The reports' line
numbers are of older builds: the FIRST step of every item is to re-find each cause in the current code (file:line) and to drop, with
the proof, any that is already fixed.

## Rules (the owner's, all standing)
- Find every cause BY READING THE CODE (follow calls, data, config). No measuring, benches, probes, stall runs, F7 runs to find causes.
- Verify each item with `npm run typecheck`, eslint (no new error), and the spec of that point only. A new spec must fail with the
  fix undone. Never weaken, delete or hard-code a test. No `any`, no swallowed error, no "just in case" fallback.
- No subagents. Commit each verified item (the main session commits directly), then publish to roadcraft-2-0 by
  `docs/agent/memory/push-roadcraft-2-0.md`. Show the hash in the chat.
- Research the official docs (three r186, WebGL, ANGLE, meshoptimizer) before changing an API use; cite the link.
- The game is opened ONCE, at the very end, for photos (see "End"). Never during the work.
- Nothing fake: no box for a building or a prop, no plane for a road, no cooked city, no stand-in shown by load state, no shader colour
  compensation, no "bake" for buildings (made at run time and edited by the player: `.claude/memoria/buildings-runtime-never-bake.md`).
- An optimization changes nothing visible and removes nothing, except where an item orders it. A coarser level is accepted only by its
  geometric error in pixels at the distance it is drawn (two-sided Hausdorff) and its silhouette, and is a simplification of the model
  itself, never a substitute (`reports/otimizacao/rejeitado/AUDITORIA.md`: the reverted rounds).
- Everything in the project in English; the chat in Brazilian Portuguese.
- DO NOT redo what was reverted on 2026-10-28 (it broke the game): no upload queue with a byte cap a frame, no frozen scene
  (`matrixAutoUpdate` off for everything), no code-graph scoreboard. DO NOT redo the GPU-driven plan's steps 2, 3, 4, 6 (proven not
  possible or of no effect on three r186 + WebGL: `history.md`). DO NOT redo the rejected model rounds as they were (boxes for street
  props, plant medium levels that change the crown, faceted tyres, needle fans on roads).

## Already done (do not redo)
One view walk for the ten instance layers (acc7debf); part levels chosen again only when a bar can be crossed (bd376121); far wall cover
keeps the wall's material (f25d3285, not yet seen in the game); roads in one form (8e1e9f25, 6c7361fb); cars by their own screen size;
far levels in the facade level's format (878d21d5 on); one building program for every level and per-cell slices (506b4736, 759af93f);
people's LOD ladder (601adfb7); road lines along roads in the asphalt shader (85f4e048); far street props by their own ladder and
picture (propCells.ts, propLevels.ts); FarPartBatch reads the simplified levels once ready (farParts.ts:134-150); road and car-line
tables sent by ranges (roadPaint.ts sendTexels, densityCars.ts:407); release build without shader error queries (renderer.ts:519).

## Items, in order
1. **Camera drag: the causes found with real gestures on 2026-10-27 (`lab-reports/move-*.md`), fixed at their source.**
   a. Programs compiled in the middle of a move (3-34 a move; building-lamp, shell-batch-facade depth, shell-batch-detail, parts' depth,
      density-cars, skinned crowd BONES/PLAYS): every program a view can need built before its first draw (three `compileAsync`,
      KHR_parallel_shader_compile, shaderCatalogue.ts); no material `needsUpdate` on a live mesh in a move (cellInstances.ts:216
      posedMaterial recompiled during the drag); no onBeforeCompile without its own customProgramCacheKey (signals.ts:151 frame and
      :194 lenses have none; :176 frameDepth has one).
   b. People's palettes rendered every frame for every batch with people, drawn or not (renderer.ts:4112, riggedCitizens.ts:1092-1098,
      crowdAnimation.ts:279): render a batch's palette only when that batch is drawn this frame.
   c. Every render target reallocated when the canvas flips 1079/1080 px (screenSize.ts:17-33 refits on any change): find why the size
      flips (main.ts resize, CSS, devicePixelRatio rounding) and size from a value that does not.
   d. BatchedMesh indirect texture re-sent at every render of every camera (three r186 BatchedMesh.onBeforeRender sets needsUpdate each
      call; GpuBatchedMesh.onBeforeRender, gpuBatchedMesh.ts:87-100; ~400 a second with the view still): one draw list per camera,
      sent only when it changed. Also the GpuBatchedMesh arena growth (bufferData up to 13 MB, copyBufferSubData on compaction,
      gpuBatchedMesh.ts:84/227/295) sized so a moving camera does not regrow it, and BatchedMesh perObjectFrustumCulled off where the
      cells already cull (three getBoundingSphereAt 148 ms in a still view).
   e. Vertex formats ANGLE converts on the CPU: half x3 instance colours (partCells.ts:145, farParts.ts:124/425, buildingMesh.ts:4955,
      and every other x3 16-bit attribute: SHORT x3 rigged citizens @1, USHORT x3 massing base, UBYTE x3 terrain-ground/-rim): stored as
      4-component formats D3D11 takes natively (https://github.com/Microsoft/angle/wiki/Getting-Good-Performance-From-ANGLE).
   f. Page work on the frame path, each made proportional to what changed (or moved off the page) with its result unchanged:
      viewCells.make on cold cells, lookProps/ringsIn, casterChanges (renderer.ts:748, a Box3 a caster, every frame), syncBases
      (massCells.ts:767, every base's cells), poleCells.look and the pole stores' per-frame view/sort/upload (poleStores.ts:130/365/394/
      676, ScreenScale.atPoint 55 k calls a frame), cellKeeps sorting its queue each frame (cellKeeps.ts:160), cellInstances visit
      recursion, the lot overlay querying lots each frame (lotTool.ts:680/727/799), camera solids measuring floors on the page
      (cameraSolids.ts:203/246, foundation floorHeight, floors.work), bay layouts in the frame (buildings geometry workOutLayout/
      groundBays), the network rebuilt in the frame (hitch network/rebuild), road elevation in warmRoadShaders, the scene walked three
      times a frame (renderer.ts updateMatrixWorld, uploads drainCompiles traverse, optimizationsApply beforeRender traverse,
      depthFirst traverseVisible), the copy of rows sent to the job processes.
2. **Nothing made, sent, recomputed or counted every frame for nothing** (the owner: "coisas que replicam, criam, atualizam
   constantemente sem necessidade"). Each one: send/compute only on a real change; the same content never re-sent:
   a. Buffers re-sent with the SAME content every frame (needsUpdate without a change): far car / wheel / hub / bicycle / motorcycle /
      lamps / shadows parts (agents.ts:1194/1202), citizen @1/@card rows (riggedCitizens.ts:1066/1076), far signal lenses and halos
      (signals.ts:383/386/391), citizenPlays DataTexture (citizenPlays.ts:32/83), wear field (wear.ts:130).
   b. Geometry or buffers MADE again while the view is still: mass cells (massCells.ts:262-271, 3.5 a second, 3-4 MB each: find why a
      still view remakes them), density-car tile geometry (densityCars.ts:273-286, 51 a second), utility wire geometry
      (utilities.ts:435-443, a new InstancedBufferGeometry per reserve), far forest (farForest.ts:245-249), cell instances
      (cellInstances.ts:248-254/1024-1025, instancePoseA/B), road LOD geometry (mesh/roadLod.ts:10-17), terrain seams and their textures
      (terrain.ts:1373/1689-1700), far block batches (mesh/farBlockBatches.ts:129), part cell meshes and casters made in the cull
      (partCells.ts:225/366-381 makeCaster, :553 posedCopy per level), prop batches made on the page (propCells.ts:376/449-453/488), agents.growPart (agents.ts:1045/1160:
      free the old buffers).
   c. Writes per item where one per frame does: densityCars writeLine sets needsUpdate once a road line (densityCars.ts:408, ~9,300 a
      second): collect the frame's lines and mark once; pole stores' addUpdateRange+needsUpdate in a loop (poleStores.ts:415/708).
   d. Matrices of objects that never move recomputed every frame: 41 (blast 9, room-light 6, gore 4, casualties 3, Object3D 3;
      blast.ts:683/703/720 rewrite every debris/crater matrix while any moves).
   e. Recomputed with the view still: sun cascade bounds and matrices (sunCascades.ts:75/299), flatAtlas/terrain paint updates
      (flatAtlas.ts:928/940, terrain.ts:2271/2476), plantCells.sync, natureStands (renderer.ts:3001), terrain ecologyRevision getter
      (terrain.ts:2433), layerCells covers/unpackCover (layerCells.ts:183/216/343), world/cells.ts:157 someAt, store.ts:180 nearIds,
      openLots rebuild (openLots.ts:242), the simulation sent every frame (simClient.ts:412), the job pool answering while nothing
      changes (jobPool.ts:174, 60-209 messages a second), changeBoxes (changeBoxes.ts:31).
   f. Counters run in the frame: memoryCounters (memoryCounters.ts:35/86/100), partCells/streetFurniture `get triangles`
      (partCells.ts:377, streetFurnitureLayer.ts:575), targetBytes liveTargets (targetBytes.ts:49), healthPanel interval, perfBudget
      stepBudget; counted when shown (the lab/panel), not each frame.
   g. Held twice: terrain-ground/-rim geometries x50-62, bus body-lite x3, truck bodies, five identical car wheels per rung, sedan/wagon
      trim, glass/glassDark, bus doors x4, bus/truck wheel, kit unit boxes (shutter/lamp/louvre, concrete/water/fin), lotBox and its
      caster, blast-debris = gore-cuffs: one shared geometry each.
3. **ONE FORM PER VIEW, FOR EVERYTHING** (the owner's order above every other, `history.md` 9-27): what a thing looks like depends on
   the view alone (its size on the screen), never on what has loaded nor on a frame or memory budget.
   a. Buildings: `layer.ts` 303-318 `capTriangles` / held cells, `keepToBudget`, `pendingCells` "shown as they land", frameBudget error
      scale: the level by screen error alone; the levels the view will need made and kept ahead so nothing swaps when it lands. The
      massing plate is ONE 333 k-triangle mesh drawn at every zoom (12 triangles a pixel at the whole map, 49 draws a frame): its level
      chosen by screen error too (triangles <= 3 x screen pixels at the whole-city view).
   b. Then, inventory first, one category at a time: trees (full trees and 240-tri palm cards drawn at 0.1-0.3 px: a far rung or the far
      forest past a pixel), street furniture and props (the far ladders' band tested in the vertex shader, farLadders.ts:37-49: 1.78 M
      triangles shaded and dropped; sort each block's instances by rung on the CPU when the view crosses a bar), people, poles and wires,
      the stand-in of a road just built (`roadStandIn.ts`, `roadProgramStandIns.ts`), terrain (far tiles of 512-12,672 tri over
      0.4-9 px: a level by size), water.
4. **Clouds and fog out of the game** (the owner's order; clouds 13-19 ms of GPU at the whole-city view): `fogLayer.ts`,
   `cloudShadowStamp.ts` and every user (~37 files); old saves still open.
5. **Whole-map work left** (nothing proportional to the map on the page): the base level built for the whole map at the opening (as
   heavy as the plate since fe0b4e42); the simulation sent the whole map (`simClient.ts` -> `trafficMapOf`); the road surfaces and
   junction pieces derived on the page (inventory S1: SurfaceInputs.deriveCell, junctionPiece ringRun/returnSteps, 459 records decoded
   a frame); sign, pole and prop cells derived on the page; renderer plantAll (doc.trees), PlacedProduct/BarrierProduct allKeys,
   SurfaceInputs.rebuildAll, TileIndex.fileAll, economy priceAll, ragdoll solids for the whole map (world/solids.ts), RoadTop.heightIn
   over the whole city (main.ts surfaceTop), signLayer plates for the whole map (41.6 MB on the 70 k city); the save and undo copying
   the whole document (main.ts serializedDoc, history.ts whole snapshot): by tile/record and by patch.
6. **People** (the owner: "a parte das pessoas"): people loaded, assembled and their clips BAKED on the page inside the frame when a
   person first shows (riggedCitizens.ts:497 load, cookedPerson.ts:233 assemblePerson, citizenWalk.ts transferOnto, riderPoses.ts apply,
   personImpostor.ts:89 a new material + InstancedMesh per person = a program): done off the frame (worker / before reveal);
   riggedCitizens citizenRow buffer of 1000 floats per level mesh and the morph texture allocated for CAPACITY when a face is set
   (riggedCitizens.ts:189-193/647): sized by use; the cooked cast must always load (a change of `core/rng.ts` once dropped every person:
   cookedLoad.ts by file hash, prove a stale cook cannot silently empty the city); people L0 over 3,000 and L1 over 800 triangles for
   most bodies (the procedural crowd of the old audit, proceduralCrowd.ts / gpuRows.ts, was deleted in 77117ea0: not an item).
7. **Rebuild the heavy models and the textures painted at run time** (the owner: "REFAÇA SIM TODOS OS MODELOS E TEXTURAS"), same look,
   proven by `scripts/optimization-sheet.mjs` before/after (the headless lab page, not the game), by the rule above:
   - the seven textures painted at the opening (blast, signature, casualties, elements, lowPolyTrees, signs, utilities: the
     `roadcraft/no-live-interface` entries of `scripts/baselines/eslint-suppressions.json`, a list that may only shrink);
   - cars (L0 12-15 k triangles, 36 B a vertex, 49-121 hidden triangles, shell ladder 8 k -> 36 with nothing between; bus/truck shells
     never simplified; open-door parts without levels); wheels and hubs under a pixel;
   - building parts (railing 222, plants 112-192 with up to 125 hidden, chairs/tables, frames 56, brise 60, glassRail; 2.65 M triangles
     at a street view; the far facade L1 of a tower ~97 % of its L0); shells and lots unindexed (3 vertices a triangle), flat lots on a
     3 m grid (266 tri for a flat 50 x 48 m lot), 104 B a vertex at L0, quantization undone on the GPU (shellBatch.ts:256 worldGeometry
     back to Float32);
   - street props with hidden faces (phone 560 tri with 240 hidden, drain, tree pit), signals (412-532 tri a head, lenses/halos as
     closed cylinders), the railing barrier (6,996 tri / 70 m), sign posts and piers as closed cylinders, insulators 40 tri, flags 576
     tri, the sky dome 960 tri (a fullscreen triangle), landscape glTF (mushrooms 3,216, flowers 1,690; Uint32 indices), water and
     terrain patches unindexed, Uint32 indices where Uint16 fits, ARC_TOL 8 mm at every level (core/scalar.ts:39, core/ring.ts:108),
     mini-roundabout disc ~1,440 tri, parking lines a point a metre, the lawn polygon under every lot, the junction markings still
     polygons (stop lines, crosswalks, arrows, legends, islands, tapers, parking lines: in the asphalt shader as the lines are), the road
     vertex 56 B (<= 32 B).
8. **The far look**: every coarser level reads the same look as L0 per pixel (CIEDE2000 <= 2 against L0 at the same distance; today
   117 of 125 cases over 2, worst 7.97; the far wall 107,101,89 vs 119,105,88; glass at L1 3.7-6.2): from the real materials and lights
   (an apparent-reflectance table per material slot rendered from the real bay geometry), never a colour fixed by hand. The far night
   beige (`BACKLOG.md` 1) belongs here.
9. **Left from before:** far two-wheelers drawn with their riders; the street-level pedestrian camera (the owner asked); pitched roofs at
   the base level; the failing specs `cellAffinity` and `buildingsVisibleSame`; the swallowed errors in the lint baseline
   (`roadcraft/no-silent-catch` x79); the quality settings no system reads (grassBlades, vegetationDistance, birds, waterfalls:
   render/quality.ts only): wired to their systems; dead code by knip.

## End (once, after item 9)
Open the game once (window in front), photos of the same views on this code and on 7c4de70f (a worktree): centre close, centre far,
a district at street level, during and after a camera drag, at night. Look at each one; fix in the code anything that differs where it
must not, and take that photo again. Then the final commit and publish. Report in Portuguese: what was done (hashes), what was not and
why (with the proof in the code), what was not verified.
