# The optimization solution (analysis of 2026-10-28, from the code)

Order: the owner, 2026-10-28 01:50 (`orders.md`). Evidence: the code only. Notebook of the reading: `docs/agent/work.md`.

## 1. The structural cause of the slowness when the camera moves

What happens in one frame of a camera drag (read in `renderer.ts` 2704-4367, `buildings/layer.ts`, `massCells.ts`, `partCells.ts`,
`cellInstances.ts`):

1. About 40 subsystems run one after the other on the page's thread (`scene.draw`). Every one with a view-dependent part redoes it
   whenever the view matrix changes, i.e. every frame of a drag: the ten instance layers' culls (`cellInstances.cull`), `lookProps`,
   `utilities.look`, `agents.sync`, `signals.sync`, `terrain.lookFrom`, `buildings.levelOfDetail`, `buildings.cullDetails`, the CPU
   occlusion (`occlusion.build` + `buildings.hideOccluded`), the shadow casters' `castInto` per cascade.
2. Each layer keeps its own spatial cells and walks them against the frustum itself: the same view is traversed many times a frame.
3. The buildings' levels: `levelOfDetail` re-runs `massCells.choose` (every plate and tile of the map, then the cells in reach), `cap`,
   `capTriangles` (a string of every near key, new arrays and sets) whenever eye x/y/z differ by any amount (`layer.ts` 1012-1026).
   `cullDetails` then calls `PartCell.choose` on every visible cell, which re-walks every band x 64 Morton leaves
   (`partCells.ts` 145-205; its guard at 147 is exact equality, so any motion re-walks all).
4. The output of all that is THOUSANDS OF three.js OBJECTS: each run of sub-cells of each band of each cell is its own `InstancedMesh`
   (`partCells.ts` 184, `make`), plus one caster mesh per band. three.js then walks the scene graph (`projectObject`), tests each
   object's sphere, sorts, and issues one draw per object with its state changes and uniform uploads, once for the colour pass and
   again for each of the 3 sun cascades (`sunCascades.ts`, `SUN_CASCADES = 3`).

So the CPU cost of a camera move grows with (visible cells x bands x leaves) and with the number of draw objects x passes. It is
decided object by object, on the CPU, in JavaScript, every frame the view changes. The many patches in the code (settle guards,
signatures, staggered cascades, held cells, budgets) each trim one of these walks; none removes the shape: **the picture is
rebuilt on the CPU from scratch for every view**. That is why every fix moved the cost elsewhere instead of removing it.

## 2. The structural cause of the far buildings not looking like the originals

Past the detail reach a building is not drawn from its own model: it is drawn from a second, separate representation, the masses
and the facade level (`massing.ts`: "laid from the building's program ... never by a walk of its own"; `facadeLevel.ts`: windows
painted by a shader on flat runs; tiles drop 1.4 m of roof detail, plates 8 m and flatten pitched roofs). Two pipelines describe the
same building with different code and different shading, matched by hand. Every mismatch (the open issue: the far wall gap ~10%
darker, 107,101,89 vs 119,105,88) is a symptom of that design: nothing ties the far picture to the near one, so they drift.

## 3. The solution

### A. GPU-driven drawing: the view is decided on the GPU, once, for every layer

What it is: the technique of "GPU-Driven Rendering Pipelines" (Haar and Aaltonen, Ubisoft, SIGGRAPH 2015), used by the large
open-world engines: the scene lives in GPU buffers, a compute pass culls and picks levels, and writes the draw arguments itself;
the CPU issues a fixed number of indirect draws.

How, in this game (three r186, already installed, already has what it needs: `BufferGeometry.setIndirect`
(`node_modules/three/src/core/BufferGeometry.js` 253) and `drawIndexedIndirect` in `WebGPUBackend.js` 2161; the game already has a
WebGPU renderer path, `render/gpu/backendChoice.ts`, `webgpuView.ts`):

1. ONE TABLE OF THINGS ON THE GPU. Every instanced kind (building part bands, far parts, furniture, signs, barriers, transit, the five
   plant layers, elements, gardens) is one storage buffer of instances per kind, as the bands already are (`partPose.ts`: the poses
   are already GPU-side, "the GPU makes their matrices"), plus one buffer of sub-cell records: box, largest scale, the kind's level
   errors (the data `partCells.ts` reads in `levelAt` / `perMetre`, already filed by the workers in `partFiling.ts`).
2. ONE CULL A FRAME, ON THE GPU. A compute pass reads the camera and the cascades, and for each sub-cell: frustum test, level by the
   SAME screen-error formula `levelAt` uses now (ported word for word to WGSL), cascade casting by the same texel rule as `castInto`
   / `shadowLevel`. It appends the visible instances to per-kind-per-level lists and writes the counts into ONE indirect-args buffer
   (one buffer, not one per draw: Chrome/Dawn validates each indirect buffer with its own dispatch, 3 ms for 412 separate buffers
   against 10 us for one, https://toji.dev/webgpu-best-practices/indirect-draws).
3. A FIXED NUMBER OF DRAWS. The CPU issues one indirect draw per (kind x level x pass). It no longer walks cells, bands, leaves or
   runs; three's scene holds a few hundred meshes, not thousands.
4. WORK BY CHANGE, NOT BY VIEW. The CPU writes to those buffers only when the city changes (an edit, a cell streamed in or let go,
   a level landed): a range write of that cell's records. A camera move writes the camera uniform and nothing else.
5. The building cells' coarse choice (`massCells.choose`: plates, tiles, cells near or far, the streaming of what to build) stays on
   the CPU but runs only when the eye crosses a cell's threshold, not every frame; it decides what is RESIDENT, the GPU decides what
   is DRAWN.
6. WebGL fallback (any GPU, Steam): the same tables; the cull runs on the CPU ONCE a frame for all layers (one traversal of one
   shared sub-cell tree, replacing the ten separate ones and the per-cascade `castInto` walks), writing multi-draw ranges drawn with
   `WEBGL_multi_draw` (what three's `BatchedMesh` uses, https://threejs.org/docs/pages/BatchedMesh.html,
   https://developer.mozilla.org/docs/Web/API/WEBGL_multi_draw). The draw count stays fixed as on WebGPU.

What it guarantees, by construction (not by measurement):
- The CPU cost of moving the camera no longer depends on the city's size nor on how much is visible (WebGPU): it is one uniform write
  and a fixed list of draws. On WebGL it is one traversal a frame instead of one per layer and per cascade.
- The number of draw calls is bounded by kinds x levels x passes, whatever the map size.
- Nothing visible changes: the same meshes, materials, shaders and level formulas are used; only WHERE the choice is computed
  changes. Any difference is a porting bug, checkable picture against picture with the game's own comparison
  (`render/gpu/imageCompare.ts`, `twins.ts`).

### B. WITHDRAWN (never bake: the buildings are built at run time; the far levels already use the facade grammar, section 4 step 5)

What it is: Hierarchical LOD as Unreal and Cesium build it: a coarser level is generated FROM the finer one, its geometry simplified
and its material baked from the original's look into an atlas
(https://dev.epicgames.com/documentation/unreal-engine/hierarchical-level-of-detail-overview-in-unreal-engine,
https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine; the
3D Tiles replacement refinement the code already follows for the selection, `massCells.ts` 829).

How: when a cell's detail is built (the workers already build it: `cell.worker.ts`), its coarser levels are produced from that
detail: geometry simplified (meshoptimizer is already in the project, `meshoptSimplifier.d.ts`), and its facades rendered once by the
SAME near materials and lights into a texture atlas (the bake machinery exists: `impostorBake.ts`, `bake/`). The tile and plate
levels are made from the cells' baked levels, not from the program again. The far shader samples the baked albedo and normal and
lights them with the same lighting code.

What it guarantees: the far colour and window pattern ARE the near model's, rendered by the near material; the only difference left
is resolution (a texel per pixel at the distance the level is chosen for). The hand-matched second pipeline (`massing.ts` painting,
`facadeLevel.ts` windows) stops being a source of drift, so mismatches like the darker wall gap cannot recur.

## 4. How it must be built (order, each step committed, the game unchanged in look after each)

1. The shared sub-cell table and ONE CPU cull a frame for every layer (the WebGL path, step 6 above): the ten layer culls,
   `PartCell.choose` and `castInto` read it. This alone removes the repeated traversals, on every GPU.
2. Multi-draw: the part runs of a kind merged into one draw per (kind x level x pass); `partCells.ts` stops making a mesh per run.
3. The WebGPU compute cull writing one indirect buffer, the CPU cull kept as the WebGL fallback.
4. `massCells.choose` / `cap` only on threshold crossings (residency), not every frame.
5. WITHDRAWN: never bake. The buildings are programs made at run time and edited by the player, so the far levels must come
   from the same facade grammar evaluated per pixel over the real masses: F-shade (Haegler et al., EGSR 2010,
   https://diglib.eg.org/items/c323b1b7-2ba8-4be3-8575-c0808924e2bf) and levels from the grammar's own terminals (Mueller et al. 2006).
   That was decided on 2026-10-27 (27bcdd1a) and is ALREADY IN THE CODE: the masses, tile, plate and base are written in the facade
   level's own vertex format and drawn by its own material (`massCells.ts` 256: `[kit.shellMaterial, kit.facade]`). What is left of the
   far look is the far wall gap ~10% darker than the original (STATE.md open issues): a fix inside that design, by reading the code.
6. The occlusion moved into the same compute pass (a depth pyramid of the last frame, as the 2015 talk does), replacing the CPU
   `occlusion.build` / `hideOccluded` walk.

## 5. Decided or found earlier and missing from this plan (read from the whole session, 2026-10-26 21:27 to 2026-10-28 03:00)

Each item below was ordered by the owner or found by reading the code, and this plan did not carry it. Every step above must keep them.

1. **ONE FORM PER VIEW, FOR EVERYTHING** (the owner, 2026-10-27 evening, "above every other": `history.md` 9-27). What a thing looks like
   depends on the view alone, never on what has loaded nor on a budget. Done: roads (8e1e9f25, 6c7361fb), cars by their own screen size
   (8e1e9f25), the buildings' far levels in the facade level's format (878d21d5 on). NOT done:
   - buildings: the form still hangs on load and budgets: `layer.ts` 303-318 `capTriangles` coarsens and holds cells by the triangle
     budget, `keepToBudget` lets far cells go over the memory room, `pendingCells` are "shown as they land";
   - trees (near trees / far forest cards), street furniture and props, people, poles and wires (blocks not built show nothing), the
     stand-in of a road just built (`roadStandIn.ts`), terrain levels, water: inventory first, one category at a time.
   The GPU cull (step 3) must pick the level by screen error alone, with no budget swapping the form.
2. **Clouds and fog removed from the game** (the owner, 2026-10-27 afternoon: "SE ESTIVEREM REMOVA ELAS DE UMA VEZ DO JOGO, ASSIM COMO
   NEBLINA"; clouds measured 13-19 ms of GPU at the whole-city view). Not done: `fogLayer.ts`, `cloudShadowStamp.ts`, ~37 files; old saves
   must still open.
3. **Camera-drag causes found with real gestures and not in this plan:**
   - shader programs compiled in the middle of a move (3 to 34 a move, the page stopped up to 1 s): every program the view can need
     compiled before it is drawn;
   - the people's animation palettes drawn every frame for every batch, ~950 renders a second even off screen (`renderer.ts` 4112
     `agents.renderPalettes`, `BACKLOG.md` 9);
   - every render target reallocated when the window flips between 1079 and 1080 px (`BACKLOG.md` 6);
   - three's batched draws re-uploading their small data textures at every draw of every camera (293 ms in 8 s): step 2's multi-draw
     must not bring that cost with it;
   - the 3-component half-float attributes ANGLE converts (`BACKLOG.md` 7).
4. **Rebuild every heavy model and the textures painted at run time** (the owner, 2026-10-27: "REFAÇA SIM TODOS OS MODELOS E TEXTURAS";
   "REFAÇA O MODELO DE TUDO QUE TIVER MUITOS TRIANGULOS"): the seven textures painted at the opening (blast, signature, casualties,
   elements, lowPolyTrees, signs, utilities; the lint's shrinking list), the cars, the building parts (2.65 M triangles, 60% of the GPU at
   a street view).
5. **Whole-map work still left on the page or sent whole:** the simulation receives the whole map (`simClient.ts` -> `trafficMapOf`);
   the road surfaces are derived on the page (inventory S1); on a cold arrival `viewCells.make`, `lookProps`, `casterChanges`, `syncBases`,
   `poleCells.look` and the copy of rows sent to the job processes.
6. **The base level built for the whole map at the opening**, as heavy as the plate since fe0b4e42 (said on 2026-10-27 19:51): the
   opening's own cost, to be made by view like the rest.
7. **Never a fake or a compensation:** the far wall gap (~10% darker) is fixed structurally, never by a shader colour compensation (the
   owner's goals of 2026-10-27 night); the far two-wheelers stay undrawn until their riders are drawn with them; nothing baked for
   buildings (step 5). Still asked and not done: the street-level pedestrian camera; the far night beige (`BACKLOG.md` 1, set aside).
