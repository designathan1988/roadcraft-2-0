# Geometry/Rendering Optimization Rules for a three.js r186 / WebGL2 City Builder

Scope: triangle shape and size cost, meshoptimizer pipeline, quantization (KHR_mesh_quantization / gltfpack), LOD by screen-space error, draw-call cost and batching in WebGL2/three.js, and budgets. About 20 tool calls (searches and fetches). Sources are linked inline. Statements without a source are in the Inferences or Gaps sections.

## Thin-triangle and small-triangle cost (quad shading, helper lanes, MSAA, max-area triangulation)

### Takeaway
GPUs shade in 2x2 pixel quads and rasterize in coarse tiles. Every partly covered quad or tile along a triangle edge is wasted work, so cost grows with total edge length per covered area. Triangles below about 8x8 px (desktop) or about 32 px of area (PowerVR mobile) lose efficiency quickly. Sliver triangles are worse than equilateral ones of the same area, and MSAA makes the gap bigger. Max-area triangulation of a convex polygon (Persson) beats fan and strip and stays flat under 4x MSAA.

### Cited Findings
- **Persson's three methods.** Emil Persson's "Triangulation" (Humus, January 2009) compares three ways to triangulate a tessellated circle. The fan is called "very bad" and the strip "also very bad". Max area starts from a central equilateral triangle, then recursively adds the largest possible triangle along the remaining edge, which makes it a greedy largest-area method. — [Humus: Triangulation](https://www.humus.name/index.php?page=News&ID=228)
- **Persson's results.** These are shown only as FPS charts against vertex count; the text gives no numeric speedups. Without AA, max area wins. With 4x MSAA, fan and strip lose more performance as the vertex count rises, while max area stays "mostly unaffected". — [Humus: Triangulation](https://www.humus.name/index.php?page=News&ID=228)
- **Persson's causes.** More polygons cost more fragment shading at the same screen coverage because "fragments are processed in quads", so edge quads get shaded more than once. Very thin triangles rasterize inefficiently, and fixed rasterization patterns make it worse. Memory access is less efficient at polygon edges, and MSAA raises the cost further. He calls max area close to optimal in general. — [Humus: Triangulation](https://www.humus.name/index.php?page=News&ID=228)
- **Riccio, "How bad are small triangles on GPU and why?" (g-truc, 2014).** Triangles covering tiles larger than 16x16 px had no measurable effect on any desktop vendor. 8x8 px had a significant but not cliff-like impact. Below 8x8, performance fell exponentially. At small sizes Intel Haswell was about 10x slower than optimal, NVIDIA Kepler about 15x and AMD Southern Islands about 20x. — [g-truc post-0662](https://www.g-truc.net/post-0662.html)
- **Riccio on shape.** Equilateral triangles performed better than thin ones for all vendors. 256x1 and 1x256 tiles performed noticeably differently, because rasterizers are not designed to be anisotropic. He recommends a minimum of about 8x8 px per triangle. A triangle that overlaps several 8x8 blocks uses one primitive slot per block. — [g-truc post-0662](https://www.g-truc.net/post-0662.html)
- **PowerVR / Imagination guide.** Avoid small triangles, "especially dipping below 32 pixels per primitive". Small triangles reduce rasterization efficiency, add vertex-stage and Tiling Accelerator load (by count, not size), and increase parameter-buffer bandwidth in system memory. Triangles covering less than one pixel are discarded by the hardware. — [Imagination: Triangle Size](https://docs.imgtec.com/performance-guides/graphics-recommendations/html/topics/triangle-size.html)
- **Fatahalian et al., "Reducing shading on GPUs using quad-fragment merging" (SIGGRAPH 2010).** Current GPUs perform "a significant amount of redundant shading" on finely tessellated surfaces. For pixel-sized triangles, merging quad fragments across adjacent triangles cuts total shading work eightfold. This implies roughly 8x overshading at about 1 px triangle size on stock quad pipelines. — [Microsoft Research abstract](https://www.microsoft.com/en-us/research/?p=159994)
- **Helper pixels.** The uncovered pixels of a 2x2 quad run as helper invocations so derivatives and mip selection work. An Intel patent proposes picking helpers from inside the primitive, which shows that fixed-quad helpers are a known waste. — [USPTO 9779542](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9779542)
- **AMD RDNA guide.** It recommends compute over a full-screen triangle for full-screen passes, gaining "up to 2%" and removing "need for helper lanes created at triangle edge". It also notes that a triangle does not fill a whole wave with an 8x8 tile. — [AMD GPUOpen RDNA Performance Guide](https://gpuopen.com/learn/rdna-performance-guide/)
- **Nanite.** It uses a compute ("software") rasterizer for clusters of pixel-sized triangles because hardware raster is inefficient there, and falls back to hardware raster for larger triangles. A secondary source reports about 3x throughput over hardware raster for micropolygons. — [Realtime Rendering blog roundup](https://www.realtimerendering.com/blog/seven-things-for-november-1-2021/), [CuRast arXiv 2026](https://arxiv.org/pdf/2604.21749). These are secondary sources; the primary Karis 2021 PDF was too large to fetch (see Gaps).

### Inferences
- **The cost model behind these numbers.** Wasted quad work is roughly proportional to the length of edge that crosses quads, about the perimeter divided by 2 px quads. Area is not what drives it. A W x L strip split into two triangles has about the same total edge waste as a well-shaped mesh of the same rectangle: the diagonal adds one interior edge, about the length of L. Splitting it into N slivers (for example, fanning across the width) adds N interior edges.
- **When long thin triangles are acceptable.** They are fine when the strip is wide on screen in the short dimension (well above 2 px, ideally 8 px or more). A road quad 7 m wide and 100 m long, viewed close, covers hundreds of pixels across; two triangles per quad cost almost nothing extra.
- **When they hurt.**
  - The short dimension shrinks to about 1–4 px on screen: distant roads, lane markings, curbs, sidewalk edges, wires.
  - Many slivers share the same area, such as fan triangulation of ring or circle shapes, or of roundabout and intersection fills.
  - MSAA is on.
- **What to do in those cases.**
  - Use max-area or Delaunay-style triangulations for intersection and plaza polygons.
  - Do not fan from one vertex.
  - At distance, collapse thin details: drop paint and curb geometry, or move it into textures or decals.
- **Shader cost multiplies the penalty.** Overshading cost scales with fragment shader cost, so a cheap unlit paint shader on thin strips is far less harmful than a PBR shader with shadows.
- **Depth-only and shadow passes still pay** the rasterization and primitive-rate cost of slivers, even though their shading is cheap.

### Gaps
- No primary numeric figure from Persson's charts (text only). No current (RDNA3/4, Ada/Blackwell) vendor numbers on thin-triangle penalties.
- No primary NVIDIA blog numbers were retrieved. No Fatahalian lecture slides were fetched; only the 2010 paper abstract.
- The primary Karis SIGGRAPH 2021 PDF exceeded the 10 MB fetch limit, so the exact software-raster threshold (edge length in pixels) is unverified.

## meshoptimizer: pipeline, simplification, analyzers, meshlets, codecs

### Takeaway
The recommended order is: index, then vertex-cache optimize, then (optional) overdraw optimize, then vertex-fetch optimize, then quantize, then filter indices, then (optional) shadow index buffer. Simplification uses relative error in [0..1] of the mesh extent, or absolute error with ErrorAbsolute. meshopt_simplifyScale converts the error to object space. LOD switches when the projected error falls below a pixel threshold.

### Cited Findings
- **Pipeline order.**
  1. Indexing (`meshopt_generateVertexRemap`, then `remapIndexBuffer`/`remapVertexBuffer`). It uses binary equality, so zero any padding; use `generateVertexRemapCustom` for tolerance matching.
  2. `meshopt_optimizeVertexCache`, which adapts to the GPU. The FIFO variant uses cache 16 and is about 2x faster to run but worse on modern GPUs.
  3. Optional `meshopt_optimizeOverdraw` with threshold 1.05, allowing at most 5% worse ACMR. It gives no benefit on tile-based deferred GPUs (PowerVR, Apple).
  4. `meshopt_optimizeVertexFetch`, run on the final index order.
  5. Quantization, run last because some steps need float3 positions.
  6. `meshopt_filterIndexBuffer`, which removes degenerate or duplicate triangles, including ones created by quantization.
  7. Optional `meshopt_generateShadowIndexBuffer` for depth-only passes.

  — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **Analyzer ranges.** ACMR is worst case 3, about 0.5 on regular grids and typically 0.5–1.5 on real meshes. ATVR is best at 1.0. Overfetch and overdraw are best at 1.0. `meshopt_analyzeCoverage` exists for silhouette and distance-culling decisions. The analyzers use approximate GPU models. — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **`meshopt_simplify` basics.** The example uses a target of 20% of the index count with `target_error = 1e-2`, which is 1% of the mesh extent. Pass `FLT_MAX` for no error limit, or a target of 0 for maximum reduction within the error.
- **`meshopt_simplify` options.**
  - `LockBorder` keeps borders so subsets (tiles or chunks) join without cracks.
  - `Sparse` is for subsets; use it with absolute error.
  - `Prune` removes isolated components.
  - `Regularize` / `RegularizeLight` produce more regular triangles.
  - `Permissive` allows collapsing across attribute seams; protect UV seams with `meshopt_SimplifyVertex_Protect`.
  - `PreserveFolds`, `ErrorAbsolute`, and `ErrorClamped` (recommended when the error drives LOD with attributes).

  — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **`meshopt_simplifyWithAttributes`.** Weight normals and colors at about 1.0, and UVs at 10–100 or `1/sqrt(avg UV area)`. An attribute change of `1/weight` counts the same as a position change of d. `meshopt_simplifySloppy` ignores topology: it merges nearby features but gives worse quality and does not preserve borders. — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **LOD selection rule from the README.** Use LOD level i when `e * lod_factor >= lod_error_i`, where e is the projected size of one pixel at the object's distance. — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **Meshlets.** `meshopt_buildMeshlets` with max 64 vertices and 126 triangles (NVIDIA recommendation). Older AMD hardware prefers 64/64 or 128/128; 64/96 is realistic on real meshes. Use `cone_weight` 0.25 when cone culling. A raytracing variant also exists. — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **Vertex codec.** 3–6 GB/s decode and 2–4x smaller than already-quantized data. Stride must be a multiple of 4. Quantize to small integers, for example 12-bit UVs instead of 16-bit, and use octahedral normals. — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **Index codec.** About 1 byte per triangle best case (6x smaller than 16-bit indices), typically 1–1.2 bytes per triangle, and about 2 bytes per index for sparse references. Lossy filters (octahedral, quaternion, exponential, color) decode at 5–10 GB/s. — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **Cluster LOD at scale (Kapoulkine, "Billions of triangles in minutes", 30 Sep 2025).**
  - Builds a Nanite-style DAG with meshoptimizer 0.25: clusters of up to 128 triangles, grouped, simplified with locked group boundaries, re-split, recursively.
  - A cluster is replaced only when the resulting visual error is under 1 pixel.
  - NVIDIA Zorah (1.64B triangles, 18.9B instanced) built in about 2m35s on a 16-thread 7950X, about 3.5x faster than the initial build.
  - Rendering on an RTX 3050 with a 2 GB pool took 16 ms raster and 26 ms raytraced.

  — [zeux.io](https://zeux.io/2025/09/30/billions-of-triangles-in-minutes/)

### Inferences
- **Procedurally generated city geometry (roads, buildings)** should get, at chunk-build time: dedupe/indexing, then `optimizeVertexCache`, then `optimizeVertexFetch`. JS/WASM builds of meshoptimizer are available through the npm `meshoptimizer` package.
- **Simplifying tiles independently.** Use `LockBorder` (or `Sparse` with `ErrorAbsolute`) so adjacent chunk LODs do not crack.
- **ACMR on generated strips.** Typical road-strip grids are near the 0.5 regular-grid ACMR already, so cache optimization gains are modest. Fetch locality and index filtering are still cheap wins.

### Gaps
- No JS/WASM timing numbers were retrieved for in-browser simplification.
- The last 18.7k characters of the README were not read (they cover codec and extension details).

## KHR_mesh_quantization, gltfpack, three.js attribute packing

### Takeaway
Quantized attributes cut vertex size by about 2.4x (48 B to 20 B per PBR vertex in the spec example) with negligible quality loss. three.js loads them natively (r111+), and meshopt-compressed glTF from r122+ with MeshoptDecoder.

### Cited Findings
- **Allowed types.**
  - POSITION: byte, ubyte, short or ushort, normalized or not.
  - NORMAL: byte or short, normalized.
  - TANGENT: byte or short, normalized.
  - TEXCOORD: byte, byte normalized, ubyte, short, short normalized or ushort.
  - COLOR is not covered.

  Elements are 4-byte aligned, so a byte normal uses stride 4. — [KHR_mesh_quantization spec](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md)
- **Dequantization.** Position scale and offset go into the node transform (or `inverseBindMatrices` when skinned), using a uniform scale so normals keep their direction. UVs use `KHR_texture_transform`.
- **Size and normalization.** Example: 48 B float PBR vertex versus 20 B quantized. Normalize normals after the normal matrix. `accessor.min`/`max` are stored quantized.

  — [KHR_mesh_quantization spec](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md)
- **Range trade-off.** A per-mesh range minimizes error but can cause visible gaps between meshes that quantize differently, and can block material sharing. A scene-wide shared transform avoids gaps at higher error. — [KHR_mesh_quantization spec](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md)
- **Signed normalized decode.** GLES2/WebGL1 may decode SNORM differently. For positions, prefer unsigned normalized or signed unnormalized. — [KHR_mesh_quantization spec](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md)
- **gltfpack.**
  - Quantizes by default (KHR_mesh_quantization unless `-noq`); `-vpf` keeps float positions.
  - `-c`/`-cc` emit `EXT_meshopt_compression` (also `KHR_meshopt_compression` via `-ce khr`).
  - `-si R` simplifies.
  - `-mi` uses `EXT_mesh_gpu_instancing`.
  - It merges meshes on non-animated nodes by default to reduce draw calls.
  - three.js: quantized files load from r111; meshopt files from r122 with `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` (`examples/jsm/libs/meshopt_decoder.module.js`).

  — [gltfpack docs](https://meshoptimizer.org/gltf/)
- **meshoptimizer quantization helpers.** It recommends 10-10-10 SNORM normals (`meshopt_quantizeSnorm(v,10)`), half-float positions (`meshopt_quantizeHalf`) and octahedral normal encoding. Unorm values dequantize by dividing by 2^N−1, snorm by 2^(N−1)−1. — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)

### Inferences
- **In three.js without glTF**, the same packing works by creating `BufferAttribute(new Int16Array(...), 3, /*normalized*/ true)` for positions in a chunk-local frame, with chunk scale and offset in the mesh matrix. Normals go in `Int8Array` normalized. WebGL2 supports normalized integer vertex attributes natively.
- **Avoiding cracks.** Use one shared quantization grid per chunk, or snap shared boundary vertices to a global grid, to avoid T-gaps between adjacent road chunks.
- **Octahedral normals** need custom shader decoding in three.js through `onBeforeCompile` or a node material. The glTF path decodes them on the CPU through the meshopt filter.

### Gaps
- Did not verify three.js r186 handling of normalized Int16 position with `computeBoundingBox`. three.js likely dequantizes through `getX`, but this was not confirmed in source.

## LOD selection: screen-space error, hysteresis, discrete versus continuous, three.js LOD/BatchedMesh

### Takeaway
Select LOD by projected geometric error in pixels, about 1 px for a "Nanite-invisible" switch or a few px for discrete LODs with hysteresis, instead of raw distance. three.js `LOD` is distance-based (distance / camera.zoom) with fractional hysteresis, so map your error threshold to a distance per level.

### Cited Findings
- **Screen-space error rule.** Switch when `pixel_size_at_distance * lod_factor >= lod_error`, using simplify's error scaled to object space by `meshopt_simplifyScale`. — [meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- **Continuous cluster LOD (Nanite-style).** Coarser clusters replace finer ones only when the error is under 1 pixel; the switch is hidden by TAA. — [zeux.io 2025](https://zeux.io/2025/09/30/billions-of-triangles-in-minutes/)
- **three.js `LOD.update`.**
  - Distance is `_v1.distanceTo(_v2) / camera.zoom`.
  - For a level that is currently visible, its threshold is lowered by `levelDistance * hysteresis`, which keeps it on longer.
  - A level is chosen when `distance >= levelDistance`.
  - `addLevel(object, distance, hysteresis)`; `autoUpdate` is on by default.

  — [three.js LOD.js](https://raw.githubusercontent.com/mrdoob/three.js/r168/src/objects/LOD.js), [three.js LOD docs](https://threejs.org/docs/pages/LOD.html)
- **BatchedMesh vs merging (gkjohnson, three.js maintainer, Oct 2025).**
  - BatchedMesh supports per-object frustum culling, sorting, visibility and per-instance geometry switching via `setGeometryIdAt`, which can serve as an LOD swap.
  - Merging into one static mesh is "a fine solution" when geometry is unique and never toggled or culled.

  — [three.js forum](https://discourse.threejs.org/t/when-is-it-actually-beneficial-to-use-lod-in-three-js-for-performance/87697/11), [BatchedMesh docs](https://threejs.org/docs/pages/BatchedMesh.html)

### Inferences
- **Pixel error from distance.** For a perspective camera, one world unit at distance d spans about `H / (2·d·tan(fov/2))` px, where H is the viewport height in pixels.
- **Threshold to distance per level.** To keep error at or below τ px, use level i when `d >= err_i · H / (2·τ·tan(fov/2))`. Feed that value to `lod.addLevel`, and recompute it on resize or FOV change.
- **Hysteresis.** About 0.1–0.2 is a common choice to prevent popping thrash. This is not sourced, so tune it.
- **Discrete versus continuous.** Discrete per-chunk LOD (2–4 levels made with `meshopt_simplify` plus `LockBorder`) is the practical WebGL2 choice. A Nanite-style DAG needs per-cluster GPU culling and selection (compute or mesh shaders, indirect draw), which WebGL2 lacks. A WebGPU path would be needed.
- **City-scale BatchedMesh LOD.** Put all LOD variants of props in one BatchedMesh and switch per instance with `setGeometryIdAt` on a camera-movement tick. This keeps one draw call per material.

### Gaps
- Did not verify the r186 `LOD.js` specifically; r168 was fetched. LOD logic has been stable but is not confirmed for r186.
- No primary-source hysteresis values.

## Draw-call cost in WebGL2/three.js, WEBGL_multi_draw, merging per chunk

### Takeaway
Each three.js draw call costs CPU time (JS → WebGL validation → ANGLE → driver), plus state, program and uniform changes. WEBGL_multi_draw batches many draws in one API call: 2–70x in 2019 microbenchmarks. Chromium currently has a known multidraw bottleneck, and some ANGLE backends emulate multidraw in a loop. Static per-chunk merging remains the most robust approach, with BatchedMesh where you need culling, toggling or LOD.

### Cited Findings
- **WEBGL_multi_draw / WEBGL_multi_draw_instanced (Austin Eng, Khronos list, Feb 2019).** They pack many drawArrays/drawElements parameters into one call, reducing JS → WebGL overhead. Per-draw data goes in UBOs indexed by `gl_DrawID`. Chrome microbenchmarks showed about 2–3x up to 70x over many small individual draws, and other prototypes about 4x. — [Khronos public_webgl](https://www.khronos.org/webgl/public-mailing-list/public_webgl/1902/msg00002.php)
- **ANGLE emulation.** Multidraw is implemented as a loop on D3D11 and other ANGLE backends, which limits the gain. This comes from a secondary (Babylon forum) source. — [Babylon.js forum](https://forum.babylonjs.com/t/webgl-multi-draw-extension/47345)
- **Known Chromium bottleneck.** three.js maintainer gkjohnson notes a WebGL multidraw performance bottleneck tracked as Chromium issue 437957104. — [three.js forum](https://discourse.threejs.org/t/when-is-it-actually-beneficial-to-use-lod-in-three-js-for-performance/87697/11)
- **When BatchedMesh can be slower.** A forum report found BatchedMesh `_multiDrawInstances` slower. The reply says BatchedMesh helps mainly when per-mesh draw overhead is the bottleneck. — [three.js forum](https://discourse.threejs.org/t/why-did-the-performance-worsen-significantly-when-i-used-multidrawinstances-in-batchedmesh/78581)
- **BatchedMesh API.**
  - Constructor: `new BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount = maxVertexCount*2, material)`.
  - Geometry and instances: `addGeometry(geom, reservedV, reservedI)`, `addInstance`, `setGeometryAt` (throws if the reserve is too small), `setGeometryIdAt`, `deleteGeometry`, then `optimize()` to repack.
  - Properties: `perObjectFrustumCulled`, and `sortObjects` (opaque front-to-back, transparent back-to-front), with optional `setCustomSort`.
  - Limits: one material; negative scale unsupported. The docs say it reduces draw calls.

  — [three.js BatchedMesh docs](https://threejs.org/docs/pages/BatchedMesh.html)
- **Native-API batching guidance (AMD RDNA).** Use at least 10 draws per command buffer or bundle, since each submit has CPU and GPU cost. Avoid per-draw vertex-stream rebinding by using offsets or vertex pulling. Keep position in its own stream to speed depth-only passes. Avoid primitive restart on older hardware. — [AMD GPUOpen RDNA Performance Guide](https://gpuopen.com/learn/rdna-performance-guide/)
- **gltfpack merging.** It merges meshes on static nodes by default "to reduce draw calls". — [gltfpack docs](https://meshoptimizer.org/gltf/)

### Inferences
- **Rule of thumb for the city.**
  - Merge static road, terrain and building geometry per chunk and per material into one BufferGeometry, giving O(chunks × materials) draws.
  - Use InstancedMesh for repeated identical props (lamps, trees, benches).
  - Use BatchedMesh for heterogeneous props that need per-object culling or LOD.
  - Group by program and material first to minimize program switches.
- **Chunk size trade-off.** Larger chunks mean fewer draws but coarser frustum culling and costlier rebuilds on edit. Rebuild only the edited chunk.
- **Separate position stream.** This (AMD advice) helps shadow and depth passes. In three.js it means non-interleaved attributes, which is the default.

### Gaps
- No primary measurements found of per-draw-call CPU cost in three.js/WebGL2 (for example µs per draw on Chrome/ANGLE).
- Did not open Chromium issue 437957104 for its details or status.

## Typical triangle/draw budgets for city builders and web 3D at 60 fps

### Takeaway
No authoritative published triangle or draw budget for web city builders was found. The sourced constraints are on triangle size (at least 8x8 px desktop, at least 32 px² mobile), not count. Budgets should come from those plus profiling.

### Cited Findings
- **Triangle size targets.** At least 8x8 px per triangle for good primitive throughput on desktop GPUs (2014 hardware). — [g-truc](https://www.g-truc.net/post-0662.html). Avoid triangles under 32 px area on PowerVR mobile. — [Imagination](https://docs.imgtec.com/performance-guides/graphics-recommendations/html/topics/triangle-size.html)
- **Upper bound with cluster LOD.** Kapoulkine's cluster-LOD demo renders 18.9B instanced source triangles at 16 ms raster on an RTX 3050, using a 1 px error budget. That bounds visible triangles by resolution, not scene size (Vulkan, not WebGL). — [zeux.io](https://zeux.io/2025/09/30/billions-of-triangles-in-minutes/)
- **Draw-call scale in three.js.** The three.js forum treats "more than 3500 meshes" as a performance problem worth batching (thread title only). — [three.js forum](https://discourse.threejs.org/t/when-is-it-actually-beneficial-to-use-lod-in-three-js-for-performance/87697/11)

### Inferences
- **Resolution-bound triangle budget.** At 1080p (about 2.07M px) with an 8x8 px target, about 32k visible triangles cover the screen at ideal size. Several times that (hundreds of thousands to low millions after culling) is fine on desktop. The practical rule is: keep the on-screen triangle density at 1 triangle per 8–64 px through LOD, rather than a fixed scene count.
- **Draw calls.** Aim for low hundreds of draw calls per frame on WebGL2. This is a common practitioner heuristic, not sourced here; verify with `renderer.info.render.calls` and frame timing.

### Gaps
- No sourced triangle or draw budgets from commercial city builders (Cities: Skylines and similar) or web-3D vendors were found within the tool-call budget.
- No WebGL-specific draw-call throughput benchmarks newer than 2019.
