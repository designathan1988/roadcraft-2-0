# The OPEN findings checked in the current code (2026-10-28, src at f25d3285 = 7c4de70f's game code + f25d3285)

Source: docs/agent/findings.md (1,111 lines, from the 249 documents of docs/agent/reading.md, all read whole). "Checked" = read in the
current code by grep/read, file:line given. "Not checked yet" = still to be re-found in the code as the FIRST step of its mission item
(the reports' line numbers are of older builds). Nothing here was measured.

## Checked: already FIXED in the current code (do not put in the mission)
- FarPartBatch race (study-all-scopes): FIXED. farParts.ts:134-150 `choose` reads `this.kit.screen[kind].levels` as they are now, the
  simplified levels included once `kit.levelsReady` settles (kit.ts:692); the catalogue awaits `levelsReady` (lab/catalog/kits.ts:44).
- Far street props drawn as boxes / at the near model only (mobilia NOTAS, objects-inventory): FIXED in design. Far blocks draw a kind by
  its ladder: near / mid / far rungs and its picture (propCells.ts:344-373, farLadders.ts, streetFurnitureLayer.ts:46 "DO NOT go back to
  drawing a far prop as the box", propLevels.ts). A block made before the simplified models exist draws a 'near-unsimplified' rung and is
  remade when they come (propCells.ts:365, 338-339, 716). What stays OPEN is the band test, below.
- gpuBatchedMesh getBufferSubData in compact: only a fallback for a geometry with no kept indices (gpuBatchedMesh.ts:74-75, 306-311); the
  normal path writes the indices from `localIndex`. Not a frame cost.
- Shader error checks in release: `renderer.debug.checkShaderErrors = import.meta.env.DEV` (renderer.ts:519): the synchronous program
  queries measured in the move reports are the DEV build's. The compiles themselves (programs built at first use in a move) stay OPEN.
- Opaque shells not depth-sorted: `mesh.sortObjects = material.transparent` (shellBatch.ts:217-220); faded ones sorted (:180).
- densityCars road lines and the road paint table: sent as RANGES, not whole (densityCars.ts:407 `addUpdateRange(at, LINK_POINTS*4)`,
  roadPaint.ts:144-151, 211-225 `sendTexels`); three r186 merges ranges of one row and sends each with texSubImage2D and
  UNPACK_ROW_LENGTH/SKIP (three.module.js:11815-11908). The lab's "9.32 MB each / 86,922 MB/s" multiplied the number of `needsUpdate`
  setter calls by the texture size: a lab counting artefact, not the bytes sent. What stays OPEN: `writeLine` sets `needsUpdate` once a
  line (densityCars.ts:408, ~9,300 a second at the whole map): many ranges a frame; merged by three only within a row.

## Checked: OPEN in the current code
- Far ladder band test in the VERTEX SHADER (tour 15-29, 1.78 M triangles shaded and dropped): farLadders.ts:37-49 `BAND_GLSL` collapses
  every vertex of a thing out of its rung's band; all instances of every shown rung are submitted (`showLadder` hides a rung only when no
  thing of the block can be in its band). Fix: per block, sort its instances by rung on the CPU when the view crosses a bar (draw range
  per rung), the GPU test kept only as the exact edge.
- People's animation palettes (item 1b): renderer.ts:4112 calls `agents.renderPalettes` every frame; riggedCitizens.ts:1092-1098 renders
  every batch with `count > 0`, drawn or not; crowdAnimation.ts:279-300 `render` uploads its play/override rows by ranges (fine) and
  draws the palette pass each call. Fix: render a batch's palette only when it is drawn this frame (its meshes visible to a camera).
- Screen size flips (item 1c): screenSize.ts:17-33 refits every target whenever width/height changes, so a 1079/1080 flip reallocates
  every target. Fix: find why the canvas height flips by one pixel (CSS layout of the canvas / scrollbar / devicePixelRatio rounding in
  main.ts's resize) and size from a value that does not flip.
- Three-component half floats (item 1e): instance colours as half x3: partCells.ts:145, farParts.ts:124/425, buildingMesh.ts:4955 (and
  4873 facade halves FACADE_FLOATS: check its item size). D3D11 has no 3-component 16-bit vertex format; ANGLE converts on the CPU.
  Fix: 4 components (pad), as https://github.com/Microsoft/angle/wiki/Getting-Good-Performance-From-ANGLE says.
- BatchedMesh indirect texture re-sent at every render of every camera (item 1d): three r186 `BatchedMesh.onBeforeRender` sets the
  indirect texture's needsUpdate each call; GpuBatchedMesh.onBeforeRender (gpuBatchedMesh.ts:87-100) calls it as is. The fix of the
  reverted batch ("one draw list per camera, sent only when it changed") is not in the code. OPEN.
- Unread quality settings: grassBlades, vegetationDistance, birds, waterfalls are named only in render/quality.ts and
  optimizationsQuality.ts: no system reads them (changing the tier changes nothing there). Either wire them to their systems or drop
  them from the tiers (a decision for the item that touches quality).
- Sky dome: SphereGeometry(1, 32, 16) = 960 triangles (environment.ts:152, and the probe :167). Fix decided (R7): a fullscreen triangle.
- ARC_TOL 8 mm at every level: core/scalar.ts:39; core/offset.ts:56 default; core/ring.ts:108 uses ARC_TOL directly (no per-level
  tolerance). Fix decided: the tolerance of the level that draws it (its pixel error).
- setActiveTiles has NO definition left (grep: none): the "cells of the whole explored area stay resident" (auditoria P-09) is a
  question of the layers' own budgets/LRU now: re-check memory release per layer in its item (not by measuring: by reading the keeps).
- Lot overlay: editor/lotTool.ts:680 `refreshLots` from the overlay each frame, :727 and :799 `doc.lotsIn` per dirty rect / window cell:
  OPEN to re-read in item 1f (the frame-path page work).
- Blast/gore static matrices: blast.ts:683/703/720 `updateMatrix()` in the step loops and frustumCulled false on its meshes
  (:238/270/277/298): re-read in item 1f.
- agents.ts:1045 `growPart(part, part.n + 1)`: parts grow by doubling; the audit's "old GPU buffers never freed until context loss"
  (agents.ts:1443 then) to re-check in the vehicles item.

## Not checked yet (re-find in the code as the first step of the item that owns it)
Every other OPEN entry of findings.md: the casterChanges scan, syncBases, pole stores' per-frame sort, viewCells.make on cold cells,
road surfaces/junction pieces derived on the page, sign/pole/prop cells derived on the page, terrain seams recut in the frame, uploads
outside a budget (LandLod.select, paintStep, sunCascades copies), camera solids on the page, scene walks (updateMatrixWorld x3,
traverse in drainCompiles/optimizer/depthFirst), cellKeeps sort a frame, jobPool messages while still, simClient send while still,
flatAtlas/terrain updatePaint while still, sunCascades sphere/matrices while still, memoryCounters/partCells/streetFurniture triangle
counters in the frame, profilerHooks (dev only), the whole-map passes (base level at the opening, trafficMapOf, plantAll, allKeys,
SurfaceInputs.rebuildAll, TileIndex.fileAll, priceAll, ragdoll solids, RoadTop.heightIn), the geometry-level items (unindexed pieces,
hidden faces, Uint32 where Uint16 fits, heavy vertices, models without levels), the far look gap (Delta E), the save/undo whole-document
copies, the simulation step, the cooked people loading, and the dead code (knip).
