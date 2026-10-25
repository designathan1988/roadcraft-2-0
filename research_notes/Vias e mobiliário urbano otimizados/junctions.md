# Road intersections / junction plates: construction and triangulation (three.js r186 / WebGL2)

Research notes. Every claim under "Cited Findings" has a source link. "Inferences" are this researcher's engineering conclusions, not sourced facts. Source access problems: diva-portal.org refused connections (ECONNREFUSED), so the Darwiche & Nyström thesis is known only from search-result abstracts; the Paradox forum dev-diary page returned a bot-validation interstitial; no SimCity 2013, Transport Fever, CiDy, RoadArchitect or Liam Edwards primary source was retrieved.

## How do shipped games and road tools build junction geometry?

### Takeaway
The only primary source with a fully described algorithm is StreetGen (Cura, Perret, Paparoditis, IGN): kerb-return radius from speed and width; arc centre from intersecting the offset buffers (width + r) of the two axes; border (mouth) lines normal to the axis at the arc tangent points; and a junction area built from the cut road surfaces plus arcs. Commercial tools (EasyRoads3D, Transport Fever 2 crossings) instead use prefab or parameterised crossing meshes matched by cross-section. Cities: Skylines 1/2 internals were not documented in any primary source I could reach.

### Cited Findings
- StreetGen input: road-axis polylines, each with an estimated roadway width and an estimated average speed. It was run on all Paris streets. — [StreetGen, arXiv 1801.05741](https://arxiv.org/pdf/1801.05741)
- StreetGen splits streets into "transition parts" (intersections and width transitions) and regular segments. Pipeline: reconstruct network, find corner arcs, compute surfaces, then add lanes and markings. — [StreetGen (ar5iv HTML)](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Kerb-return (turning) radius from an empirical SETRA-based function: `f(speed, width) = 18.6 * sqrt(speed / |10*width + 65 - speed|)`. At a junction of axes with radii r1, r2 it uses `r = min(r1, r2)` "or another choosing rule". Corner paths are restricted to a straight segment or a circular arc, not a clothoid. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Arc centre: buffer each axis a_i by `d_i = w_i + r`, intersect the buffer boundaries, and keep the candidate closest to the intersection centre. Fallbacks: no candidate (one road inside the other) means no arc; an axis that is too short gets the radius cut to the largest feasible value, computed explicitly; an arc too far from the centre gets r = 0.15 m (the Paris kerb-stone radius). The authors rejected explicit analytic computation: too many special cases, 2D only, and it can't handle polylines. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Tangent (border) points: for each axis, take the closest point from the arc centre to the buffered axis, not a projection, because projection onto a polyline "may be ill-defined". Of the candidate points per axis, keep the farthest from the centre by curvilinear abscissa, not Euclidean distance. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Mouth / "section border lines": placed at the border points, normal to a local straight approximation of the axis. The buffered road surface is cut by these lines. The junction surface comes from PostGIS `ST_BuildArea` over the cut road surfaces plus the arcs, because explicitly linking border lines to arcs was judged too fragile. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Width-only transitions use a "variable buffer": a per-vertex radius interpolated linearly, implemented as a union of circles and isosceles trapezoids. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Lanes come from `ST_OffsetCurve` (a buffer-like offset, not a translation). Pedestrian crossings are built along the border (mouth) lines. Traffic interconnections through the junction are Bezier curves whose middle control point is the barycentre of the lane-line intersection and the junction centre. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- StreetGen's reported failure modes:
  - GEOS approximates arcs by segments, which caused wrong unions; the authors suggest exact CGAL/SFCGAL.
  - Two axes forming a loop can turn a whole block into "intersection".
  - A big orthogonal street gives a bump at T-junctions.
  - Axes shorter than the radius push the arc end out of the junction.
  - [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Darwiche & Nyström (Malmö University, 2022, bachelor thesis):
  - Spline roads "struggle" in networks with intersections, giving overlapping meshes and flickering textures.
  - They propose detecting spline intersections to support procedural mesh generation.
  - Index terms: Bezier subdivision, convex hulls, separating axis theorem, Sutherland–Hodgman clipping.
  - Full text unreachable (ECONNREFUSED), so method details are not verified.
  - [diva2:1675311](https://www.diva-portal.org/smash/get/diva2:1675311/FULLTEXT02)
- A common practical workaround in Unity forums: generate the intersection as a separate mesh and clip out the road vertices inside it. — [Unity Discussions](https://discussions.unity.com/t/procedurally-generated-road-networks-and-intersections/532867)
- Galin et al. 2011 (road network generation) use a path-merging step that creates junctions, with junction geometry from generic parameterised models. — [Galin et al., CGF 2011](https://www.cs.purdue.edu/homes/bbenes/papers/Galin11CGF.pdf) (search snippet only)
- EasyRoads3D V3 has two crossing kinds: "dynamic" scripted crossing/connection prefabs (width, sidewalks and materials adjustable) and "custom" prefabs from user meshes. A road attaches only if its shape (vertex count of the cross-section) matches the connection; exact vertex positions are not required. Mismatched connections show red handles. Each crossing corner has sidewalk toggles that propagate to connected roads. — [EasyRoads3D V3 manual – intersections](https://nlp.fi.muni.cz/aiproject/ui/hutta_peter2019/pa026-project/Assets/EasyRoads3D/html/intersections.html) (university mirror of the vendor manual). v3.1 added uv3/uv4 for custom connection prefabs. — [release notes](https://nlp.fi.muni.cz/aiproject/ui/hutta_peter2019/pa026-project/Assets/EasyRoads3D/html/release_notes.html)
- Transport Fever 2: a crossing-mod author says the game can't adapt a crossing model to arbitrary widths. Separate models ship for 9/12/18/22/28 m, and the nearest one is used (a 14 m road gets the 12 m crossing). — [Steam Workshop discussion](https://steamcommunity.com/workshop/filedetails/discussion/3059080251/3879347492852423656) (community source, low authority)
- Cities: Skylines 1 terminology: each route is segments joined by nodes; every segment has a node at both ends; segments can curve or elevate between their nodes. Mods (Node Controller) can twist or stretch segment ends. — [TM:PE wiki](https://github.com/CitiesSkylinesMods/TMPE/wiki/Nodes,-Segments,-Lanes)
- Cities: Skylines 2 official material covers only user-facing features: reworked intersection placement rules, premade intersections placed over existing roads that connect automatically, roundabouts placed on existing intersections in several sizes, grid tool. — [Paradox CS2 road tools](https://paradoxinteractive.com/games/cities-skylines-ii/features/road-tools)
- Houdini: SideFX "Complex Roads" series, part 1 "Solving Intersections", ends in a road tool for Unreal. — [SideFX tutorial](https://sidefx.com/tutorials/complex-roads) (content not inspected)
- Unreal "UnrealDrive" triangulates road splines together per actor, so intersections are seamless only when the splines share an actor. — [UnrealDrive docs](https://unrealdrive.readthedocs.io/en/latest/ProcedureGenerationTool.html) (search snippet)

### Inferences
- A robust analytic alternative to StreetGen's buffer approach, for two road edge lines meeting at a corner: offset both kerb lines inward by r. Their intersection is the fillet centre C, and the tangent points are the feet of the perpendiculars from C. For straight edges with interior angle θ, the tangent distance from the corner is `r / tan(θ/2)`; clamp r so this doesn't exceed the available segment length (StreetGen's "reduce radius to max feasible"). For curved (Bezier/arc) road edges, solve with a few Newton steps on the offset curves, or flatten them first.
- Mouth line per arm: take the larger of the two tangent-point distances along that arm's axis (StreetGen's "farthest by curvilinear abscissa") and cut straight across, normal to the axis. The road segment then ends on a clean perpendicular line. Its cross-section vertices (lane-line positions) lie exactly on the mouth, and the plate is a polygon bounded by alternating mouth lines and kerb arcs. This mirrors the CS1/CS2 segment-plus-node split and keeps the segment mesh a simple swept strip.
- On the mouth line, the larger tangent distance leaves a short straight kerb between the arc end and the mouth on the side with the smaller distance. Include that straight piece in the plate outline, so the outline stays G1 and the segment strip stays rectangular.
- Prefab-matching approaches (EasyRoads3D, TF2 widths, CS1 node meshes) trade generality for authored quality. For a city builder with arbitrary angles and widths, StreetGen-style procedural plates plus a cheap triangulator scale better.

### Gaps
- No primary source on CS1 `NetInfo.Node` mesh deformation, CS2 composition meshes, SimCity 2013 (GlassBox), Transport Fever internals, CiDy, RoadArchitect, or Liam Edwards' write-up. The Paradox forum blocked fetching, and the searches returned only community posts.
- The Darwiche & Nyström method (clipping and mesh steps) could not be read.

## Triangulating the plate: CDT / quality meshing vs ear clipping, and JS libraries

### Takeaway
Ear clipping (earcut) is fastest but gives skinny fans along tessellated kerb arcs. Its `refine` Delaunay-flip pass removes many slivers at the same triangle count. A true CDT (Constrainautor over Delaunator, cdt2d, poly2tri) gives max-min-angle triangles for the given vertices. Guaranteed angle bounds need Delaunay refinement (Ruppert/Chew, as in Shewchuk's Triangle), which adds Steiner points. Triangle's licence forbids commercial inclusion.

### Cited Findings
- earcut:
  - Algorithm: modified ear slicing with z-order hashing; handles holes, twisted polygons, degeneracies and self-intersections, without guaranteeing correctness.
  - Holes: given as start indices. A single-vertex "hole" acts as a Steiner point.
  - Quality: default output can have skinny triangles. Optional `refine()` applies Delaunay flips to interior edges and "usually removes many skinny triangles", keeping the triangle count.
  - Benchmark: 119,680 polygons (1.9 M vertices) in about 445 ms, plus about 168 ms for refine, on an M1 Pro (self-reported).
  - Output may contain T-junctions (not conforming).
  - `deviation()` checks area error.
  - Size: 4 KB gzipped.
  - [mapbox/earcut](https://github.com/mapbox/earcut)
- Constrainautor:
  - Takes a Delaunator triangulation and inserts constraint edges (`constrainOne/constrainAll`). Since v4 it restores the Delaunay condition after each constraint.
  - Algorithm adapted from Sloan 1992.
  - Requirements: no duplicate points, constraints must not cross each other or pass through points, the outer edges must form the convex hull, no holes. So for a concave plate you must drop the triangles outside the polygon yourself.
  - No allocations during constraining.
  - Licence: ISC.
  - [kninnug/Constrainautor](https://github.com/kninnug/Constrainautor)
- cdt2d:
  - API: `cdt2d(points, edges, {delaunay, interior, exterior, infinity})`. Interior/exterior faces are classified by crossing parity against constraint edges, which gives hole and concave support directly.
  - Requires no duplicate points, no crossing constraints, no T-junctions; preprocess with `clean-pslg`.
  - Self-described "WORK IN PROGRESS"; no benchmarks.
  - [mikolalysenko/cdt2d](https://github.com/mikolalysenko/cdt2d)
- poly2tri.js:
  - Sweep-line CDT (Domiter & Zalik); holes via `addHole`, Steiner points via `addPoint`.
  - Input limits: simple polygons only; holes must not touch; duplicate or collinear points throw exceptions; no input validation.
  - Licence: BSD-3.
  - [r3mi/poly2tri.js](https://github.com/r3mi/poly2tri.js)
- Triangle (Shewchuk):
  - Builds exact Delaunay, constrained Delaunay and conforming Delaunay triangulations, plus quality meshes with "no small or large angles".
  - Uses Chew's Delaunay refinement by default; Ruppert's is available via `-D`.
  - Free but copyrighted: may not be sold or included in commercial products without a licence. The robust predicates are public domain.
  - [Triangle](https://www.cs.cmu.edu/~quake/triangle.html)
- Triangle `-q`:
  - Default minimum angle is 20°.
  - Termination is guaranteed (with exact arithmetic) for bounds of 20.7° or less. It often works up to about 33° and usually fails above 34°.
  - Small angles between input segments cannot be removed.
  - [Triangle -q switch](https://www.cs.cmu.edu/~quake/triangle.q.html)

### Inferences
- Why needle fans appear: ear clipping on a plate whose outline is long straight mouth edges plus densely tessellated arcs tends to connect each arc vertex to one distant vertex (or to its neighbours on the arc), giving thin fans. Delaunay flips (earcut `refine`, or a CDT) fix most of this, because CDT maximises the minimum angle over all triangulations of the same vertex set.
- A plate is small (tens of vertices), so the cost of any method is negligible per junction. Even a few thousand junctions rebuilt per edit are cheap in JS. Choose for correctness and quality, not speed.
- Recommended pipeline (inference):
  1. Clean the outline: weld duplicates within epsilon, drop collinear vertices except mouth endpoints and lane-mark points, ensure CCW winding.
  2. Run earcut, then `refine` (smallest dependency), or run Delaunator over the outline plus the convex hull, constrain the outline with Constrainautor, and discard outside triangles by centroid-in-polygon.
  3. Optionally add one Steiner point at the junction centre, or a few interior points, to break long diagonals between opposite mouths. earcut supports this via single-vertex holes, Delaunator by just adding points.
- Full Ruppert/Chew refinement is unnecessary for rendering a flat, uniformly shaded plate. It matters only if per-vertex attributes (wetness, AO, vertex-colour wear) must interpolate smoothly, or if the plate is draped on terrain and needs interior vertices for height. In that case, add interior grid or Steiner points at the terrain sample spacing, then CDT.
- The Triangle licence makes it unsuitable for a commercial product unless licensed. Use JS-native CDTs (ISC/BSD/MIT).

### Gaps
- No published benchmark comparing cdt2d, poly2tri and Constrainautor on small road-plate polygons was found.
- No source quantified sliver counts for earcut with vs. without `refine` on arc-heavy polygons.

## Fan/spoke topology vs straight-skeleton / medial-axis decomposition

### Takeaway
No primary source was found describing radial-strip or straight-skeleton decompositions specifically for road junction plates. The techniques below are engineering inferences. StreetGen sidesteps decomposition by building the plate as one area (ST_BuildArea) from the cut road surfaces and arcs.

### Cited Findings
- StreetGen builds the junction as a single area from the cut road surfaces and arcs, not by linking border lines to arcs, which it found fragile. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Junction-to-junction lane connections are Bezier curves through the junction (control point at the barycentre of the lane-line intersection and the centre). This is a natural spine for any radial or strip decomposition. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)

### Inferences
- Centre-fan / spoke topology: one vertex at the junction centroid (or a Steiner point), with spokes to every outline vertex. Triangles are well shaped only for near-regular, convex plates. For acute-angle junctions and long mouths it produces needles, so it should only be used as a fallback for 3-4-way near-orthogonal plates.
- Corner-strip topology: for each kerb arc, build a strip between the arc vertices and their projections onto a straight "inner" chord (or onto the plate's inner polygon formed by the mouth endpoints). Fill the inner convex polygon with a simple fan. This gives quads along the kerb (good for kerb-side gutter UVs and wetness gradients) and isolates the arc's fine tessellation from the core.
- A straight skeleton or medial axis gives a principled split into per-arm regions, which helps if per-arm attributes (asphalt type, wear) must be blended inside the plate. It costs implementation complexity, and the straight skeleton is fragile with near-parallel edges. For rendering it is usually overkill compared with CDT plus a shader that uses world-space UVs.

### Gaps
- No game or paper found that documents using a straight skeleton or medial axis for junction plates.

## Keeping attributes discontinuous at mouth lines (lane marks, UV frames)

### Takeaway
Shipped systems keep segment and junction as separate meshes or pieces that meet at a shared cut line. CS1/CS2 use segment vs node; EasyRoads3D attaches roads to crossing prefabs and requires the same cross-section vertex count; StreetGen cuts surfaces at border lines and builds crosswalks on them. The mesh rule: duplicate the vertices on the mouth line, once in the segment mesh with the segment's UV frame and once in the plate mesh with the plate's world-space or local frame, at bit-identical positions to avoid cracks.

### Cited Findings
- EasyRoads3D connection matching requires the same cross-section vertex count between the road and the crossing connection, not exact vertex positions. — [EasyRoads3D manual](https://nlp.fi.muni.cz/aiproject/ui/hutta_peter2019/pa026-project/Assets/EasyRoads3D/html/intersections.html)
- StreetGen places pedestrian crossings along the border (mouth) lines and builds lanes per axis by offset curves. Markings are thus per segment and end at the mouth. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- CS1 model: every segment has nodes at both ends, and segments are separate entities from nodes. — [TM:PE wiki](https://github.com/CitiesSkylinesMods/TMPE/wiki/Nodes,-Segments,-Lanes)
- Separately generated, overlapping road meshes at intersections cause flickering textures (z-fighting), which motivates explicit junction detection and cutting. — [Darwiche & Nyström abstract](https://www.diva-portal.org/smash/get/diva2:1675311/FULLTEXT02); [Unity Discussions](https://discussions.unity.com/t/procedurally-generated-road-networks-and-intersections/532867)

### Inferences
- Vertex-splitting rule: in an indexed BufferGeometry, a vertex can carry only one UV/attribute tuple. Shared positions with different UVs must be duplicated (three.js `BufferGeometry` attributes are per vertex). So emit mouth vertices twice: once at the segment end with segment-space UV (u = across-lane, v = arc length), and once in the plate with plate UVs (for example world XZ × scale).
  - If segment and plate share one merged mesh or batch, still keep them as distinct vertices, so `mergeVertices` must not be run across the mouth (or must be told to keep UV differences).
- Crack-free mouths: compute mouth endpoints once per junction and feed the same Float32 values to both meshes. If the plate's mouth edge needs extra vertices (lane-line endpoints for paint), the segment end must have the same vertices on that line, and vice versa, to avoid T-junctions and cracks. This is the analogue of EasyRoads3D's vertex-count matching.
- Lane marks: stop segment lane-line paint at the mouth, or at the crosswalk set back from it. Draw junction paint (stop lines, turn guides, crosswalk bars on the mouth) as a separate decal or strip layer referencing the plate frame. Continuous edge lines through the plate follow the kerb arcs as their own strips.
- UV frame inside the plate: use world-space planar UVs (or a triplanar or projected shader). There is no single "along-road" direction inside a junction, and world UVs avoid seams between neighbouring plates. Asphalt texture continuity between segment and plate is then handled by making segment UVs also world-aligned for the base asphalt layer, while lane-relative coordinates sit in a second attribute (for example `uv1`) used only for markings.

### Gaps
- No primary documentation of how CS1/CS2 assign UVs on node meshes (the Paradox modding dev diary could not be fetched).

## Fillet radius and arc tessellation by sagitta error

### Takeaway
Pick r per corner from road class (StreetGen's speed/width formula is one sourced option), then clamp by available arm length. Tessellate each arc with an angular step `Δθ = 2·acos(1 − ε/r)` and `n = ceil(θ/Δθ)` segments. For small ε, `n_circle ≈ 2π·sqrt(r/(8ε))`. With ε in metres tied to screen error (or LOD), this gives few vertices on small kerb returns.

### Cited Findings
- PostGIS arc stroking derives the angular step from `acos(1 − tol/radius)` and clamps tol to at most 2r. — [PostGIS lwstroke.c doxygen](https://postgis.net/docs/doxygen/3.7/d9/db4/lwstroke_8c_a2e4c6f92ca4cfaa3a5e3233289c2d201.html)
- `idealArcLength = 2·acos(1 − ε/r)` and `segmentCount = ceil(arcAngle / idealArcLength)`. Short arcs or small radii may need a minimum count, since the formula can give 1. — [QCAD forum](https://forum.qcad.org/t/selecting-an-object-within-a-script/8105?page=2)
- Full-circle form: `n = 180 / acos((r − t)/r)` (degrees). — [SketchUp forum](https://forums.sketchup.com/t/how-many-points-for-a-smooth-curve/9706)
- Small-tolerance approximation: `n ≈ 2π·sqrt(R/(8E))`. — [MapGuide trac #777](https://trac.osgeo.org/mapguide/ticket/777)
- StreetGen radius: `18.6·sqrt(speed / |10·width + 65 − speed|)`, with `min(r1, r2)` at the corner, reduction when an arm is too short, and a 0.15 m fallback. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)
- Approximating arcs by segments in GEOS caused topology errors in StreetGen's unions. — [StreetGen](https://ar5iv.labs.arxiv.org/html/1801.05741)

### Inferences
- Worked numbers for the formula: r = 6 m and ε = 2 cm give Δθ = 2·acos(1 − 0.02/6) ≈ 9.35°, so a 90° return needs ceil(90/9.35) = 10 segments. With ε = 5 cm, Δθ ≈ 14.8°, so 7 segments. With r = 0.5 m and ε = 2 cm, about 4 segments for 90°.
- Use a minimum of 2 segments per return so 90° corners never collapse to a chamfer, and a maximum (for example 16) to bound vertex count on large-radius highway ramps.
- Do the geometry (fillet centre, tangent points, mouth cut) analytically in doubles, before tessellation. Tessellate only for output. This avoids the StreetGen/GEOS precision failure, which came from boolean operations on already-segmented arcs.
- Kerb side faces and sidewalk tops for the same corner must use the same angular samples (same n, same angles), so the kerb wall, gutter and sidewalk ring share vertices radially. This gives clean quads (a corner-strip topology) instead of mismatched fans.
- For LOD, ε can scale with camera distance (screen-space error). Rebuild plates per LOD level or keep 2-3 precomputed tessellations. Plates are small, so the cost is low.

### Gaps
- No official guideline tying kerb radius to road class from a game studio was found. Real-world design-manual radii (for example AASHTO/NACTO) were not researched here.
