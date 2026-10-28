---
name: architecture-judged-by-code
description: "whether the architecture is right is judged from the code (page work that scales with the whole map), never from measurements; no measurement runs to diagnose"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 610f72a3-1929-4841-bc3b-2b58caed3c35
  modified: 2026-10-26T14:30:05.184Z
---



The criterion for right/wrong architecture is the code, not measurements. A code path on the page that walks, builds or keeps something for the WHOLE map (every node, lot, tile or block of the map, the whole network's extent) instead of only what is near the camera is wrong architecture for 10 km cities. Find these by reading, list them with file:line, fix them.

**Why:** 2026-10-26 the owner, after I ran heap measurements of the 10 km city and an inferred number in my report (1 GB "the document") had to be corrected, wrote: "O critério para definir se a arquitetura está certa ou errada é o código e não medições. O código contém a arquitetura… parar de uma vez por todas com suas medições estéreis e burras". He also condemned changing diagnosis: a claim must be settled before it is stated.

**How to apply:** never run a measurement to diagnose or to judge the architecture; read the code. Never state a number or an attribution that was not read in the code or already measured; mark inferences as inferences. Measurements only as the final confirmation of a finished fix, once. Related: [[find-by-reading-not-suites]], [[rebuild-dont-patch]], [[f7-single-measurement]].
