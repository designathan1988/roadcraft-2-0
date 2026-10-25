# Road markings without per-marking polygons (three.js r186 / WebGL2)

Scope: lane lines, dashed lines, crosswalks/zebras, stop lines, arrows, painted words, parking bay lines, cycle lanes. Goal: very large cities, low GPU/memory cost, crisp up close, no shimmer far away.

Research note: ~20 tool calls. The primary sources I actually read are the Nehab & Hoppe 2008 RAVG paper (full text, extracted from the PDF), the Unreal RVT docs page, the msdfgen README, the three.js DecalGeometry source, and Bart Wronski's decal post. The rest come from search results/snippets and are marked that way. I found almost nothing primary on how commercial city builders draw markings. See Gaps.

---

## 1. How do shipped games and engines draw markings?

### Takeaway
The only well-documented engine pipelines are Unreal RVT, where road spline meshes and decals are rasterized top-down into a cached virtual texture, and Far Cry 4's Adaptive Virtual Texturing, which bakes terrain and decals into a virtual texture cache. For Cities: Skylines 1/2, Transport Fever, SimCity and GTA I found no primary technical source. Community evidence for CS1 points to markings living in road-mesh textures, plus a modded decal/mesh layer for junctions.

### Cited Findings
- Unreal RVT "generates texel data on the GPU at runtime" and caches shading over large areas. Typical uses are Landscape shading with decal-like materials and splines that conform to terrain. — [Unreal RVT docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine)
- In RVT, a road spline's mesh can write to the RVT so its material is applied along the spline. Objects are rendered with an orthographic projection in −Z of the volume. The "From Virtual Texture" pass type keeps the mesh out of the main pass. There is no Z-buffering, so draw order uses Translucency Sort Priority (example: spline 1, decal 2). — [Unreal RVT docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine)
- RVT is a cache that "isn't fully updated on every frame", so content written to it should be static. Page uploads are capped per frame (`r.VT.MaxUploadsPerFrame` defaults to 64 in the Editor and 8 in game). Formats: BC1 for base color only, BC3+BC3 for color/normal/roughness/specular. YCoCg costs 25% extra memory. — [Unreal RVT docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine)
- RVT "Virtual Texture Min Coverage" culls a primitive from a mip when its projected size is below a threshold (example value 3 = 8 pixels). That is the built-in way to drop thin markings at far mips. — [Unreal RVT docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine)
- Far Cry 4 (Ka Chen, GDC 2015) used Adaptive Virtual Texturing for terrain and "a large number of decals" in a 10 km × 10 km world, at 10 texels/cm, which is 20× traditional VT. (Abstract via search; slides are GDC Vault members-only.) — [GDC Vault](https://gdcvault.com/play/1021760/Adaptive-Virtual-Texture-Rendering-in); Japanese coverage [game.watch.impress](https://game.watch.impress.co.jp/docs/news/20150308_691757.html)
- An unofficial forum claim says Far Cry 4/5 decals are baked into the virtual texture the first frame they appear, so they cost little afterwards. — [Unreal forum "Spline Decals?"](https://forums.unrealengine.com/t/spline-decals/83966/175) (secondhand, unverified)
- Cities: Skylines 1 road re-texturing uses extra grayscale maps with `_p` and `_r` suffixes (pavement/road maps) next to the main texture. Little official documentation exists. — [Paradox forum thread](https://admin-forum.paradoxplaza.com/forum/threads/cities-skylines-steam-road-editor-matching-textures-help.1059433/post-23594161); road editor diary [Paradox dev diary 8](https://forum.paradoxplaza.com/forum/threads/cities-skylines-green-cities-dev-diary-8-road-modding.1050864/page-2)
- The CS1 mod Intersection Marking Tool adds junction lines, fillers and crosswalk styles ("Zebra", "Double Zebra", "Ladder", "Parallel dashed lines", etc.), plus a line style that writes custom text on the road with any system font. This shows junction markings were not covered by the base road textures. — [IMT changelog (Steam)](https://steamcommunity.com/sharedfiles/filedetails/changelog/2140418403?p=3)
- A CS1 road-mod author removed markings at junctions when retexturing. Another report says markings shifted and no longer matched IMT lines after an asset update, which suggests mesh-texture markings and separately drawn junction markings are kept in sync by hand. — [Steam comments](https://steamcommunity.com/sharedfiles/filedetails/comments/2584861246)
- Generic Unity practice for tiled road textures: derive the V coordinate from road length divided by the metres one texture tile covers. — [Unity discussions](https://discussions.unity.com/t/road-texture-is-stretching/39185)
- Unreal deferred decals render a box around the affected area and write to the G-buffer, so cost is more predictable with many lights. Unity URP draws decals either as meshes over opaque geometry or in screen space, and recommends screen-space decals on tile-based mobile GPUs. — [UE4 Decal Actor docs](https://docs.unrealengine.com/4.26/Basics/Actors/DecalActor); [Unity Decal Renderer Feature](https://docs.unity.com/en-us/engine/6000.0/manual/visual-effects/decals/renderer-feature-decal/reference.md)

### Inferences
- The industry pattern has two layers. Straight-section markings come from textures tiled along the road's UV, which is cheap and mip-mapped. Junction or free-form markings come from decals or a baked/virtual texture. The CS1 evidence (base textures plus a separate junction-marking mod) fits this pattern.
- For a WebGL2 game, a full RVT/AVT system means a feedback pass, a page table, a page cache and per-frame page rendering. That is a heavy engineering investment, and it pays off mostly when terrain detail is also cached.

### Gaps
- No primary source found on how CS2, Transport Fever 1/2, SimCity 2013 or GTA render markings: dev diaries, GDC talks or shader dumps. Searches only returned mod pages. My belief that CS2 uses HDRP decals for markings is unverified, so I do not state it as fact.
- Far Cry 4 slides were not readable (members-only), so I have no road-specific details.

---

## 2. The approaches compared: memory, fill cost, antialiasing, far behaviour

### Takeaway
Analytic evaluation in the road shader is the only approach with near-zero memory, no extra draw calls or overdraw, and exact closed-form antialiasing. It works on (u = distance along, v = offset across) for strips, and on a per-tile primitive list (RAVG-style) for junctions. Its cost is per-pixel ALU, which RAVG measured as compute-bound but practical in 2008. Decals add overdraw and derivative artifacts. Baked or virtual textures cost memory and update latency but are cheapest per pixel.

### Cited Findings

**(a) Geometry strips (current repo approach)**
- Strips need their own vertices, a z-offset, and fill at overlap. (No source needed: this is the baseline.) The project's recent commits already draw dashes as one strip cut by a shader (see git log `a3443ae0`, `8613084a`).

**(b) Mesh/projected decals**
- three.js `DecalGeometry(mesh, position, orientation, size)` transforms the target mesh's triangles into projector space and clips them on the CPU against 6 box planes. It emits new position/normal/uv triangles (uv = 0.5 + x/size.x, 0.5 + y/size.y). The result is a separate mesh per decal. — [three.js DecalGeometry.js source](https://raw.githubusercontent.com/mrdoob/three.js/r168/examples/jsm/geometries/DecalGeometry.js)
- Screen-space deferred decals reconstruct position from depth. At depth discontinuities, rejected pixels in the same 2×2 quad corrupt derivatives (example: ΔUV = 1.5), so a very blurry mip is selected and edges show artifacts. The fixes all have costs: clamping is partial, forced mip 0 aliases, world-space UV decals mip correctly but need authored or CPU-generated geometry, Forward+ decals cost the most at runtime, and derivatives in the G-buffer are hard to maintain. — [Bart Wronski, Fixing screen-space deferred decals](https://bartwronski.com/2015/03/12/fixing-screen-space-deferred-decals/)
- Emil Persson, "Volume Decals", GPU Pro 2 (2011), pp. 115–120 (I did not read it). — [Game Engine Gems DB](https://gameenginegems.com/gemsdb/article.php?id=1107)

**(c) Baked / virtual textures**
- RVT memory comes from a fixed physical page pool (BC-compressed). Updates are throttled (8 uploads/frame in game) and the cache is meant for static content. — [Unreal RVT docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/runtime-virtual-texturing-in-unreal-engine)
- FC4 AVT reached 10 texels/cm. — [GDC Vault abstract](https://gdcvault.com/play/1021760/Adaptive-Virtual-Texture-Rendering-in)

**(d) Analytic procedural evaluation + antialiasing**
- Inigo Quilez's "filterable procedurals" article gives analytically box-filtered checkers, grids, squares and crosses. Each takes the pattern coordinate plus its screen-space derivatives, with filter width taken from the larger derivative. A follow-up notes that the box filter can flicker under camera motion and proposes a triangular kernel at almost the same cost. The band-limiting article uses fwidth to attenuate cosines (sinc-like factor). (Article pages returned 404 to my fetcher, so this comes from search snippets.) — [IQ filterable procedurals](https://iquilezles.org/articles/filterableprocedurals); [IQ more checker filtering](https://iquilezles.org/articles/morecheckerfiltering); [IQ band-limiting](https://iquilezles.org:443/articles/bandlimiting/)
- GPU Gems ch. 25: filter width estimated from screen-space derivatives "will generally overestimate the change", which can overblur. — [GPU Gems ch. 25](https://developer.nvidia.com/gpugems/gpugems/part-iv-image-processing/chapter-25-fast-filter-width-estimates-texture-maps)

**(e) GPU vector textures, Nehab & Hoppe 2008 (read in full)**
- A lattice over the texture domain, with each cell holding a variable-length stream specialized to the primitives overlapping that cell. Streams are concatenated in raster order in a 1D buffer, with a 2D indirection table of start pointers. Identical streams (e.g. constant colour) are coalesced and shared. — [Nehab & Hoppe 2008, RAVG](https://hhoppe.com/ravg.pdf) §6
- Encoding: each layer starts with a 32-bit RGBA header (flags Last/Stroke/Fill/Gradient, stroke width in alpha), followed by cell-local (x, y) coordinates quantized to 16 bits, with one bit per coordinate used as a tag (Moveto/Drawto/Curvepoint/Last). Words per layer: constant colour 1, 1 line segment 3, 2 segments 4–5, 3 segments 5–7, 1 quadratic 4, 3 quadratics 8–10. — [RAVG](https://hhoppe.com/ravg.pdf) Table 1
- Fill uses the winding number from a +x ray. Strokes use distance to segments. Antialiasing is approximate prefiltering per primitive (box, parabolic or Gaussian kernels) plus optional adaptive supersampling (k samples) in one pass, at no extra memory bandwidth. Prefilter + 8 samples is close to ground truth. — [RAVG](https://hhoppe.com/ravg.pdf) §4
- "Extended cells": each cell includes primitives within an overlap band so the prefilter kernel never needs neighbouring cells. Recommended band is 10–20% of cell size. Beyond the minification limit you switch to a mipmap. — [RAVG](https://hhoppe.com/ravg.pdf) §5.1
- Lattice-clipping builds the cells in O(n + r + a). The ~100K-segment examples encode in under 1 s. — [RAVG](https://hhoppe.com/ravg.pdf) §5.3, Table 3
- Results (GeForce 8800 GTX, 720² window): average stream 2.6–19.2 words and max 39–351 words; sizes 16 KB–1.1 MB; 58–381 fps without supersampling and 8–70 fps with k = 8. Shader instruction counts are 117 (linear fill, no prefilter) up to 418 (quadratic + strokes + gradients + supersampling). With rendering disabled and parsing only, fps rose 3–4×, so the method is compute-bound, not memory-bound. Coarse lattices are slower (more primitives per cell). Fine lattices plateau because most cells are constant colour. Stream buffer size grows linearly with lattice resolution and the indirection table quadratically. A quadtree is suggested if needed. — [RAVG](https://hhoppe.com/ravg.pdf) §7, Tables 2–3
- SIMD branching penalty is reduced because neighbouring pixels in the same cell take the same branches. — [RAVG](https://hhoppe.com/ravg.pdf) §7
- Fixed-complexity cell schemes (Sen 2003/04, Ray 2005, Parilov & Zorin 2008, and Qin et al. 2006 with a fixed number of corner features) break where small areas exceed the per-cell budget. RAVG's variable-length cells avoid that. Qin et al. 2008 compute precise distances to curved segments iteratively. — [RAVG](https://hhoppe.com/ravg.pdf) §2

**Glyphs/arrows: SDF, MSDF, Slug**
- Valve (Green 2007): a distance field is generated from a high-resolution image and stored in one channel of a low-resolution texture. It can be drawn with plain alpha test or with shaders for soft edges, outlines and shadows. Single-channel fields round sharp corners. — [Green 2007, Valve PDF](https://cdn.akamai.steamstatic.com/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf)
- MSDF (msdfgen, Chlumský 2015 thesis) uses 3 channels to reproduce sharp corners "almost perfectly". Rendering takes the median(r, g, b), scales by `screenPxRange()`, and clamps to an alpha. For 3D perspective, screenPxRange is computed from UV screen derivatives. It must stay ≥ 1, and below 2 antialiasing likely fails. The example uses `-pxrange 4`. Values are kept linear, not sRGB. MTSDF adds a true SDF in alpha. — [msdfgen README](https://github.com/Chlumsky/msdfgen); [thesis PDF](https://github.com/Chlumsky/msdfgen/files/3050967/thesis.pdf)
- Slug (Lengyel, JCGT 2017) draws glyphs directly from quadratic Bézier outlines on a 2-triangle box. It uses a per-pixel winding number with curves grouped in bands (sorted for early-out), and is pixel-accurate under projective transforms with no textures. HarfBuzz's GPU shader uses a similar band layout. — [JCGT paper](https://jcgt.org/published/0006/02/02/paper.pdf); [Lengyel optimization slides](https://terathon.com/optimizing_glyphs_lengyel.pdf); [HarfBuzz hb-gpu-fragment.glsl](https://flutter.googlesource.com/third_party/harfbuzz/+/HEAD/src/hb-gpu-fragment.glsl)

### Inferences (comparison table)

| Approach | Memory | Fill/ALU | Draw calls | AA / far | Junctions | Fit here |
|---|---|---|---|---|---|---|
| (a) strips | vertices per marking | overdraw on road | batched, but vertex count grows with the city | MSAA only; thin strips shimmer far away | needs per-marking polygons | baseline to replace |
| (b) decals | per-decal mesh (DecalGeometry) or box + depth read | overdraw + depth reconstruction | many | derivative artifacts at edges ([Wronski](https://bartwronski.com/2015/03/12/fixing-screen-space-deferred-decals/)) | good | poor at city scale |
| (c) baked/RVT | page pool, BC-compressed | 1 fetch | none extra | mips → no shimmer; blur up close unless texel density is high | good | high engineering cost in WebGL2 |
| (d) analytic strips | ~0 (per-vertex u, v + a few params) | small ALU | none extra | exact box filter with fwidth; fades to the mean at distance | not for arbitrary shapes | best for lane lines, dashes, edges, cycle lanes, parking dashes |
| (e) RAVG lattice | stream words + indirection (KB–MB) | 100–400 instructions/px | none extra | prefilter + extended cells; mip beyond limit | arbitrary | best for junctions, crosswalks at any angle, stop lines |
| MSDF atlas | one atlas (e.g. 64 glyphs × 32–64 px) | 1–3 fetches | none extra | crisp; needs screenPxRange ≥ 1–2 | — | arrows, words, bike symbol |

- The road surface fragment shader is already running, so (d) and (e) only add ALU to pixels being drawn anyway. No overdraw is added, which is the key reason they beat strips and decals at city scale.
- Far shimmer: box-filtering the 1D stripe profile over the pixel footprint makes a sub-pixel line converge to its average coverage (line width / pixel width × paint colour). That is exactly what a mipmapped texture would give, so the result is stable.

### Gaps
- No measured numbers for any of these in WebGL2/three.js. The RAVG numbers are from 2008 DX10 hardware.
- The IQ article text could not be fetched (404). Formulas below are standard derivations and should be checked against the article.

---

## 3. Encoding markings per tile as shader data (WebGL2 constraints)

### Takeaway
WebGL2 has no SSBO. Use data textures read with `texelFetch`, either RGBA32UI/RGBA16UI integer or RGBA32F. Store a RAVG-style indirection (cell → offset, count) and a primitive pool, and build them on the CPU per road tile with lattice clipping. Keep uniform blocks under the portable 16 KB. Take every derivative (fwidth of road-space coordinates) before any data-dependent loop, and sample glyphs with `textureGrad`.

### Cited Findings
- MAX_UNIFORM_BLOCK_SIZE: the most common reported value is 16384 bytes. Chrome reports 65536, Firefox 16384. An iOS Safari user report says blocks over 255 vec4 caused context loss. Treat 16 KB as portable and query at runtime. — [web3dsurvey](https://web3dsurvey.com/webgl2/parameters/MAX_UNIFORM_BLOCK_SIZE); [WebKit bug 239116](https://bugs.webkit.org/show_bug.cgi?id=239116); [WebKit bug 246388](https://bugs.webkit.org/show_bug.cgi?id=246388)
- Implicit-derivative `texture()` and `dFdx/dFdy` are undefined in non-uniform control flow. The workaround is computing derivatives outside the branch and using `textureGrad()`. — [Khronos forum](https://community.khronos.org/t/extremely-different-behaviour-between-vec3-0-9999-1-0-1-0-and-vec3-1-0-1-0-1-0/104788); [dFdx ES 3.1 ref page](https://registry.khronos.org/OpenGL-Refpages/es3.1/html/dFdx.xhtml); [OpenGL Pipeline vol001_5](https://www.opengl.org/pipeline/article/vol001_5)
- RAVG layout: a 1D stream buffer plus a 2D indirection table. Streams are self-terminating (a Last flag), so no lengths need storing. Coordinates are cell-local and quantized to 16 bits. — [RAVG](https://hhoppe.com/ravg.pdf) §6
- RAVG's empirical trade-off: coarser cells mean more primitives per cell and a slower shader, while finer cells mean a bigger indirection table. — [RAVG](https://hhoppe.com/ravg.pdf) §7, Fig. 16
- WebGL2 adds integer textures, texelFetch, UBOs and more texture formats over WebGL1. — [WebGL2 Fundamentals: what's new](https://webgl2fundamentals.org/webgl/lessons/webgl2-whats-new.html)

### Inferences (concrete encoding proposal)
- **Two marking domains:**
  1. **Strip markings** on road segments, evaluated in road space (u = metres along the centreline, v = signed metres across). Per segment (per instance or vertex attribute) store `profileId` and `u0`. A small RGBA32F data texture `profiles[profileId]` lists the lines across the road: offset v, half-width, colour index, dash period, dash duty, and phase. A 6-lane avenue is about 8 lines, i.e. 8 texels. The shader loops over ≤ N lines with a constant max bound and an early break on count. This covers lane lines, centre double-yellow, edge lines, dashed lanes, cycle-lane edges, parking-lane dash edges, and cycle-lane green fill (a wide "line").
  2. **Junction/free-form markings** on junction polygons and plaza tiles. A world-aligned lattice with cell size about 2–4 m stores primitives: stop line, crosswalk bar set, parking bay T, and arrow or glyph instance. The 10–20% overlap band follows RAVG.
- **Primitive types (one RGBA32F texel pair each):**
  - `SEG` (oriented capsule/box: p0, p1, half-width, colour). Stop lines, bay lines, give-way teeth.
  - `STRIPES` (oriented box + period + duty). One primitive is a whole zebra at any angle: evaluate the local frame, then a box-filtered square wave across the bars. This replaces per-bar polygons.
  - `DASHSEG` (segment + period/duty/phase). Junction guide lines.
  - `GLYPH` (oriented box + atlas rect): an arrow, a word glyph or the bike symbol, sampled from the MSDF atlas with `textureGrad`.
- **Textures:** `cellIndex` is RG16UI/RG32UI (offset, count) per cell. A city of 10 km² at 4 m cells is about 625k cells × 8 B ≈ 5 MB. Most cells are empty, so a per-tile sparse indirection is better: a 64×64 m tile at 2 m cells is 32×32 = 1024 cells, about 8 KB. `primPool` is RGBA32F, with 2 texels (32 B) per primitive. A junction with 4 crosswalks, 4 stop lines and 6 arrows is about 14 primitives (~0.5 KB), referenced from about 10–30 cells.
- **Cap per cell:** pick a fixed loop bound (e.g. 8–16) and enforce it at build time. If a cell overflows, subdivide it or store a "complex" flag. RAVG's variable-length streams work because DX10 had linear buffers. In WebGL2, a texture row plus offset/count does the same.
- **Derivative discipline:** compute `fw = fwidth(roadUV)` and `dUVdx/dUVdy` once at the top of the shader. Pass them into every primitive evaluation and apply the box filter analytically. Never call `texture()` with implicit derivatives inside the loop: use `textureGrad(atlas, glyphUV, dGx, dGy)`, with gradients transformed by the primitive's 2×2 local matrix.
- **Box-filtered stripe (standard derivation, verify against IQ):** for a line of half-width h at offset c across v, coverage = clamp((h − |v − c|)/w + 0.5, 0, 1), with w = fwidth(v). Better, use the exact 1-D box integral: coverage = (F(v + w/2) − F(v − w/2))/w, where F is the integral of the step profile. For dashes along u with period P and duty d, use the integral of the square wave, `I(x) = floor(x/P)*d*P + min(fract(x/P)*P, d*P)`, filtered as (I(u + wu/2) − I(u − wu/2))/wu. The product gives the 2-D coverage. As w grows past the period, this tends to d (the mean), so there is no shimmer.
- **Fade to texture far away:** when fwidth(roadUV) exceeds about 0.5 m/px, skip the lattice loop and use the mean colour per primitive cell. That is a constant-colour cell, like RAVG's 1-word cells, or a small baked mip.

### Gaps
- No published WebGL2 implementation of RAVG was found. Loop bounds and branching cost on mobile GPUs are unmeasured.
- I did not verify the exact GLSL ES 3.00 spec section text on derivatives or uniform control flow (secondary sources only).
- Data texture max size (MAX_TEXTURE_SIZE) and float-texture filtering support were not researched here. Integer and float textures fetched with texelFetch do not need filtering.

---

## 4. Text, arrows and junction markings

### Takeaway
Use one MSDF (or MTSDF) atlas holding the arrow set, bike/bus/disabled symbols and the road-legend alphabet ("STOP", "BUS", "SLOW"). Sample it inside the road/junction shader through `GLYPH` primitives using `textureGrad`. Draw crosswalks at any angle analytically: one oriented `STRIPES` primitive, filtered with a box-filtered square wave. Use Slug-style outline evaluation only if MSDF corners or resolution prove insufficient.

### Cited Findings
- MSDF reproduces sharp corners that single-channel SDF rounds, and it needs screenPxRange ≥ 1 (ideally ≥ 2) to antialias. In 3D, compute it from UV derivatives. — [msdfgen README](https://github.com/Chlumsky/msdfgen)
- Valve SDF: low-resolution distance textures give crisp magnified edges via an alpha threshold, plus outline effects. — [Green 2007](https://cdn.akamai.steamstatic.com/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf)
- Slug is texture-free and exact under projection, but needs per-pixel curve loops in bands. — [Lengyel JCGT 2017](https://jcgt.org/published/0006/02/02/paper.pdf)
- RAVG handles filled shapes (winding number) and strokes in the same cell stream. This could encode arrows as real vector paths instead of atlas glyphs, at 3–10 words per layer. — [RAVG](https://hhoppe.com/ravg.pdf) Table 1
- CS1's IMT mod offered crosswalk styles (Zebra, Double Zebra, Ladder, Parallel solid/dashed lines, Solid) and custom text in any system font. That is a reference feature list for junction markings. — [IMT changelog](https://steamcommunity.com/sharedfiles/filedetails/changelog/2140418403?p=3)

### Inferences
- Road legends are stretched about 2.5–5× along the travel direction in real road marking practice (not sourced here; check the national standard used by the project). Do this with the GLYPH primitive's anisotropic local matrix. MSDF remains correct under affine stretch, given screenPxRange from the true derivatives.
- Crosswalks at arbitrary angles: the primitive's frame is the crosswalk's (along the crossing, across the road). The bars come from a square wave along the road tangent. Arbitrary junction angles then need no new geometry.
- Turning arrows: place GLYPH primitives in lane frames at build time (lane centre, heading), in the lattice cells they overlap.

### Gaps
- No source for exact legend proportions or arrow shapes for the target country.
- No measured MSDF atlas size or quality for road legends at grazing angles. Grazing angles stress the anisotropic footprint, and the msdfgen README only covers screenPxRange in general.

---

## Recommended design (synthesis; inference, not sourced fact)

1. **Remove marking polygons from road segments.** In the road surface shader, evaluate a per-road-type **cross-section profile** (data texture) in (u, v) road space. Use analytic box-filtered lines and dashes (IQ-style filter width from `fwidth`). This covers lane, centre, edge, dashed, cycle-lane and parking-edge lines. Extra memory is about 16 B per line per profile. The segment mesh needs `u` (metres along) and `v` (metres across) attributes, which most road meshes already have as UVs.
2. **Junctions, crosswalks, stop lines, bays, arrows, words:** use a **per-tile RAVG-style lattice** (2–4 m cells, 10–20% overlap band, ≤ 8–16 primitives per cell). The CPU encodes it into an `RG32UI` cell index plus an `RGBA32F` primitive pool and rebuilds a tile only when its roads change. RAVG encodes ~100k segments in under 1 s, so a single junction update is trivial. The junction surface shader reads it.
3. **Glyphs:** one MSDF/MTSDF atlas, sampled with `textureGrad` and gradients computed outside the loop.
4. **Far LOD:** once the pixel footprint exceeds about 1 cell, skip the loop. Use the per-cell average colour or per-profile mean, so markings fade to a stable average with no shimmer.
5. **Optional later:** a baked per-tile marking texture cache (a poor-man's RVT) for distant tiles, if the profiling shows the ALU is too costly on low-end GPUs.
