---
name: no-visible-browser
description: "No extra visible browser windows on the owner's screen; the one exception is the game window the owner asked to keep open for checks (2026-10-26)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 610f72a3-1929-4841-bc3b-2b58caed3c35
  modified: 2026-10-26T20:44:07.046Z
---

On 2026-10-25 the owner complained about Chrome windows popping up on the owner's screen from agents' runs: "NÃO ABRIREM CHROME NA MINHA CARA".

On 2026-10-26 the owner ordered the opposite for the game itself: open the game, keep its window open, never close it, have it reload on every code change, and run every game check in that same open instance so the owner can watch closely ("vou fiscalizar de perto").

**Why:** extra windows interrupt the owner's work; the one game window is how the owner supervises that the work is real.

**How to apply:**
- The game window: `npm run dev` (port 5300) + `npm run desktop:jobs:watch` + `npm run desktop:dev` (Electron on the dev server, remote debugging on 127.0.0.1:9333). Never close it, never open a second game window, never use headless look runs for game checks while it is open.
- Run checks in it with `node scripts/inGame.mjs eval|until|shot` (connects over CDP, exits without closing the window); save pictures under `reports/in-game/`.
- Any other browsing or rendering stays headless.
