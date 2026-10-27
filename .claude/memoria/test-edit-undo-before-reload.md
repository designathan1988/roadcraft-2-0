---
name: test-edit-undo-before-reload
description: "A test edit in the owner's city must be undone (Ctrl+Z) before any source edit or reload: the window reloads on every src change, saves on pagehide, and the undo stack dies"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f48001e1-de85-47af-9b0b-8a635d5fcf4f
  modified: 2026-10-27T08:12:35.410Z
---

A road drawn in the 10 km city to profile an edit (2026-10-27) stayed in the save: I edited source files right after, the dev server reloaded the page, `pagehide` saved the city with the road, and the undo stack was gone. It had split four streets; I took it back by hand (`removeSegment`, `pruneOrphanNodes`, `joinSegments`, the balance set back), the rejoined streets with new ids.

**Why:** the city is the owner's; a test must leave it as it was, and the live window reloads and saves on its own.

**How to apply:** do the gesture, take the measurement, undo with Ctrl+Z in the same script, check the counts are back, and only then touch any file under `src/`. Note the segment and node counts and the balance before the edit. Related: [[no-multistep-edits-under-live-window]], [[fix-in-code-test-in-app]].
