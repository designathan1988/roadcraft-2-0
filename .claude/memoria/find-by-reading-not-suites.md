---
name: find-by-reading-not-suites
description: "problems are found by reading the code and fast checks; slow suites (test:scale ~25 min) only confirm a finished batch, in the background"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9c3f2516-5a1e-46a4-bbf3-84ff68695476
  modified: 2026-10-25T15:14:21.021Z
---

Find a problem by reading the code on its path (calls, config, data to the origin), then tsc + eslint, then only the spec of that point after the fix; one game pass with photos for visuals. A slow suite (`test:scale`, a full verify) only as the last confirmation of a finished batch, in the background, never waited on.

**Why:** the owner was angry at the time lost on probe after probe and two 25-minute scale runs; the out-of-memory cause (run-limited.mjs handing VITEST_MAX_WORKERS=6, which Vitest 4.1 applies after the config) was readable in the code. On 2026-10-25 the owner ordered this approach written into the hooks (`.claude/hooks/coordinator-checklist.cjs`), the 5-minute coordinator cron and `CLAUDE.md`.

**How to apply:** never start a slow suite to look for a cause; read first, fix, run the one spec (seconds). Related: [[optimization-no-visible-change]], [[ships-on-steam-any-gpu]].
