# Work state (injected at every session start and compaction; keep it current at every milestone)

Entry point and method of work: `docs/agent/README.md`. Rules: `docs/agent/memory/`. Branch: `otimizacao-geometria`.

## THE OWNER'S ORDER OF 2026-10-27 (evening), above every other: ONE FORM PER VIEW, FOR EVERYTHING
- At the same zoom and view a thing is drawn in ONE form. What a thing looks like depends on the view alone (its size on the screen),
  never on what has loaded. "PRA QUE MOSTRAR DE TRES FORMAS NO MESMO NIVEL DE ZOOM E VISTA? ... ISSO VALE PARA TUDO."
- Roads today: three forms at once (the network's root level `networkFarRoads.ts`: own coarse shapes, no kerb nor median, own material;
  a block's far level `attachFarLevel`; the block's full level), which one by load state. Fix in progress: the root level made of the
  SAME pieces (`roads/pieceMesh.ts` pieceBundle over `segmentShapes`/`junctionShapes`), the same vertex attributes (uv, colour, section,
  code) and the SAME material (`materials.road`) as the detail, so loaded or not the road is one.
- ROADS DONE (2026-10-27): the root level is the tool's L2 of the same pieces (`segmentFarShapes`/`junctionFarShapes` and the median's
  `medianShapes`) meshed AS THE DETAIL'S SURFACES by `pieceBundle` (`render/networkFarPieces.ts` farPieceCells), every vertex the detail's
  attributes, drawn by `materials.roadRoot` (the road material's own shader). The old coarse builder, its worker and its own material are gone.
  Photos: reports/in-game/2026-10-27-one-road/03 (near, 3 s: median, lanes, crossings, texture), 04 (far).
- NEXT (same order, one category at a time, inventory first): buildings (their load-state stand-ins: base prisms -> plate -> tile -> mass ->
  facade -> cell detail, shown by what has landed, not by screen size), trees (near trees / far forest cards), street furniture and props
  (impostor ladder 48/16/1.5 px; cells not built show nothing), people (impostors), poles and wires (blocks not built show nothing), the road
  stand-in of a road just built (`roadStandIn.ts`), terrain levels.
- Then every other category the same way (inventory first: buildings' LOD ladder, cars, trees, props/furniture, people, poles/wires,
  terrain, water): find every stand-in shown by load state and make the form a function of the view alone.
- Done and committed this evening: 3c172ebd (squares' walks paved), e08a35a3 (far roads' crossings), 8e1e9f25 (car level by its own
  screen size; poles turned by the document's nearest road). Uncommitted: the far level's asphalt grain (roadEdges/materials/
  networkFarRoads/renderer) - to be replaced by the single-form root.

## BUILDINGS' LOD: DIAGNOSIS AND PLAN (2026-10-27, the owner's order: the far levels must be the originals, no placeholder, one form per view)
- Today six forms, only one of them the original: L0 detail (the building itself); L1 facade level (`facadeLevel.ts`: walls re-emitted as runs of
  bays drawn by a shader); the cell's masses (`massing.ts`: blocks with shader windows, FAR_ERROR 1.5 m); the 1 km tile and the 2 km plate
  (`massLevels.ts`, the plate's roofs flattened to boxes, PLATE_DETAIL); the base prisms (`massBase.ts`) drawn under every cell nothing finer
  has landed. Which one shows also depends on load state (the base under cells not landed, a tile held while its cells land) and on the frame
  and memory budgets (`frameBudget.ts` error scale, `massCells.ts` cap stepping fine -> facade -> masses): not on the view alone.
- NO BAKING (the owner, 2026-10-27: the buildings are made by the city as it grows). The way for procedurally generated buildings: the far
  level evaluates THE SAME FACADE GRAMMAR the detail is generated from, per pixel in the shader, over the building's real masses: F-shade,
  Haegler, Wonka, Mueller Arisona, Van Gool, Mueller, "Grammar-based Encoding of Facades", EGSR 2010 (https://diglib.eg.org/items/c323b1b7-2ba8-4be3-8575-c0808924e2bf,
  https://onlinelibrary.wiley.com/doi/10.1111/j.1467-8659.2010.01745.x): "evaluating procedural descriptions at render time uses less memory than
  the generation of intermediate geometry"; and the levels made by the grammar itself, its terminals swapped for lighter ones (Mueller, Wonka,
  Haegler, Ulmer, Van Gool, "Procedural Modeling of Buildings", SIGGRAPH 2006, https://www.researchgate.net/publication/220183823_Procedural_Modeling_of_Buildings).
- So: ONE facade encoding for every level past the detail (the facade level's, `facadeLevel.ts`: the detail's own bays, its pane per bay as
  `emitBay` picks it, its frames' colour, its doors, shutters and streaks), carried by every mass vertex of the cell, the tile, the plate and the
  base; every level's geometry the building's own blocks and roofs (no box, no flattened roof); one shader for all of them; the level picked by
  screen error alone; the shader masses' cruder grid (`massingMaterial.ts`), the boxes and the prisms' own paint removed.
- Code facts found (2026-10-27): the facade level L1 already is that encoding: `buildingMesh.ts` emitFacadeRuns lays a face's like bays as one
  quad a run (a storey of like bays, like storeys over the base), each vertex carrying the run's kind (`facadeKind`: which pane `emitBay`
  puts), its opening in the bay (a0, a1, h0, h1), its frames' colour, its streak and office flag, drawn by `facadeLevel.ts`. The masses
  (`program.ts` MassRecorder, `massing.ts`) carry only a storey/bay/glass-share/sill-head grid (`BaseGrid`, `massingMaterial.ts`): another,
  cruder grammar. Steps: (1) the mass stage written from the same runs (`emitFacadeRuns` into the far sink and the mass recorder alike), its
  walls the runs' quads with the runs' encoding; (2) the masses, tiles, plates and base drawn by the facade level's shader; (3) the levels picked
  by screen error alone (no budget swap, no base under unloaded cells); (4) `massingMaterial.ts` and `BaseGrid` removed.
- THE CONCRETE DESIGN (decided 2026-10-27): every level past the detail written in THE FACADE LEVEL'S OWN VERTEX FORMAT and drawn by ITS OWN
  MATERIAL: the shells' (`cellArrays.ts` ShellArrays: position on the cell's grid, octahedral normal, paint = rgb + finish id + wear, so the
  finishes' textures `finishes.ts`), and for walls the runs' (`facade` bay width and storey height, `grid` u, v, kind + flip, volume * 4 +
  side, `opening` a0, a1, h0, h1, trim rgb, office), drawn by `facadeLevel.ts` exactly as the L1 cell draws them. The mass stage records, per
  bay, what `emitFacadeRuns` reads (`recordBlock`: the bay's component kind `facadeKind`, its opening `openingOf`, its streak `streakOf`, its
  wall's finish and paint, its trim colour, its bay index and level), so `massing.ts` writes the same runs the facade level lays, per level
  with its reliefs under the level's error laid flat; its other faces (roofs, parapets, lots) with their finish id. The tile, the plate and the
  base are the same writer over their buildings. Then `massingMaterial.ts`, `BaseGrid`, the base prisms' own format and the plate's boxes go.
- DONE (steps a-d, committed): the cell masses, the 1 km tile and the 2 km plate are written in the facade level's own format and drawn by
  its own materials. `program.ts`: MassLook (rgb + finish index) in every face (FACE_FLOATS 13) and bay (BAY_FLOATS 21: the facade level's
  kind, opening, paint, bay index, level, joined bays, volume, grime foot), no palette of its own (a tile's job held 400 programs' objects:
  `cellJobMemory.spec.ts`). `buildingMesh.ts` MassShellWriter / writeMassShell: one far Shell fed the program's faces and its bays as the
  facade level's runs (stamps, u/v, storeys stacked as `emitFacadeRuns`), reliefs under the level's error laid flat. `cellArrays.ts` CellMass
  (position on the grid, octahedral normal, paint, facadeSize/facadeCell/facadeOpening+facadeTrim interleaved; shells' triangles then runs'),
  `MassAppender` writing each building straight into its cell's arrays, `concatMass` (associative: slices joined = level made whole, byte for
  byte, `cellSlices.spec.ts`). `massCells.ts` cellMesh: two groups drawn by [kit.shellMaterial, kit.facade]. `massing.ts` MassWriter and its
  window grid removed. gpuOnly/gpuLedger handle interleaved buffers (one upload, counted once).
- DONE (step e, committed): the base is the plate's own level laid cell by cell: the 'massBase' job runs the same writer at `PLATE_DETAIL`
  (`cellWork.ts`, each building into its cell's `MassAppender`), `massBase.ts` joinBase joins the cells (`concatMass`, the plate's very bytes,
  `massBase.spec.ts`) and keeps each cell's shells' and runs' index runs (`BASE_CELL_STRIDE` 6); `massCells.ts` draws it with `cellMesh` (the
  shells' and the facade's materials), `syncBases` leaving out the cells a finer level draws in both groups. Gone: the prisms, the base's paint
  and grid (`BaseGrid`, `recordBase`, `prisms`/`slabs`/`grids` in the program), `massingMaterial.ts` (its pulse and room look kept in
  `facadePulse.ts` for the facade level), `kit.massing`, `kit.massingBase`. Cost: the base now weighs what the plate weighs (it never lets go).
- DONE (step f, committed): the plate has no job nor mesh of its own: its base is it. `massCells.ts` keeps the plate as a level of the choice
  (Cesium's replacement from the top), `standsFor` reading its base's mesh, `landBase` giving the plate its error, top and box; a plate drawn
  whole is its base drawing all its cells (`drawnBy` null under it, `syncBases`), never let go for the budget. `massLevels.ts` plans plates,
  never asks them ('massPlate' gone from `JobKind`, `cellPool.ts`, `cellWork.ts`), a plate's `outdated` its base's. One copy of L3 on the GPU.
- KEPT, DECIDED: the frame's error scale (`frameBudget.ts`) and the detail's byte cap (`massCells.ts` cap) still move the screen error a level
  is picked by under load. Every level now is the same form (the facade level's format, materials, paints and runs; a coarser one only leaves
  out what spans under its pixels), so the budget moves no placeholder in; taking it out unmeasured risks the frame on a mid PC.
- MEASURED 2026-10-27 (far sheet, reports/far-sheet/2026-10-27-now, same tower every level): the masonry tower's wall at 2000 m is
  L0 119,105,88 / L1 125,112,99 / masses, tile, plate, base 94,91,82; roof L0 87 / masses 64. The masses' paints, openings and run kinds
  equal the L1's (checked vertex means). What the masses lack is the facade's ELEMENTS: balconies, floor slabs, stone bands and pilasters,
  sills (L1: 180 stone shell vertices plus the instanced parts; masses: 12). From afar they lighten and warm the wall; without them the tower
  is darker, greyer and plain: the owner's "LOD different from the original". FIX TO DO: the mass stage records each element run per storey
  (kind, depth, height band, paint), and the far levels draw them: the deep ones (balconies, slabs over the error) as their own boxes, the
  rest as bands in the facade shader's grammar (F-shade terminals), so a level from afar keeps the original's covers and colours.
  Also slower: the base now weighs what the plate does and is made for the whole map at the opening.
- THE FIX BEING WRITTEN (2026-10-27, F-shade's far terminal: the masses are drawn past DETAIL_REACH 1.4 km, where a 1 m element is under a
  pixel, so what reaches the screen is the elements' cover and colour over the wall): `massWalk` lays no bay, so (1) a `CoverProbe`
  (`buildingMesh.ts`): a LevelShell that lays nothing and sums, for one bay run through the real `emitBay`, the frontal area and colour of every
  face standing out of the wall (not the wall's own paint) and of every part `Emitter.put` lays (not SHADER_DRAWN: glass, frame, door,
  shutter, which the facade shader draws), memoised by the bay's key (component, size, paints, neighbours, geometry); (2) `recordBlock` asks it
  for every bay and records the cover (share, rgb) in the bay (BAY_FLOATS + 4, joined only when alike); (3) the run's vertices carry it
  (`facadeCover`, Uint8 x4: rgb, share; 0 on the detail's and the L1's runs, whose elements are real); (4) `facadeLevel.ts` mixes the wall
  toward the cover colour by its share as the bay falls under the pixels (`facadeSub`), as it does the windows. Then the far sheet again.
- DONE 2026-10-27 (f6e59aa2, d067bf3c, 218f27bd): the facade's elements in the far levels (CoverShell over each bay's own emitBay, each
  side's mean on the runs' `facadeCover`, roofs measured from above), the masses' shells by the original's shell material (the far program drew
  roofs 30 % darker), the levels chosen once a frame by the view (no error scale fitted by load: 2-6 whole choices a frame of a drag gone),
  the covers kept once a kind of bay per worker (opening 150 s -> 92 s; 84 s before the covers). Far sheet (2000 m, masonry): wall 107,101,89
  and roof 91,87,80 against the detail's 119,105,88 and 87,84,78 (were 94,91,82 and 65). Photo: reports/in-game/2026-10-27-one-building/12-city-far.png.
  Camera drag measured in the game window (in front, 2026-10-27): 8 s of drags 1355 frames, p50 16.7 ms, p95 33.3, max 33.4 (still: the
  same); photo reports/in-game/2026-10-27-one-building/13-after-drag.png. Opening 92 s, then 77.8 s once a flat roof's cover is not walked
  (1a5b0dfd; 84 s before the covers). Tried and reverted: counting the frames proud of the wall as cover (the L1's rule) took the wall to
  105,99,87, further from the detail. Left: the masonry wall at 2000 m 107,101,89 against the detail's 119,105,88 (the L1 itself 125,112,99).
- TRIED AND REVERTED 2026-10-27 (measured worse on the far sheet): the slabs' tops as cover seen by the view (142 at 2000 m); an aggregate
  direct light in the facade shader (RE_Direct_Facade: the wall less the slabs' shadow, the fronts lit as the wall, the tops lit from above,
  with the stacked slabs' mutual hiding for eye and sun, t*tv, tv/tl, t*(tl-tv)) - 140 at 2000 m against the detail's 119. What it lacks to
  be right, and what to do next: the sky the slab over hides (the ambient between the slabs), and the finish's far tone on the faces the
  CoverShell sums (it takes their raw paint). Do those two before trying the tops again.
- NEXT: (g) one game pass with photos (near, district, far, the whole map) of the buildings at every zoom; then push.
- FOUND, NOT OURS: `tests/render/buildingsVisibleSame.spec.ts` "lays every shell triangle where HEAD laid it" fails on house/cut0 (12
  triangles not in its baseline); it fails the same at c97ff615, before this session, and passes at a6c86e62.
- FOUND, NOT OURS: `tests/render/cellAffinity.spec.ts` "runs a square's masses at every level on one worker" fails (both tiles go to the
  second worker); it fails the same at a6c86e62, before this work.

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

## CAMERA SLOWNESS: measured in the open game with real gestures (2026-10-27, 10 km city, RTX 3060, 2560x1080)
- After a wheel zoom: one 600 ms frame, then ~3 s of 100-220 ms frames (frame intervals recorded by rAF).
- The page's main thread is 82% idle meanwhile (CPU profile): NOT a CPU problem. GPU frame time p95 78-190 ms, max 166-1165 ms.
- Ruled out by switching off one at a time: shadows (and their updates), the post passes, buildings, terrain, roads. All layers
  and passes off: max 16 ms. VRAM is not full (3 of 12 GB): no paging.
- Per draw GPU timing (scratchpad drawtimer.js): the stall lands on one random draw each slow frame (clouds quad 964 ms, canyon light
  442, wires 405, output 257, a bench 147) with 0 ms of CPU in it: the GPU queue is behind, not that object.
- The GPU is saturated: the sum of every draw is ~29 ms a frame (p50) and Electron holds 57% of the 3D engine even with the camera still.
  The single largest piece: the clouds (bodies quad 8-15 ms every frame, a third of the frame) - the owner ordered them removed, with the
  fog (2026-10-27). Then: the scene pass ~15 ms, the people's animation palettes (crowdAnimation.ts:276, ~950 renders a second, ~2 ms a
  frame), GTAO ~2.5 ms, canyon light ~1 ms.
- F7 did not catch any of this (it averages by pass and layer, no per-draw GPU time, no CPU/GPU split, no work outside the frame):
  to be built into it (BACKLOG).
- IN PROGRESS: removing clouds and fog from the whole game (render passes, the landscape tools, the document, the saves read back).

## Root causes found by reading code
1. Buildings look like boxes before loading: `src/render/buildings/massBase.ts` (the top level, drawn wherever nothing finer stands) is
   plain prisms with one 5-6-5 paint per vertex, pitched roofs flattened at half their rise; `massingMaterial.ts` base branch has no
   facade attributes, so no windows and no night lights (a black box at night).
2. Detail late on approach: `src/render/buildings/cellPool.ts` `KEPT_KINDS` leaves out 'cell' (the detail), so it is rebuilt by a worker
   at every approach and every launch; old kept keys of a cell are never forgotten when replaced (the store only grows).
3. Roads: `src/render/mesh/roadResidency.ts` builds detailed blocks only for cells the view wants, `BRING_PER_LOOK = 3` a look; the root
   far level (`networkFarRoads.ts`, a 1 km tile a job, painted by `applyRoadFarPaint`) stands meanwhile.
   THE BOTTLENECK (read 2026-10-27): `renderer.ts` cellStep took, past the detail's reach, 2 cells a step (`STEP_CELLS`), and a step is a
   whole world build, the next only once it is done (`worldJob === null`): a district's dozens of cells came two a build. Fixed: the near
   cells first (+2), then up to 32 of the view's cells in one step (`VIEW_STEP_CELLS`). Not yet seen in the game.
   Still open: a cell needs its 1 km tile held by the page's network first (`cellHeld`, `RoadWindowLink`, solved off the page).

## More facts read from the same report (2026-10-27)
- The long frames (LoAF avg 172 ms, p95 617 ms, max 2.7 s) are the game's own frame; `hitch:draw/Render` max 998 ms (p95 17 ms): inside
  three's render. Shader programs stay at 220 (no compile mid-game). The page's JS heap stands at 2.8-3.3 GB and its collections drop up
  to 806 MB at once: the stalls match major GCs.
- READ IN THE CODE (2026-10-27): those long frames and that heap were mostly the tour's own photos - `tour.ts` photographer encoded a
  full-resolution PNG with `toDataURL` inside the game's frame callback (hundreds of ms on the main thread, attributed to the rAF wrapper)
  and built ~20 MB of base64 + JSON a photo, ~6 photos a stop. Fixed: `toBlob` off the frame, the bytes posted raw (`/__lab/shot?folder=&name=`).
  The game alone measured 1.1-1.3 GB of page heap on 2026-10-26 (`docs/agent/memory/architecture-state-2026-10-26.md`). The tour's
  numbers of long frames, heap and GC are NOT the game's until measured again with this fix.
- The measure now lists three's and the browser's functions too (`Snapshot.libraryFunctions`): the 9 ms of three's render at a street will
  show where it goes at the next single measurement.
- `tests/render/cellAffinity.spec.ts` "runs a square's masses at every level on one worker" fails on the code before these changes too
  (checked by putting the previous files back): a pre-existing failure, to fix, not to hide.

## Done and committed
- f0c830c3 menus show ready photos (`src/ui/photos`), lint rule `no-live-interface`.
- 51c3de4c diagnosis: reports, tour, hidden work, waste.

## In progress (uncommitted)
- Tour photos at native PNG (`src/lab/doctor/tour.ts`, `report.ts`, `scripts/vite/labReports.ts` `/__lab/shot`).
- `docs/agent/` (this folder), the project hook `.claude/settings.json` + `.claude/hooks/workstate.cjs`.

## Done in this batch (tsc, eslint and the points' specs pass; NOT yet seen in the game)
- The detail 'cell' kept in the derived cache like every other level; a cell level's superseded result forgotten in the store
  (`cellPool.ts` KEPT_KINDS, `keptOnce`, `keptResult`).
- The base level draws real windows, glass, curtain walls and lit rooms at night from each block's facade grid (`program.ts` BaseGrid,
  `buildingMesh.ts` recordBlock, `massBase.ts` gridShorts: 8 shorts a vertex, `massingMaterial.ts` BASE_GRID_GLSL).

## Next (in order)
1. Real roof shapes on the base (a pitched roof is still flat at half its rise).
2. Camera cost in three's render (9 ms CPU at a street, ~490 draws): read with the next measurement's library functions.
3. Roads: see in the game whether the view's cells now land at once; if not, the tile window (`cellHeld`) is next.
4. Camera cost: the scene graph and draws per frame; the heap growth; the DataTexture uploads.
5. tsc, eslint, the points' specs; commit; push; then one tour with photos.

## Notes for working here
- `.claude/hooks/git-gate.cjs` refuses git writes unless `.claude/coordinator-commit.unlock` exists: create it for your own verified
  commit, delete it after.

## CAMERA: the causes F7 now reports by itself (Record a move, 10 km city, 2026-10-27; lab-reports/move-*.md, diag-*.md)
Far view of the whole city (GPU-bound, 156-171 ms GPU a frame, 5.5 fps):
- building-massing-plate (the 2 km plate level): 76 ms a frame, its depth-first pass 25 ms more; 21.8 M triangles drawn twice.
- clouds 13-19 ms, GTAO 10 ms, SMAA 8 ms.
Moving near the ground (CPU-bound late frames; GPU p50 9-12 ms): the frame took 3.6 s of CPU in 8 s:
- three's scene render 1.6 s: setProgram 588 ms, of it texSubImage2D 293 ms = BatchedMesh indirect textures (UINT 8x8, 12x12, 32x32)
  sent again at every render of every camera (three r186 BatchedMesh.onBeforeRender sets indirectTexture.needsUpdate each call).
- cameraSolids.landed -> foundation.floorHeight -> floors.work: 351 ms on the page as buildings land.
- shadow cascades' render 260 ms; engine.refresh 280 ms; casterChanges 202 ms own; viewCells.has 107 ms own; drawOverlayScreen 167 ms.
- shader programs compiled mid-game (3 to 34 in a move) with three's checkShaderErrors reading getProgramInfoLog: up to 1 s blocked.
CORRECTION: the "2.2 GB/s, 18 GB of texSubImage2D" read earlier was F7 counting each row update's whole source array; fixed (bytes by
the region's size, format and type). Real uploads in a move: ~28 MB/s.

## CORRECTION 2026-10-27, the plate level (measured in the open game, whole city seen low, reports/in-game/2026-10-27-plate/04)
- Settled, that view draws 266 frames in ~6 s: the plate level costs 3.8 ms a frame and its depth-first pass 1.5 ms (16 M triangles, 803
  draws in all). The 45-171 ms frames were the first seconds while levels landed: a queue stall lands on whatever draw is in line, the
  plate being the largest. "76 ms of plates" was a misreading of landing stalls as the plate's own cost.
- So the camera's slowness is the LANDING: frames of 100-220 ms for ~3 s after a move while new geometry arrives (bufferData,
  copyBufferSubData and bufferSubData into the shared batch buffers, gpuBatchedMesh.ts:84/176/190/227/295/324; first draws of new meshes;
  ANGLE converting the base's 3-component USHORT positions). NEXT: find which of these the stalls follow, by an A/B in the game.

## CAMERA, after the A/B (2026-10-27, same start view x 36.5 y 219.5 zoom 2.5, same real gestures, Record a move)
- A/B "every ARRAY_BUFFER bufferSubData over 4 KB staged through a fresh buffer + copyBufferSubData": no change (B 21 late frames / 3
  stalls, A 22 / 4). Writes into buffers in use are NOT the cause; the probe is scratchpad only, nothing of it in the code.
- Warm (cells cached), 21 of 22 late frames waited on the CPU. The frame's CPU in an 8 s move, by function with callees (lab-reports/
  move-2026-10-27T17-01-29.md; the draw timer itself adds ~300 ms of beginQuery):
  three render 4.3 s: projectObject 1.6 s (the scene graph walked), updateBuffer 1.09 s (attributes sent again every frame),
  setTexture2D/texSubImage2D 0.71 s (of it crowdAnimation renderPalettes 0.69 s), setProgram 1.2 s;
  lotTool overlay -> moveWindow -> lotsIn 357 ms (the zones' window reaches the far plane when the camera pulls back);
  agents.sync 265 ms; depthFirst.draw 261 ms.
- NEXT, one at a time, each measured with Record a move from the same start: (1) projectObject: what in the scene graph is walked every
  frame and need not be; (2) updateBuffer: which attributes are sent every frame; (3) the people's palettes; (4) the zones' window bounded
  to where a lot spans a pixel.

## Order of work now (the owner, 2026-10-27)
1. NOW: F7 (the lab's diagnosis) made to catch every cause of today's camera slowness by itself: per-draw GPU and CPU time, GPU
   saturation and what the frame waited on, GPU work outside the frame by caller, uploads by caller, vertex formats ANGLE converts,
   sync GL calls, render-target reallocations.
2. NEXT: remove clouds and fog from the whole game (ordered; ~800 references in 34 files; old saves must still open).
3. Then: LOD, quality, performance, everything (BACKLOG).
