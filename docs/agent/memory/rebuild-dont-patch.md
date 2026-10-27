---
name: rebuild-dont-patch
description: "when a model or system shows no real gain from optimizing, research the correct architecture and rebuild it instead of patching"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 449180dc-9ea9-4560-908d-a99ce08a4ad3
  modified: 2026-10-24T17:54:03.271Z
---

When a model (roads, buildings, vehicles, any asset) or its generation system shows no real improvement after optimization attempts, stop patching it. Research deeply how production games/papers do it, then rebuild it with the correct architecture (new builders are allowed), keeping the same look and all features.

**Why:** the user (2026-10-24) saw rounds of trial-and-error fixes on the road meshing with little gain and said "pare de ficar tentando consertar algo que não apresenta melhora real e faça do jeito correto"; the same applies to every other model.

**How to apply:** before touching a model group, research its correct architecture with sources; if the current builder can't reach it, design and build a replacement; photograph before/after, commit locally often. Related: [[commit-local-always]].
