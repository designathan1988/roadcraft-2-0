---
name: fix-in-code-test-in-app
description: "Inviolable rule (2026-10-26): find and fix problems in the code, verify only in the open game window with photos; no suites, measurements or slow processes; a point script must finish under 30 s or be discarded"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 610f72a3-1929-4841-bc3b-2b58caed3c35
  modified: 2026-10-26T20:50:28.061Z
---



The owner's inviolable rule, pasted 2026-10-26 after the page-window batch broke the roads in the desktop app while every headless pass and suite was green:

- Identify every problem directly in the code and fix it there. No more measurements, suites or slow/heavy processes.
- Verify in the application itself: the open game window (`npm run desktop:dev`, checks through `scripts/inGame.mjs`), look at the outputs, take pictures, analyse them, find the problems, fix them.
- A point check, if needed, is a script that finishes in under 30 s; one that takes longer is discarded.

**Why:** suites and headless passes passed while the real game broke; the owner trusts only what is seen in the game.

**How to apply:** after each code change, reload is automatic (dev server); take a picture with `node scripts/inGame.mjs shot reports/in-game/NNN-*.png`, read it, and act on what it shows. Never launch a look run or a vitest suite as "confirmation". Related: [[no-visible-browser]], [[find-by-reading-not-suites]].
