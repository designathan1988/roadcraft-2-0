---
name: optimization-no-visible-change
description: "Optimizations must not move, shrink, drop or restyle any visible detail; check everything before committing"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T00:37:22.608Z
---

An optimization may only remove what is truly invisible, or draw the same picture more cheaply. Moving pots, dropping end posts, making a lift car shallower or changing a material's roughness is not allowed, even when the change is small.

**Why:** the user said objects disappearing or details breaking "can't happen" (2026-10-24), after buildings stage 1 turned out to carry about 10 small visible changes.
**How to apply:** audit every diff hunk for visible effect before committing. Revert or redo any hunk that changes appearance. Verify with before/after images at the end. Related: [[grid-10m-whole-game]], [[rebuild-dont-patch]].
