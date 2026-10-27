---
name: no-fake-city-elements
description: "The 10 km city must be generated with every real, functional game element; boxes for buildings or planes for roads are fraud"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 610f72a3-1929-4841-bc3b-2b58caed3c35
  modified: 2026-10-26T19:31:49.039Z
---

The owner's order (2026-10-26): the 10 km city generation uses all the real, functional elements of the game (real buildings with their parts, real roads and junctions, lots, poles, trees, furniture, traffic, people). Never substitute boxes for buildings, planes for roads, or any stand-in to pass a metric: that is fraud.

**Why:** an optimisation that fakes the content to hit memory or time numbers hides the problem; the goal is a real playable 10 km city.

**How to apply:** any generator path, level of detail or "large city" branch that drops or replaces a real element is rejected. Far levels (masses, far roads) are allowed only as the game's own HLOD made from the real thing, drawn near as the real thing. Check the generator for size-dependent shortcuts before accepting a 10 km result. Related: [[optimization-no-visible-change]], [[architecture-judged-by-code]].
