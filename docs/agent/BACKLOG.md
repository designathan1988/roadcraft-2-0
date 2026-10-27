# Backlog: what was found on the way, to fix after the task in hand is finished

The owner's order (2026-10-27): fix one thing at a time; anything found on the way is written here and left until the current task is
done. Each entry: what, where (file:line or the view), the evidence, and its state.

## Open

1. **Night from afar: the far building levels glow as one beige mass.** All far levels (masses, tile, plate, base) share
   `src/render/buildings/massingMaterial.ts`; under a pixel the lit panes' radiance is averaged before tone mapping, so the wall comes out
   bright where the detail leaves it dark round its lit panes. Evidence: `reports/in-game/2026-10-27-pass/03-night-far-crop.png` against
   the detail at night (same pass). State: a Reinhard-compensated emissive and the panes' true share (`massPanes`) in the working tree;
   seen once (reports/in-game/2026-10-27-pass/05) still too bright; set aside by the owner's order (camera, LOD, roads first). The work in
   progress is saved in the scratchpad (massingMaterial.night-wip.ts); the file is put back to its committed state.
2. **`tests/render/cellAffinity.spec.ts`** "runs a square's masses at every level on one worker" fails on the code before 2026-10-27 too.
3. **Roads: a cell needs its 1 km tile held by the page's network** (`renderer.ts` cellHeld, `RoadWindowLink`): check in the game whether the
   view's cells now land at once after `VIEW_STEP_CELLS` (cd917b6f).
4. **Base level: pitched roofs still flat at half their rise** (`massBase.ts` recordBase).
5. **`scripts/inGame.mjs` cannot see the Electron page** (Playwright `connectOverCDP` lists no page while `/json/list` has it); the
   scratchpad CDP driver worked instead. Fix the project's script.
6. **The window's height flips between 1079 and 1080 px** and each flip reallocates every render target (`renderer.ts` resize,
   `screenSize.ts`; `WebGLRenderer.setDrawingBufferSize` in the CPU profile).
7. **Half-float 3-component vertex attributes** (`HALF x3 stride 6`, the parts' instance colours: `partCells.ts`, `farParts.ts`,
   `buildingMesh.ts`): ANGLE's D3D11 has no 3-channel 16-bit format and converts them
   (https://github.com/Microsoft/angle/wiki/Getting-Good-Performance-From-ANGLE).

8. **F7 misses GPU stalls and GPU saturation**: add per-draw GPU timing in slow frames, CPU vs GPU per draw, GPU work outside the
   game's frame by caller (the scratchpad probes drawtimer.js / outside.js did it), into `src/lab/doctor`.
9. **The people's animation palettes render every frame for every batch** (`crowdAnimation.ts:276` via `riggedCitizens.ts` renderPalettes):
   ~950 renders a second, even with the people off screen.

## Done
- (2026-10-27) Parks' pale streaks: the squares' walks were concrete dabs of 1.4 m faded over their radius on 2-4 m paint texels; the paving now laid hard by coverage (`rasterPaint`) and cut at half weight in the shader. Photos: reports/in-game/2026-10-27-lod/14, 15.
(none yet)
