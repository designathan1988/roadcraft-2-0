---
name: tool-is-the-road-spec
description: "Roads, junctions and objects must reproduce the owner's tool ferramenta-vias-objetos.html exactly (polygons and LOD ladder)"
metadata:
  node_type: memory
  type: project
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T04:23:52.529Z
---

The owner's tool `C:\Users\Jonathan\Desktop\road\ferramenta-vias-objetos.html` is the specification for roads, junctions and objects. Copy its polygons exactly; do not use it as loose inspiration.

**Roads and junctions:**
- A straight segment is one quad per band.
- The junction plate is built from its outline only (earcut + Lawson flips).
- Fillet stations are nested 8/4/2 per 90°: L0 below 90 m, L1 below 350 m, L2 beyond.
- Kerb faces are one quad per arc step, with none at L2.
- Each footway corner is a single polygon.
- Kerb top and lines are drawn by the shader.
- There is no green verge strip anywhere, and the terrain is level with the road.

Measured from its own code: the four-way is 178 / 114 / 50 triangles (L0 / L1 / L2).

**Exception ordered by the owner (2026-10-25), and it overrides the tool:** every corner is curved on BOTH sides. "VOCÊ TAMBÉM NÃO VIU QUE DEVE SER CURVADO A PARTE DE DENTRO E DE FORA???"
- The tool draws a bend's outer corner square, and it fills the footway square at junction corners. Both are wrong for the game.
- A bend gets concentric arcs (the inner kerb and the outer edge of the asphalt), and the footway keeps its width around both.
- At junction corners, the footway's lot-side edge also follows the arc.
- The same 8/4/2 steps apply. The tool's counts change to match.
- When checking against the tool, also check what the owner wants beyond it: look at the shapes, not only the counts.

**Objects:** L0 from 48 px, L1 from 16 px, an octahedral impostor (64 directions, 2 triangles) from 1.5 px, nothing below that.

**Why:** the owner was furious that earlier sessions invented their own junction designs (rings, fans, 1 cm arcs, verge kept) instead of following the tool (2026-10-24).
**How to apply:** extract the numbers by running the tool's own code (`scratchpad/coord/tool-run.cjs` pattern: slice its bundle from `let Vc=new Set` to `function gu(`). Make an exact-count test the acceptance criterion. Compare top-view wireframes with the tool's. Related: [[optimization-no-visible-change]].
