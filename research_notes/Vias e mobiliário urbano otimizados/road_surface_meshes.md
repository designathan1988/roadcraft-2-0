# Road surface meshes: how production games and road tools build and optimize them (for three.js r186 / WebGL2)

Research scope note: about 20 search/fetch calls. Several primary sources could not be fetched (Paradox forum dev diary #8 returned HTTP 500; Galin 2010 PDF connection refused; Eurographics diglib 403; Galin 2011 PDF too large). Claims below are only those the fetched or search-surfaced sources support; everything else is in Inferences or Gaps.

## 1. How do Cities: Skylines 1/2, SimCity 2013, Transport Fever, EasyRoads3D, CiDy, Unity Splines/RoadArchitect, Unreal spline meshes / Landscape splines build road segment meshes?

### Takeaway
The dominant production pattern is "author a short straight mesh stub (segment, and a separate node/junction stub), then bend it along a curve at runtime" (CS1, Unreal Spline Mesh / Landscape Splines), or "extrude a cross-section along a spline" (EasyRoads3D, Unity Splines-style tools). None of the confirmed sources builds road surfaces by polygon union + general triangulation.

### Cited Findings
- CS1 road segments are a straight stub, typically 64 units long and 16–32 units wide; "Segments and nodes are straight stubs. The game bends and matches them automatically." — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor)
- CS1 meshes must be modelled grid-like, with a centre line parallel to the length "so the game has vertices to move"; aligned along the z axis and centred on the origin; pavement 0.3 units high with road at y=0. A wrong segment length causes clipping/z-fighting when segments tile. — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor)
- CS1 has separate node (junction) meshes; a node must have exactly one edge on each side of the centreline between the sidewalks at its end, or it may not snap; too many edges connected to other roads can cause terrain holes. Nodes "are heavily stretched and bent", so diffuse detail should be avoided there. — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor)
- CS1 flags: "Max Turn Angle" decides when a node is used instead of a segment; "Enable Bending Nodes", "Enable Bending Segments", "Disable Bend Nodes". — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor)
- CS1 UVs: textures stretch along V; the game scrolls UVs along V to avoid texel stretching; magenta vertex colour (255,0,255) disables this per vertex (e.g. fence posts). Vertex colours require FBX (OBJ drops them). — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor); mirrored in [biligame CS wiki](https://wiki.biligame.com/csl/?curid=725)
- CS1 road material uses masks (_p pavement, _r road, _a alpha) so the shader generates "automatic, uniform texturing across road types"; the Basic shader mixes terrain textures into pavement/alpha areas and has shadows optimized for ground level; Bridge shader always produces pavement on pavement-mapped areas. — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor)
- Unreal `USplineMeshComponent`: "a Static Mesh Component that can be deformed using a spline. Only a start and end position (and tangent) can be specified." — [Epic API docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/USplineMeshComponent)
- Unreal `FSplineMeshParams` "is passed to the renderer to deform a UStaticMesh"; contains start/end position, tangent, roll, scale, offset in component space; `SplineUpDir` defines the frame. — [UE 4.26 FSplineMeshParams](https://docs.unrealengine.com/4.26/en-US/API/Runtime/Engine/Components/FSplineMeshParams/index.html); [UE Python SplineMeshParams](https://docs.unrealengine.com/5.0/en-US/PythonAPI/class/SplineMeshParams.html) (also lists a Nanite bounds scale for culling after deformation).
- Unreal Landscape Splines: control points + segments (cubic, tangent length per end); meshes assigned per segment with "Scale to Width", Forward/Up axis, Offset, random mesh choice by seed. — [UE Landscape Splines](https://dev.epicgames.com/documentation/unreal-engine/landscape-splines-in-unreal-engine)
- EasyRoads3D builds a road object from markers (a spline), with side objects (meshes placed/extruded along the road: lampposts, barriers, retaining walls) and terrain deformation. — [EasyRoads3D V3 manual mirror: side objects](https://nlp.fi.muni.cz/aiproject/ui/hutta_peter2019/pa026-project/Assets/EasyRoads3D/html/side_objects.html), [creating roads](https://nlp.fi.muni.cz/aiproject/ui/hutta_peter2019/pa026-project/Assets/EasyRoads3D/html/creating_roads.html)
- CS2 (Colossal Order) separates "roads" from the "road tool": roads are upgraded/modified after placement (Replace tool adds trees, grass, wider sidewalks, sound barriers), so few static variants are needed; roads auto-adjust to terrain elevation; roundabouts with arbitrary connection counts required a rewrite vs CS1, and "it's more about the visual representation that required a huge amount of work". — [Game Developer, How Colossal Order turned roads into the backbone of CS2](https://www.gamedeveloper.com/design/how-colossal-order-turned-roads-into-the-backbone-of-cities-skylines-ii); [Paradox CS2 road tools feature page](https://paradoxinteractive.com/games/cities-skylines-ii/features/road-tools)
- CS2 diary #1 lists cut-and-fill construction, intersections built over existing roads, elevated crossings, ramps with acceleration/deceleration lanes. — [Paradox forum, Dev Diary 1 Road Tools](https://admin-forum.paradoxplaza.com/forum/developer-diary/development-diary-1-road-tools.1590300/page-6); [TechRaptor summary](https://techraptor.net/gaming/news/cities-skylines-2-dev-diary)
- Galin et al. 2010 "Procedural Generation of Roads" (CGF 29(2):429–438): path by weighted anisotropic shortest path (slope, rivers, lakes, forests in the cost); then terrain is excavated along the path and "generic parameterized models" are instantiated for road geometry. — [Eurographics diglib record](https://diglib.eg.org/items/0aba12a9-bdbc-43a2-982c-5d1a9a43a2ba), [PDF](https://perso.liris.cnrs.fr/egalin/Articles/2010-roads.pdf) (PDF not fetched; from search abstract). Follow-up: [Authoring Hierarchical Road Networks, 2011](https://www.cs.purdue.edu/homes/bbenes/papers/Galin11CGF.pdf).

### Inferences
- The CS1 rule "grid-like mesh with vertices along the length so the game can move them" implies per-vertex bending of a template mesh along the segment's curve (CPU or vertex shader); the exact implementation (CPU vs shader, Bezier control points as uniforms) was not confirmed by any fetched source.
- For three.js: the "template stub bent along a cubic Bezier" pattern maps directly onto a custom vertex shader (onBeforeCompile / ShaderMaterial) with the 4 control points + width per instance (InstancedMesh attributes or BatchedMesh per-instance data texture). One template geometry serves thousands of segments → tiny memory, one draw call per material, and rebuild cost on edit is O(1) (update 4 points). Junctions need a separate mesh (CS1 node meshes).
- Unreal's spline mesh only supports one cubic per component, so long roads are chains of components – same as CS1 segments. That is the production norm: one cubic Hermite/Bezier per segment.

### Gaps
- SimCity (2013) road mesh generation: no primary source found.
- Transport Fever 1/2 street/track model format: the TF2 wiki "Construction Types" page was only seen in an RSS feed ([TF2 wiki feed](https://www.wiki.transportfever2.com/feed.php)); no geometry details obtained.
- CiDy, RoadArchitect, Unity Splines SplineExtrude docs: not fetched (Unity URL 404).
- CS2 internal mesh pipeline (compositions, GPU deformation): no primary source found; claims commonly seen in community discussions remain unverified.
- CS1 shader-level bending details (e.g. matrices passed to the shader) not found in any source.

## 2. Cross-section extrusion vs polygon union + triangulation

### Takeaway
All confirmed production tools use structured strips (extruded cross-section or bent template grid), which give V-coordinates proportional to arc length, attribute continuity across tiles, and a known vertex count; junctions are handled by separate node meshes, not by unioning road polygons.

### Cited Findings
- CS1 tiling of fixed-length stubs with V scrolling along length; magenta vertex colour to exclude parts from stretching. — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor)
- CS1 junction meshes must match segment edges exactly (one edge each side of centreline) to snap; extra edges cause terrain holes — evidence that join correctness depends on matching cross-section topology. — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor)
- Landscape Splines meshes are fit to spline width via "Scale to Width" — width is a scalar across a fixed profile. — [UE Landscape Splines](https://dev.epicgames.com/documentation/unreal-engine/landscape-splines-in-unreal-engine)

### Inferences
- Extrusion triangle count = 2 × (profile vertices − 1) × (stations − 1); a 2-lane flat road needs only a 2–4 vertex profile per station (more only where kerbs/sidewalks rise). Union + triangulation (e.g. earcut/CDT) gives fewer triangles on straights but loses the (u = across, v = along arc length) parameterization, produces slivers, and must be recomputed globally on edits.
- Best practice that follows: extrude per segment; build junction "node" polygons separately (union/triangulate only the small intersection patch); stitch with matching profile vertices at the segment end.

### Gaps
- No quantitative benchmark comparing the two approaches was found.

## 3. Adaptive tessellation along a road (curvature, vertical curves, screen-space error)

### Takeaway
Use an error-bounded station spacing: for horizontal curves a chord (sagitta) tolerance; for Beziers Wang's formula gives an a-priori uniform segment count; straights need only 2 stations unless terrain conforming requires more.

### Cited Findings
- Wang's formula: minimum number of parametrically uniform line segments for a degree-n Bezier within tolerance, from the max norm of second differences of control points × n(n−1)/8, under a square root; conservative but used in Skia path flattening; origin Goldman, Pyramid Algorithms (2003) §5.6.3. — [Skia Flatten.cpp](https://skia.googlesource.com/skia/+/chrome/m152/src/gpu/graphite/sparse_strips/Flatten.cpp); [GPU-friendly Stroke Expansion, arXiv 2405.00127](https://arxiv.org/pdf/2405.00127)
- Invertible/angle-step metrics: subdivisions = total turning angle / angle step; can be computed upfront without recursion. Error integrand for arcs equals subdivisions per unit length of an optimal flattening as tolerance → 0. — [arXiv 2405.00127](https://arxiv.org/pdf/2405.00127)
- Unreal EditorApplySpline exposes "Num Subdivisions" = number of triangles along the spline when applying it to the landscape (fixed, user-chosen). — [UE 4.27 EditorApplySpline](https://docs.unrealengine.com/4.27/en-US/BlueprintAPI/Landscape/Editor/EditorApplySpline/)

### Inferences (standard geometry, derived here, not from a cited source)
- Wang's formula (cubic, n=3): N = ceil( sqrt( (3·2/8) · max_i |P_i − 2P_{i+1} + P_{i+2}| / ε ) ) = ceil( sqrt( 0.75·M / ε ) ).
- Circular arc radius R, sagitta tolerance ε: chord length c ≤ 2·sqrt(2Rε − ε²) ≈ sqrt(8Rε); angle per step Δθ = 2·acos(1 − ε/R); count N = ceil(θ_total / Δθ). Example: R = 50 m, ε = 2 cm → c ≈ 2.83 m; R = 500 m → c ≈ 8.9 m.
- Edge-of-road error is larger than centreline error: for half-width w on the outer edge use R + w in the formula.
- Vertical (parabolic) curve y = (g2 − g1)/(2L) · x² has constant second derivative a = (g2 − g1)/L; height error of a chord of length c is a·c²/8 → c = sqrt(8ε / |a|). Pick station spacing = min(horizontal, vertical).
- Screen-space error: projected error ρ = ε · H / (2·d·tan(fov/2)) pixels (H = viewport height px, d = distance); choose ε(d) per LOD so ρ ≤ ~0.5–1 px.
- Torsion/banking (superelevation roll) change also needs stations; any profile change (width transition, lane add) forces a station.

### Gaps
- No game source states its actual station-spacing rule (CS1 uses fixed stubs; Unreal uses user subdivisions).

## 4. Bridges / elevated decks / tunnels / portals

### Takeaway
Games model elevation as discrete mesh variants (ground, elevated, bridge, slope/portal, tunnel) selected per segment, and tools switch off terrain deformation for bridge spans while blending terrain at the ends.

### Cited Findings
- CS1: five variations — Basic (ground), Elevated (a few steps up), Bridge (higher; diffuse covers the underside), Slope (ground→tunnel; diffuse handles the tunnel opening), Tunnel (underground; usually no extra modelling). Each variant can have several models. — [CS1 wiki, Road Editor](https://skylines.paradoxwikis.com/Road_Editor); five variations also stated in [Paradox Green Cities dev diary 8](https://admin-forum.paradoxplaza.com/forum/developer-diary/cities-skylines-green-cities-dev-diary-8-road-modding.1050864/post-23414937) (search snippet)
- EasyRoads3D: "Bridge Object" toggle on a marker stops terrain deformation for that segment while the road still follows markers; start/end level distances blend terrain back; "Distribute Heights" spreads height evenly to the next marker (viaducts); a middle bridge segment can keep deformation off so a road beneath still deforms terrain; avoid bridge on first two markers. — [EasyRoads3D V3 manual mirror](https://nlp.fi.muni.cz/aiproject/ui/hutta_peter2019/pa026-project/Assets/EasyRoads3D/html/creating_roads.html)
- CS2 offers elevated versions of every road size and elevated crossings. — [Game Developer](https://www.gamedeveloper.com/design/how-colossal-order-turned-roads-into-the-backbone-of-cities-skylines-ii)

### Inferences
- In three.js: the deck is the same extruded surface; elevation adds separate geometry (deck underside/sides, pillars as instanced meshes); tunnels render only portal meshes and hide the surface (no terrain hole needed if the tunnel is not visible); the slope/portal variant needs a terrain cut or the portal mesh must cover the terrain intersection (CS1 puts the opening in the slope diffuse).

### Gaps
- No source on how CS1/CS2 cut the terrain mesh at tunnel portals.

## 5. Road LOD and far-distance representation

### Takeaway
Confirmed evidence is thin: CS1 road LODs switch at a short distance (~300 by default per a modder) and draw from a texture atlas; Unreal Landscape Splines offer only a max draw distance. Far roads are typically cheap, low-detail versions.

### Cited Findings
- A CS1 modder raised road LOD distance "from 300 to 2500" because otherwise the lower detail level appeared ~70 m above ground; the zoomed-out LOD uses a texture atlas that the custom-texture mod did not update. — [Steam Workshop discussion](https://steamcommunity.com/workshop/filedetails/discussion/633547552/357285562493214986)
- Exported CS1 road LODs (via Network Dump Tools) come out slightly too wide when reimported — evidence that separate LOD meshes exist per network. — [Steam, Network Dump Tools comments](https://steamcommunity.com/sharedfiles/filedetails/comments/1845697704)
- Unreal Landscape Splines: Max Draw Distance per spline, cast shadow toggle; no LOD levels documented. — [UE Landscape Splines](https://dev.epicgames.com/documentation/unreal-engine/landscape-splines-in-unreal-engine)
- three.js BatchedMesh: multi-draw of many geometries with one material, per-object frustum culling, sortObjects, reserved vertex/index space for later `setGeometryAt` replacement, `optimize()` repack; no built-in LOD (swap via `setGeometryIdAt` or separate batches). — [three.js BatchedMesh docs](https://threejs.org/docs/pages/BatchedMesh.html)

### Inferences
- For three.js: LOD1 = same strip with ε scaled by distance (fewer stations), profile reduced to 2 vertices (flat ribbon, kerbs dropped, markings moved into the surface texture/shader); LOD2 = roads baked into the terrain texture/splat map. `setGeometryIdAt` on a BatchedMesh lets one instance switch between pre-registered LOD geometries cheaply.

### Gaps
- No primary source on CS2 or other city builders baking far roads into terrain textures.

## 6. Terrain/road interaction: conform vs flatten

### Takeaway
Production tools flatten/modify terrain to the road (cut-and-fill), with a cosine-blended falloff band, rather than draping the road over raw terrain; bridges disable it.

### Cited Findings
- Unreal Landscape Splines: Raise Terrain (embankments) / Lower Terrain (ditches); Half-Width; Side Falloff is a cosine-blended transition on each side; End Falloff; also paints a blend layer with its own width ratio and falloff. — [UE Landscape Splines](https://dev.epicgames.com/documentation/unreal-engine/landscape-splines-in-unreal-engine); [UE 4.26 splines](https://docs.unrealengine.com/4.26/BuildingWorlds/Landscape/Editing/Splines)
- Known Unreal issue: landscape often doesn't correctly conform; terrain shows through or the spline "floats". — [UE-86164](https://issues.unrealengine.com/issue/UE-86164); [UE-10297](https://issues.unrealengine.com/issue/UE-10297)
- EasyRoads3D: "Min Indent" levels terrain outward from the road edge to road height; terrain can only be adjusted at existing heightmap points, so results depend on heightmap resolution; sideways rotation limited to 30° while deformation is on. — [EasyRoads3D manual: general settings](https://nlp.fi.muni.cz/aiproject/ui/hutta_peter2019/pa026-project/Assets/EasyRoads3D/html/general_settings.html), [troubleshooting](https://nlp.fi.muni.cz/aiproject/ui/hutta_peter2019/pa026-project/Assets/EasyRoads3D/html/troubleshooting.html)
- CS2 has cut-and-fill construction and roads adjust automatically to terrain. — [Paradox forum, Dev Diary 1](https://admin-forum.paradoxplaza.com/forum/developer-diary/development-diary-1-road-tools.1590300/page-6)
- Galin 2010: terrain excavated along the computed path. — [Eurographics record](https://diglib.eg.org/items/0aba12a9-bdbc-43a2-982c-5d1a9a43a2ba)

### Inferences
- Flattening terrain under the road decouples road tessellation from terrain resolution: the road only needs stations for its own curvature/grade, not for terrain bumps — the largest triangle-saving lever. The heightmap-resolution limit (EasyRoads3D) means a small vertical offset/polygon offset is still needed against z-fighting.

## 7. Garland–Heckbert greedy insertion / data-dependent triangulation for ruled road surfaces

### Takeaway
Greedy insertion is designed for height fields: start from a coarse triangulation, repeatedly insert the highest-error point; data-dependent triangulation beats Delaunay for fewer vertices. Road surfaces are ruled/developable strips with a known analytic error, so direct error-bounded station placement achieves the same result more cheaply.

### Cited Findings
- Greedy insertion: start with simple triangulation, insert the point of highest error each pass; update with Delaunay or data-dependent triangulation; the most successful method they examined. — [Garland & Heckbert 1995, CMU-CS-95-181](https://www.mgarland.org/files/papers/scape.pdf); [Berkeley mirror](https://people.eecs.berkeley.edu/%7Ejrs/meshpapers/GarlandHeckbert.pdf)
- Cost O((m + n) log m) (n input points, m output vertices). — [Garland & Heckbert 1997 revision](https://mgarland.org/archive/uiuc/papers/simp.pdf)
- Data-dependent triangulation gives better approximations with fewer vertices. — reported in [Garland Terra/Scape page](https://mgarland.org/software/terra.html) and the 1995 report
### Inferences
- For a ruled strip between two edge curves, every across-road line is exact, so the only error is along the road; optimal triangulation is "stations + diagonals", and the diagonal choice (data-dependent edge flip) matters only where the strip twists (banking change) or both edges have different curvature. Greedy insertion is relevant for non-ruled patches (junction surfaces, terrain-conformed shoulders), not for the main deck.

### Gaps
- No source applying Garland–Heckbert specifically to road meshes.
