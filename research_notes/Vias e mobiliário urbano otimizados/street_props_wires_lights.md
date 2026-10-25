# Street props, overhead wires and street lights for a three.js r186 / WebGL2 city builder

Scope: traffic lights, street lights, utility poles, overhead wires (catenary sag) and road signs, plus their lights, at thousands of props per city. Research budget: about 15 search/fetch calls. Several primary sources (shaderbits impostor article body, GPU Pro 5 wire chapter text, GTA V graphics study parts 2 and 3, Epic City Sample talks) could not be read in full. Those are listed under Gaps rather than reconstructed from memory.

## 1. How shipped city games handle thousands of street lights and overhead wires

### Takeaway
None of the shipped games I could check gives each street lamp a real shadowed light at city scale. The documented patterns are: lamps flagged as light-emitting props (CS1 After Dark), instanced draws for nearly everything (CS2), deferred lights plus emissive plus bloom (GTA V), and wires as cheap separate (often transparent) meshes. The CS2 autopsy is a cautionary example: props with no LODs (cables modelled down to keyboards, 17K to 100K vertices) and every object casting shadows (72% of draw calls in the shadow pass).

### Cited Findings
- Cities: Skylines 1 After Dark: Colossal Order "turn[ed] all prop assets which are expected to emit light into assets emitting light". Street lamps and poles are named as heavily used in custom assets, and building windows were lit with texture-based "illumination maps" rather than real lights — [Paradox forum, After Dark Dev Diary 2](https://forum.paradoxplaza.com/forum/threads/cities-skylines-after-dark-dev-diary-2-whats-new-with-modding.878916/page-2)
- CS1 community light mods: the older "LightEffect" mod is reported as leaking memory and crashing, and users point to boformer's Custom Effects Loader instead. This suggests CS1 light emission is attached to props through an "effects" system — [Steam Workshop comments](https://steamcommunity.com/sharedfiles/filedetails/comments/477706051)
- Cities: Skylines 2, from a RenderDoc teardown by Paavo Huhtala:
  - "Almost every draw call uses instancing". One large instance data buffer holds all objects, with about 50 floats per building instance and more for roads. The buffer starts around 60 MB.
  - The sample frame had 6,705 draw calls, 4,828 of them (72%) in the shadow pass, because every object is treated as a potential shadow caster at all quality settings.
  - Only frustum culling, no occlusion culling. Distance culling is "not aggressive".
  - Many small props have no LODs: parking booth over 40K vertices with individually modelled cables, clotheslines about 25K to 30K vertices, pile of logs over 100K. For comparison, a low-density house is under 10K.
  - Power lines are transparent objects drawn in the transparent pass after rain, which causes overlap artifacts.
  - Deferred lighting resolve takes about 2.1 ms. SSGI and SSR together take about 3 ms at half resolution.
  - Source: [Paavo Huhtala, "Cities: Skylines 2 performance" autopsy](https://blog.paavo.me/cities-skylines-2-performance/)
- CS2 patch 1.0.12f1 reportedly improved how certain types of lights are handled, changed small and large object rendering and improved shadow LOD. This comes from secondary coverage — [PCGamesN](https://www.pcgamesn.com/cities-skylines-2/performance-blog); [3DTested summary](https://www.3dtested.com/pc-components/gpus/cities-skylines-2-performance-autopsy-highlights-massive-optimization-failures)
- GTA V, from Adrian Courrèges' frame study:
  - Deferred renderer. At night, "lights and their irradiance would also now be added one by one" during the G-buffer combine.
  - An irradiance-map channel stores emissive, "non-zero for neon, light bulbs".
  - Bloom: bright-pass at an exposure-derived threshold, downscale to 1/16, blur, upscale to half resolution, added before Uncharted 2 tonemapping. Eye adaptation runs over several frames.
  - A compute pass picks visibility and LOD per object by distance, and LOD transitions use dithered "alpha stippling".
  - Source: [Courrèges, GTA V Graphics Study](https://www.adriancourreges.com/blog/2015/11/02/gta-v-graphics-study/)
- Transport Fever 2: the catenary is defined as part of the track definition, so replacing it means editing the track file rather than swapping a mesh. Community trolleybus wire mods ship modular wire models with enlarged hitboxes — [Steam Workshop comment](https://steamcommunity.com/sharedfiles/filedetails/comments/3190656702); [TCM changelog](https://steamcommunity.com/sharedfiles/filedetails/changelog/3335252327)
- Unreal City Sample (Matrix Awakens) relies on Nanite geometry and Lumen GI/reflections (hardware ray tracing), with Mass AI for traffic and crowds. I found no official public description of how its street lamps are lit — [Epic docs, City Sample](https://dev.epicgames.com/documentation/unreal-engine/city-sample-project-unreal-engine-demonstration)

### Inferences
- For WebGL2, the CS1 After Dark model maps directly onto three.js: emissive lamp heads plus bloom, emissive window masks, and real lights only for a few nearby lamps. Lumen-style GI and per-lamp deferred lights (GTA V) do not port to three.js forward WebGL2 at thousands of lamps.
- Lessons from CS2 to apply in this project:
  - Every prop gets an LOD chain whose last level is a few triangles or an impostor card.
  - Small props such as poles, signs and wires never cast shadows beyond a short distance, or never at all.
  - Wires do not go through a sorted transparent pass. Draw them opaque, with alpha-to-coverage for the sub-pixel fade.
- GTA's dithered LOD crossfade can be done in a three.js `onBeforeCompile` fragment hook: discard on a screen-space Bayer pattern against a per-instance fade value. This avoids transparency sorting.

### Gaps
- No primary source found for RDR2 or Watch Dogs street-light and wire rendering. Searches hit general coverage only, and the GTA V study parts 2 and 3 were not fetched.
- No measured street-light count or per-lamp cost for CS2.
- No Epic talk read on City Sample lamp lighting (whether it uses Lumen emissive, MegaLights or baked).
- Transport Fever 2 wire mesh internals (tube vs. ribbon, LOD) are not documented in what I found.

## 2. Phone-wire anti-aliasing (Persson / Humus) and minimum pixel width

### Takeaway
Clamp the wire's projected radius so it is never under about 1 pixel wide, and multiply its coverage (alpha) by the ratio of true width to clamped width. Example: a wire that should be 0.5 px wide is drawn 1 px wide at 0.5 coverage. It is meant to be paired with MSAA, which handles the jaggies. The cost is a few vertex-shader ALU ops plus the blending/A2C path. three.js `LineMaterial` already gives a pixel-width screen-space quad with `alphaToCoverage`, which makes it the natural WebGL2 carrier for this technique.

### Cited Findings
- Humus (Emil Persson):
  - The technique adjusts "the radius of the wire to make sure it does not get smaller than a pixel wide" and fades the wire by the radius reduction ratio, e.g. a half-pixel wire drawn at one pixel with 0.5 coverage.
  - MSAA alone only "pushes the problem a factor further into the distance". The technique does not fix jaggies, so it is combined with MSAA.
  - The author suggests (untested) it would extend to antenna towers, pipes and railings.
  - The demo is DX10. No performance figures are given on the page.
  - Source: [Humus, Phone-wire AA](https://www.humus.name/index.php?page=3D&ID=89)
- The technique was published as Emil Persson, "Wire Antialiasing", GPU Pro 5, pp. 211–218 (ed. Wolfgang Engel) — [Game Engine Gems DB entry](https://www.gameenginegems.com/gemsdb/article.php?id=1223); [O'Reilly GPU Pro 5 chapter](https://www.oreilly.com/library/view/gpu-pro-5/9781482208641/chapter-52.html)
- A secondary note on the chapter warns that clamping to one pixel makes distant wires look thicker than they should. This is why the coverage fade is essential — [geeks3d coverage](https://geeks3d.com/?p=8334)
- three.js `LineMaterial` (used by `Line2` / `LineSegments2`):
  - `linewidth` is in CSS pixels by default. `worldUnits: true` interprets width and dashes in world units.
  - `alphaToCoverage` "can improve anti-aliasing of line edges when using MSAA".
  - `resolution` must be the viewport size. `LineSegments2.onBeforeRender` keeps it up to date.
  - WebGLRenderer only. WebGPU uses `Line2NodeMaterial`.
  - Source: [three.js docs, LineMaterial](https://threejs.org/docs/pages/LineMaterial.html)

### Inferences
- How `LineSegments2` draws (my knowledge of the implementation, to be checked against `examples/jsm/lines/LineMaterial.js` in r186): each segment is an instanced quad with `instanceStart`/`instanceEnd` attributes, expanded in clip space in the vertex shader. A Persson-style wire shader would sit on top of this:
  ```glsl
  // pixelRadius = worldRadius * projScale / clipW  (projScale = 0.5 * viewportHeight * projectionMatrix[1][1])
  float px = max(pixelRadius, 0.5);          // never under 1 px total width (radius 0.5 px)
  float fade = pixelRadius / px;              // coverage ratio (1 when the wire is wide enough)
  // expand the quad by px; in the fragment shader: alpha *= fade; output via alphaToCoverage (or premultiplied blend)
  ```
  The physical width comes from world units (wire radius about 0.01–0.02 m). The pixel clamp only takes over in the distance.
- Wire rendering options compared:
  - **GL_LINES / `THREE.Line`**: 1 px only in WebGL2 (`lineWidth` > 1 is unsupported on most platforms), no AA control. Usable as the farthest LOD but cannot fade properly.
  - **Tube geometry (TubeGeometry/extruded)**: costs 6–8 sides × N segments × 2 triangles per span. It aliases into dotted lines at distance, which is exactly the failure Persson describes. Only worth it for close-up hero cables.
  - **Camera-facing ribbon / shader-expanded quad** (LineSegments2 or a custom InstancedBufferGeometry): 2 triangles per segment, constant cost, works with the pixel clamp. This is the recommended default.
  - **Static mesh with A2C**: avoids transparency sorting, which is what caused CS2's overlap artifact. It needs an MSAA render target. three.js `WebGLRenderTarget` has `samples`; EffectComposer users must set it.
- Cost estimate (inferred): 2,000 spans × 16 segments × 2 triangles = 64K triangles in 1 draw call, which is negligible on the GPU. CPU cost is zero after build if the catenary points are baked once per span and the geometry is static.

### Gaps
- I did not read the GPU Pro 5 chapter text. Exact shader code and measured cost are unverified.
- No benchmark found comparing LineSegments2 against custom ribbons at city scale.

## 3. Catenary math and tessellation for overhead wires

### Takeaway
For ends at equal height, use y = a·cosh(x/a). Solve the parameter a from span and sag (or span and length) with a few Newton iterations, then sample 8–16 points per span. For small sag (sag/span under about 5%), the parabola y ≈ 4h·t(1−t) (t ∈ [0,1]) is visually identical and needs no solve. With unequal pole heights, add the linear interpolation between the attachment points; this is the usual, slightly inexact shortcut.

### Cited Findings
- Catenary formulas:
  - y = a·cosh(x/a). Arc length s = a·sinh(x/a). Length between x₁ and x₂: L = a[sinh(x₂/a) − sinh(x₁/a)].
  - For span H with equal-height ends: L = 2a·sinh(H/(2a)), sag h = a(cosh(H/(2a)) − 1), and a = (L²/4 − h²)/(2h) when L and h are known.
  - With height difference v, a solves √(L² − v²) = 2a·sinh(H/(2a)), numerically, with at most one positive root.
  - Source: [Wikipedia, Catenary](https://en.wikipedia.org/wiki/Catenary)
- Small-sag limit: cosh(x/a) ≈ 1 + x²/(2a²), a parabola. Galileo noted a hanging cord is nearly parabolic at low elevation angles — [Wikipedia, Catenary](https://en.wikipedia.org/wiki/Catenary)

### Inferences
- Recommended tessellation, by screen size:
  - About 16 segments per span for near LOD, 4–8 for mid LOD.
  - At far LOD a single straight segment suffices. Sag under 1 px is invisible. Projected sag ≈ h·projScale/distance; switch LOD when that drops below about 1 px.
- Wind sway can be added in the vertex shader with an offset ∝ sin(time + spanPhase)·4t(1−t), so CPU geometry stays static.
- Data layout: one InstancedBufferGeometry of N segments per span, with per-instance attributes (p0, p1, sag, radius, color). The vertex shader evaluates the curve, so all wires in the city are one draw call and edits only rewrite one instance's attributes.

### Gaps
- No game-specific source found for how CS2 or TF2 parameterize sag. Values like sag of 1–3% of span are engineering conventions I did not verify with a source.

## 4. Instancing, batching and LOD in three.js r150+ (InstancedMesh, BatchedMesh, culling, budgets)

### Takeaway
- Use **BatchedMesh** when many prop types share one material and you want per-instance frustum culling, per-instance geometry swaps (`setGeometryIdAt`, which gives per-instance LOD) and sorting, all in one multi-draw call.
- Use **InstancedMesh** for huge counts of one geometry (e.g. lamp posts), where culling happens per mesh (chunk the city into tiles).
- The official `webgl_batch_lod_bvh` example renders 500K instances with 5 LODs per geometry using BVH culling, through the three.ez extensions.

### Cited Findings
- BatchedMesh API:
  - Constructor `BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount = maxVertexCount*2, material)`.
  - Methods: `addGeometry(geometry, reservedVertexCount, reservedIndexCount)`, `addInstance(geometryId)`, `setGeometryIdAt(instanceId, geometryId)`, `setVisibleAt`, `setMatrixAt` (negative scale not supported), `setColorAt`, `optimize()`, `setInstanceCount`, `setGeometrySize`, `deleteInstance`, `deleteGeometry`.
  - `perObjectFrustumCulled` defaults to true. `sortObjects` defaults to true (front-to-back for opaque, back-to-front for transparent). `customSort(list, camera)` is available.
  - Uses "multi draw batch rendering" to reduce draw calls.
  - Source: [three.js docs, BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html)
- Official example `webgl_batch_lod_bvh`: BatchedMesh with 10 geometries and 500K instances, 5 LODs per geometry (4 generated with meshoptimizer), with TLAS/BLAS BVHs for frustum culling and raycasting — [three.js example](https://threejs.org/examples/webgl_batch_lod_bvh.html)
- `@three.ez/batched-mesh-extensions`:
  - BVH over instance bounds for culling and raycasting, suited to mostly static instances. Update API: `bvh.insert/move/delete`, with a `margin` trade-off.
  - Distance-based LOD via `addGeometryLOD(geometryId, geometryLOD, distance)`. Current restriction: "only LODs that share the same geometry vertex array can be added".
  - Per-instance uniforms (`initUniformsPerInstance`, `setUniformAt`), WebGLRenderer only.
  - Source: [GitHub agargaro/batched-mesh-extensions](https://github.com/agargaro/batched-mesh-extensions/)
- `@three.ez/instanced-mesh` (InstancedMesh2) adds per-instance frustum culling, BVH, sorting, visibility management and LOD to InstancedMesh — [three.js forum announcement](https://discourse.threejs.org/t/three-ez-instancedmesh2-enhanced-instancedmesh-with-frustum-culling-fast-raycasting-bvh-sorting-visibility-management-lod-skinning-and-more/69344)
- Known caveats:
  - Per-instance culling costs CPU, since default culling iterates all instances and a BVH fixes that — [webgl_batch_lod_bvh](https://threejs.org/examples/webgl_batch_lod_bvh.html)
  - A forum report describes a multidraw performance bottleneck in WebGL — [three.js forum, BatchedMesh per-instance data](https://discourse.threejs.org/t/how-can-i-use-datatexture-for-batchedmesh-to-access-per-instance-data-in-shader/72996)
  - The PR discussion notes matrix/orientation cost for per-instance culling — [three.js PR #28404](https://github.com/mrdoob/three.js/pull/28404)
- Impostors (farthest LOD):
  - The octahedral impostor technique originates with Ryan Brucks (Fortnite/UE4, 2018). It has three.js implementations, including a 2025 library with full and hemi-octahedron modes and mip-safe margins, used as LOD beyond about 100 units for trees — [three.js forum, Octahedral Impostors for three.js](https://discourse.threejs.org/t/octahedral-impostors-for-three-js/80318); [A forest of octahedral impostors](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735.md)
  - Hemi-octahedron covers only the upper hemisphere, giving more resolution at side views. It suits games where you never view from below — [Unity Industry Toolkit, Create impostors](https://docs.unity3d.com/ja/Packages/com.unity.industry.toolkit%403.0/manual/create-impostors.html); [Godot Octahedral Impostors](https://github.com/SIsilicon/Godot-Octahedral-Impostors)
  - The octahedral mapping is liked because it distributes directions fairly uniformly without trigonometry — [velog UE tutorial](https://velog.io/@imeamangryang/Unreal-Engine-Octachedral-Impostor)
- GTA V uses a GPU (compute) visibility and LOD pass per object with dithered transitions — [Courrèges](https://www.adriancourreges.com/blog/2015/11/02/gta-v-graphics-study/)

### Inferences
- Pick LOD by **projected screen size**, not raw distance. Projected height in px ≈ boundingRadius·2·projScale/distance, with projScale = 0.5·viewportHeight·P[1][1]. Suggested thresholds (my engineering inference, not sourced):
  - LOD0 when the prop is over about 150 px tall.
  - LOD1 at 40–150 px.
  - LOD2 at 10–40 px.
  - Impostor, cross-quad or "stick" (one or two quads) at 2–10 px.
  - Cull under about 1–2 px, except wires, which use the Persson clamp.
- `setGeometryIdAt` lets the app do per-instance LOD itself with plain BatchedMesh: recompute per tile, not per instance per frame.
- Suggested triangle budgets (inference, typical for city builders):

  | Prop | LOD0 | LOD1 | LOD2 | Far LOD |
  |---|---|---|---|---|
  | Street light | 300–800 | about 100 | about 20 | 1 quad + glow sprite |
  | Traffic light | 500–1,500 (heads) | about 150 | about 30 | — |
  | Sign | 12–40 (plate box + pole) | — | — | Plate merged into pole quad |
  | Utility pole | 200–600 | — | about 12 (prism) | — |

  The CS2 counterexample of 17K–100K-vertex props shows the cost of skipping this.
- At thousands of props, CPU culling cost dominates before GPU cost does. Cull per city tile (one BatchedMesh or InstancedMesh per tile, or a BVH), and keep instance matrices static.
- Lamp posts with a single geometry suit InstancedMesh. Mixed prop families sharing one material and atlas suit BatchedMesh.

### Gaps
- Exact r186 behaviour of BatchedMesh's fallback when `WEBGL_multi_draw` is missing is not stated in the docs page. It needs checking in the `WebGLRenderer` source.
- No published three.js benchmark of BatchedMesh vs. InstancedMesh at 10K–100K props with LOD switching.
- The shaderbits article body (frame counts like 12×12 or 16×16, 3-frame blend, depth-offset parallax) could not be read. Those details are unverified here.

## 5. Street-light emission without many real lights (emissive + bloom, glow sprites, ground decals, clustered limits, lightmaps, probes)

### Takeaway
In three.js WebGL2, real point or spot lights are a per-fragment loop over every light (all materials share the list), and shadowed lights consume texture units. Since r182, about 5 shadowed point lights already trigger texture-unit warnings. The scalable recipe:
1. Emissive lamp heads (plus emissive masks for windows and traffic-light lenses) driven by a per-instance or time-of-day uniform.
2. HDR bloom.
3. An instanced, camera-facing glow sprite per lamp, with a distance-based size clamp so distant lamps read as points.
4. An additive "light pool" decal or projected texture on the road under each lamp, instanced quads sampling a radial falloff (a fake cookie).
5. Real lights only for the N closest lamps, or none at all.

Clustered/Forward+ lighting in three.js is a WebGPU addon (up to 1024 point lights by default), not WebGL2.

### Cited Findings
- three.js clustered lighting:
  - The `ClusteredLighting` addon overrides the default lighting in **WebGPURenderer**, defaulting to max 1024 point lights and 32 px tiles — [three.js docs, ClusteredLighting](https://threejs.org/docs/pages/ClusteredLighting.html)
  - `ClusteredLightsNode` implements Forward+ clustered shading with a default per-cluster capacity of 64 — [three.js docs, ClusteredLightsNode](https://threejs.org/docs/pages/ClusteredLightsNode.html)
- Classic WebGL forward rendering: every shaded pixel iterates every light and all materials share one light list. The advice is to cap NUM_POINT_LIGHTS and pass only the closest lights, since Forward+ normally needs compute shaders that WebGL lacks — [three.js forum, Optimizing Point Lights](https://discourse.threejs.org/t/optimizing-point-lights/36153)
- Texture-unit limit after the r182 shadow rewrite: with 5 or more shadowed point lights the console fills with too-many-texture-units warnings. On r181 about 10 lights worked — [three.js forum, Max texture units in r182](https://discourse.threejs.org/t/max-texture-units-in-threejs-r182/88721)
- Clustered shading is possible in WebGL by binning lights into frustum clusters stored in textures, as in a student implementation — [UPenn CIS565 WebGL Clustered/Forward+](https://github.com/clach/Project6-WebGL-Clustered-Deferred-Forward-Plus)
- Emissive + bloom precedent: GTA V stores emissive for "neon, light bulbs" in the irradiance buffer and blooms bright pixels pre-tonemap — [Courrèges](https://www.adriancourreges.com/blog/2015/11/02/gta-v-graphics-study/)
- CS1 After Dark used emissive light props and illumination maps for windows — [Paradox dev diary](https://forum.paradoxplaza.com/forum/threads/cities-skylines-after-dark-dev-diary-2-whats-new-with-modding.878916/page-2)
- CS2's GI (SSGI) is "only really impressive at night" and is commonly disabled for frame rate. This is a guide's opinion, not a measurement — [hard-drive.net CS2 performance guide](https://hard-drive.net/guides/cities-skylines-2/cities-skylines-2-performance-issues-how-to-fix/)

### Inferences
- **Light pools on the ground (best value per cost)**:
  - One InstancedMesh of flat quads (or the ground shader sampling a "lamp density" texture) with additive blending, `depthWrite: false` and polygonOffset.
  - Radial or elliptic falloff texture, tinted by lamp color, scaled by a night factor.
  - Cost: 2 triangles per lamp, one draw call, fill-rate bounded.
  - Alternative: accumulate lamp splats into a top-down "night light map" render target (e.g. 1 texel ≈ 0.5–1 m per city tile), sampled by ground, road and building-base shaders. This bakes thousands of lamps into one texture fetch, re-rendered only when roads change. It is effectively a dynamic lightmap and also lights the sides of nearby props if sampled with height attenuation.
- **Glow sprites**: an instanced billboard per lamp head. Size = max(worldSize, minPixels·distance/projScale), the same min-pixel trick as the wires, so lamp lines stay visible kilometres away. Depth-test them, but offset toward the camera. Fade by view angle for cutoff luminaires.
- **Emissive**: per-instance emissive intensity via BatchedMesh `setColorAt` alpha, or per-instance uniforms (three.ez). Bloom via `UnrealBloomPass` or a mip-chain bloom. Needs HDR (HalfFloat) targets and tonemapping in the output pass.
- **Real lights**: keep 0–8 unshadowed `PointLight`/`SpotLight` objects and reassign them each frame to the nearest lamps (pool pattern). Material light counts are compiled into shaders, so keep the count constant to avoid recompiles. Never give lamps shadows.
- **Light probes / hemisphere**: a night `HemisphereLight` or a LightProbe with a city-glow tint gives ambient. Per-district probes would need custom shader sampling, since three.js r186 core uses a scene-global probe. This last point is unverified for r186.
- **Traffic lights**: lens state (R/Y/G) as a per-instance attribute selecting the emissive mask. The same glow-sprite system covers them at distance.

### Gaps
- I did not verify current three.js r186 status of `LightProbeGrid` or a volumetric probe addon.
- No primary source read for RDR2, Watch Dogs or GTA distant-light "coronas" or LOD lights.
- No measured fill-rate cost for additive ground-pool quads at thousands of lamps.

## 6. Road signs: textures/atlases vs. geometry; text via SDF

### Takeaway
Signs should be one shared geometry (plate box plus pole) instanced or batched, with the face from a texture atlas (per-instance UV rect as an attribute or a per-instance uniform). Custom text (street names) is best done with SDF/MSDF glyphs: troika-three-text generates SDF atlases on the fly in a worker and patches any three.js material. Each troika `Text` is its own mesh, though, so for thousands of signs prefer baking text into an atlas, or a custom instanced glyph-quad renderer sharing troika's atlas.

### Cited Findings
- troika-three-text:
  - Parses .ttf/.otf/.woff with Typr and generates the SDF atlas for glyphs on the fly as they are used.
  - Builds a geometry of glyph quads and patches any three.js material, so lighting, PBR, shadows and fog still work.
  - Font parsing, SDF generation and layout run in a web worker. Call `.sync()` after layout changes.
  - Source: [troika-three-text README 0.52.4](https://cdn.jsdelivr.net/npm/troika-three-text@0.52.4/README.md); [npm](https://npmjs.com/package/troika-three-text)
- BatchedMesh `setColorAt` accepts a Vector4 with alpha, and per-instance uniforms are available through three.ez. Either can carry a per-instance atlas index — [three.js docs, BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html); [batched-mesh-extensions](https://github.com/agargaro/batched-mesh-extensions/)

### Inferences
- Standard regulatory signs (stop, yield, speed limits) are a fixed set: one atlas texture (e.g. 2048² with 64–128 px cells and mips), one material, per-instance cell index. Text-bearing signs (street names) could be rendered once per unique name into an atlas region with troika, then sampled like any other sign, which avoids thousands of Text meshes.
- SDF keeps text sharp when magnified. At distance, mipmapped plain textures are as good and cheaper. Drop text entirely below about 10 px of sign height (LOD).
- Geometry vs. texture: use geometry only for the silhouette (plate thickness, pole). All face detail goes in the texture. Under 10 px, merge the plate into a one-quad card.

### Gaps
- Not verified whether troika supports instancing many texts in one draw call. The README I saw does not mention it.
- No game source found on how CS2 or TF2 render street-name signs.
