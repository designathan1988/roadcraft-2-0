---
name: grid-10m-whole-game
description: "The user's decimal world scales - grid 10 m, road surface piece 100 m, cell 250 m, tile 1 km, terrain plate 2 km, map 20 km"
metadata:
  node_type: memory
  type: project
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T00:55:21.497Z
---

The user ordered a universal 10 m grid and, on 2026-10-24, round decimal scales for every world division:
- grid 10 m
- road surface filing piece 100 m
- cell 250 m
- tile 1,000 m (1 km²)
- terrain plate 2,000 m
- map 20 km a side (20 tiles)

They replace the uncommitted 1,280 / 320 / 2,560 / 80 m values (and the old 1,024 / 256 m ones).

**Why:** the user wants everything in round multiples of 10. They were confused by the earlier power-of-two-flavoured numbers.
**How to apply:**
- Never reintroduce non-round scales.
- A 20 km map needs the plates' edges on multiples of 2 km. Centred plates would put the map edge mid-plate.
- Explain scales to the user in plain words: they are invisible filing squares, not something drawn.
Related: [[optimization-no-visible-change]].
