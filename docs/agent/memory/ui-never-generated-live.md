---
name: ui-never-generated-live
description: Nothing in menus/interface is generated at runtime; menu images are photos taken once and shipped as files; a lint rule must block it
metadata:
  node_type: memory
  type: feedback
  originSessionId: f48001e1-de85-47af-9b0b-8a635d5fcf4f
  modified: 2026-10-27T14:15:06.037Z
---

Nothing in the menus or interface may be generated at runtime (no live thumbnails, no canvas/WebGL drawing for UI). Menu images are photos taken once (lab script) and committed as PNG files the menu just shows. Not a build-time "cook" step either — the owner rejected that word/pipeline: just take the photo and put it in the menu.

**Why:** the Builder made a picture of every option live (second WebGL context, 4 fps, black walls); the owner considers this obvious and was furious it was measured instead of fixed.

**How to apply:** UI code shows ready assets; enforce with the eslint rule (no rendering/canvas/WebGL in src/ui, one WebGL context in the game). Fix in code, don't open the game or run measurements to investigate. See [[fix-in-code-test-in-app]], [[no-game-until-architecture-done]].
