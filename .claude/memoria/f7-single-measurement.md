---
name: f7-single-measurement
description: "Find problems with ONE F7 (Lab) measurement in the game, log them all at once, fix in code, test in the game only at the end"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 312e2ccb-859b-4ff4-9fb9-ec196da1fc56
  modified: 2026-10-25T21:57:28.960Z
---



The owner's order (2026-10-25): no rounds of measurements and tests. Open the game, use the F7 inspector (the Lab), take ONE measurement, photograph every tab, record every problem it shows at once (reports/audit-f7/AUDIT.md), fix them all in the code, then test in the game once at the end with photos.

**Why:** repeated measuring/testing rounds wasted time; the owner wants the problems found once and fixed.

**How to apply:** headless Chrome with real gestures for the F7 session; static checks (tsc, eslint) are fine while fixing; no GPU timing sweeps, no slow suites between fixes. See [[do-the-work-yourself]], [[find-by-reading-not-suites]].
