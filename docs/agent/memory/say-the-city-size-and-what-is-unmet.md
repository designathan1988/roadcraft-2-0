---
name: say-the-city-size-and-what-is-unmet
description: Every verification report must name the city size it ran on; never call the architecture done while a stated goal (fast generation of 10 km) is unmet
metadata:
  node_type: memory
  type: feedback
  originSessionId: 610f72a3-1929-4841-bc3b-2b58caed3c35
  modified: 2026-10-26T20:33:31.864Z
---

On 2026-10-26 the owner opened the 10 km city and found generation takes 4-5 minutes (232 s measured, serial in one worker), while my reports had said the re-architecture was done and "the 10 km city passed". The headless confirmation passes of the last batches had run on the 1.6 km large city (8 102 buildings) without saying so.

**Why:** the owner read "10 km" and "architecture done" as the whole goal (create, open and handle big cities fast); reporting a partial verification without its scope is a false claim to them.

**How to apply:** in every report say the city size and building count each check ran on; list the goals not yet met (generation time, sim-process memory) as unmet goals, not as a "backlog" line; never say "done" for the architecture until generation, opening and playing of the 10 km city are all verified with numbers and photos on that city. Related: [[finish-means-finish]], [[architecture-state-2026-10-26]].
