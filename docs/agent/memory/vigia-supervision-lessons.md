---
name: vigia-supervision-lessons
description: "How to supervise the roadcraft work sessions so they deliver: small committed stages, index commits, short turns, study before ordering"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 7dd2375b-9680-4443-b24c-c89e980ceebd
  modified: 2026-10-24T23:40:35.133Z
---

Lessons from 2026-10-24, when three sessions worked for hours and delivered almost no commit, and the user stopped them all.

**Why:** the user judges by delivered, measurable results (commits with triangle counts and images), not by activity. Hours of uncommitted work in a shared folder read as "não fizeram nada", and one lost tool (a cooker deleted before commit) showed the risk.

**How to apply:**
- Stages of at most ~2 h, each ending compiled, tested, measured, photographed and committed. Never let one stage absorb new design work.
- The working copy is shared: `git commit -- <paths>` writes the working-copy version of those paths and carries other sessions' edits. Stage only your own hunks (`git apply --cached`), check `git diff --cached --name-only`, then `git commit` with no pathspec.
- Sessions must end their turn after each step; a message sent mid-turn waits until the turn ends, and one turn ran an hour with all orders unread.
- Before writing orders, study the scope first: measured state, file:line, tests run. Then give one exact, measurable spec (files, functions, thresholds, tests, commit procedure), not a stream of corrections.
- The user's own model (e.g. the square junction plate with chamfered corners) is the target design; measure alternatives against it.
- Judge triangle quality by width (min altitude in px at the switch distance), not by angle.
- Far stand-ins must keep the look: an impostor of the real model, never a plain box (a box version was reverted for that).
- No feature loss counts as optimisation: check map size, saves, visuals, every test that passed on HEAD.

Related: [[vigia-must-see-images]], [[rebuild-dont-patch]], [[commit-local-always]].
