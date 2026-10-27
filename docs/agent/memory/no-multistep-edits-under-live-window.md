---
name: no-multistep-edits-under-live-window
description: "The dev game window reloads on every saved file and autosaves: never leave a file half-edited while it runs (it wiped the 10 km save's manifest, 2026-10-26)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f48001e1-de85-47af-9b0b-8a635d5fcf4f
  modified: 2026-10-26T23:01:54.913Z
---

On 2026-10-26 I edited `src/editor/chunkedSave.ts` in several Edit calls while the dev game window was open. Vite reloaded the window on each save, a half-edited state threw during the save read, the game opened an empty map, and its autosave wrote that empty map's manifest and global parts over the owner's 10 km city save. All the squares survived, and the manifest was rebuilt from them.

**Why:** the window (`npm run desktop:dev`) runs the code as it is written, autosave included. Every intermediate state of an edit is a real run against the owner's real save.

**How to apply:** make changes to save, load or boot code in one write (a single Write or Edit that leaves the file compiling), or close the game window first. Back up `%APPDATA%/Roadcraft/saves` before touching the save path. Related: [[fix-in-code-test-in-app]], [[no-relaunch-to-investigate]].
