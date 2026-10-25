# Optimization brief (shared by every agent)

Repository: `C:\Users\Jonathan\Documents\Projects\city\roadcraft` (TypeScript, three.js r186, Vite). Work ONLY in the files your task lists. Other agents own the other files at the same time; touching theirs breaks the work.

## The source of truth

`reports/engine-geometry/rows/*.json`: one record per object the game draws (3,084). Each has `group`, `name`, `variation`, `source` (file and function that builds it), `triangles`, `vertices`, `attributes`, `bytesPerVertex`, `levels` (LOD triangles), `hiddenTriangles`, `solids`, `target` (the triangle budget it must come down to) and `advice` (exactly what to change). `reports/polygon-geometry-audit.md` has the per-file audit with line numbers (search it for your file names). `reports/geometry-optimization-research.md` and `reports/geometry-replacement-research.md` give the techniques with sources. Read every row of your groups before touching code: `python -c` over the JSON is fine.

## What "optimize" means here (the owner's rule, non-negotiable)

- Fewer triangles and bytes for the SAME picture. Nothing the player sees is removed: every balcony, railing, AC unit, pot, lamp, sleeper, insulator, marking, leaf stays visible at every distance where it was visible before. At near level it is geometry with fewer triangles (hidden faces removed, cylinders with 6-8 sides instead of 12-18, open cylinders where caps never show, boxes instead of subdivided rounded boxes, one quad per flat face, indexed instead of non-indexed). At far levels it is drawn cheaper (a textured/alpha-tested card, a painted face in the shader, a decal) — never dropped.
- Every object gets levels of detail where the row says "No level of detail": a ladder of simplified meshes (meshoptimizer `simplify`, weld first, lock borders where parts meet) and/or a card/impostor past a few pixels, chosen by screen-size error the way the existing code does it (`partLevelsWork.ts`, `vehicleLevels.ts`, `kit.ts` SIMPLIFIED, `plantImpostors.ts` are the in-repo examples).
- Remove the `hiddenTriangles` the row counts: faces inside another solid or pressed face to face.
- Vertex formats: where the row says "N bytes a vertex: quantize", use the narrow formats the engine already supports for that layer (see `cellArrays.ts` quantized shell/mass layouts, `KHR_mesh_quantization`-style normalized Int16 positions / Int8 octahedral normals / Uint8 colours). Do it where the material/shader path can take it without a new program per object; say in the report where it cannot.
- Indexed geometry everywhere a non-indexed one is built for no reason (cards 6 vertices a quad → 4 + index; `toNonIndexed` for flat shading → keep flat normals via `toCreasedNormals` or per-face vertices only where normals differ).
- Uint16 indices when under 65,536 vertices.
- Duplicate meshes ("Same triangles and vertices as X: load one mesh and change its colour") → one geometry shared, colour per instance/material.
- Textures the row flags as uncompressed → cooked KTX2 through the existing pipeline (`scripts/vite/ktx2.ts`, `surface-bake-plugin.ts`, `src/render/ktx2Texture.ts` readKtx2) — if that is in your scope.
- Hit the row's `target` or get as close as the shape allows; report the number you reached per object, computed from the geometry you build (count the triangles in code or with a quick node/vitest script over the builder), not estimated.

## Hard rules

- Do NOT run the game, the dev server, Playwright, screenshots or any measurement in the browser. Work in the code. You may run `npx tsc --noEmit` (whole project) and `npx eslint <your files>`, and `npx vitest run <specific spec files>` for your own modules' unit tests. Fix what breaks in your files; if a test outside your files breaks because of a legitimate change, update that test and say so.
- No feature removal, no "simplified version that drops X", no `?flag` paths, no fallbacks kept "just in case". No `any`. Match the surrounding code style (English, terse comments explaining why).
- Do not claim anything you did not do. The final report must list: each file changed, each object/group with triangles before → after and bytes/vertex before → after, LOD levels added, hidden faces removed, what you could NOT do and why (precisely), and which tests you ran with their result. If something is only partly done, say "partly" and what is missing.
- Keep the shaders' program count from growing (every `customProgramCacheKey`/define variant is a program): prefer uniforms and vertex attributes over new material variants.
