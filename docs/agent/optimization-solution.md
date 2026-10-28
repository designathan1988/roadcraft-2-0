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

### B. Far buildings made from the near ones (HLOD with baked material)

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
5. The far levels baked from the detail (part B), replacing `massing.ts` / `facadeLevel.ts` painting.
6. The occlusion moved into the same compute pass (a depth pyramid of the last frame, as the 2015 talk does), replacing the CPU
   `occlusion.build` / `hideOccluded` walk.
