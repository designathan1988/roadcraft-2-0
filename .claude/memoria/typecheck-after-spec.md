---
name: Typecheck after writing a spec
description: A spec that passes under vitest can still fail the typecheck; run npm run typecheck after writing or editing any spec, before committing
metadata:
  type: lesson
---
Vitest strips types and runs a spec that tsgo refuses (2026-10-28: plateFollowStill.spec.ts passed, then failed `npm run typecheck`:
a void callback where `PlateFollow<S, K>` wants K, caught only two commits later). The skill cycle's typecheck runs before the spec is
written. After writing or editing a spec: `npm run typecheck`, then commit.
