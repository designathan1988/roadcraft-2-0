---
name: ships-on-steam-any-gpu
description: Roadcraft will be published on Steam and must run on many computers; every GPU-portability problem must be fixed
metadata:
  node_type: memory
  type: project
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T13:44:35.936Z
---

The owner (2026-10-25): the game will be published on Steam and run on different computers, so a material that asks 17 texture units where a GPU has 16, a shader that fails on one driver, and every other such problem must be fixed, not left as a warning.

**Why:** a material that only some GPUs can compile is a hole in the picture for those players.

**How to apply:**
- Open the game in headless Chrome (`scripts/look.mjs scripts/look/verify.json`, dev server on 5300) after rendering work and read every console error and warning: "texture units", "VALIDATE_STATUS", "program not valid", reserved words in GLSL (`patch`, `sample`...) are bugs.
- The null GPU of the specs compiles no shader: passing specs say nothing about this.
- Keep a material within 16 fragment texture units (WebGL2's guaranteed minimum), counting three's shadow maps and the patches' added samplers.
- Related: [[optimization-no-visible-change]].
