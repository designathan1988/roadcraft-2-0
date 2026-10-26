import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Work a pixel skips where its result weighs nothing; the picture is the same (what was skipped was multiplied by 0). */
describe('the shaders skip what weighs nothing', () => {
  it("roads: the wear's noise only over each term's threshold (VIA-09)", () => {
    const src = readFileSync('src/render/wear.ts', 'utf8');
    expect(src).toMatch(/if \(wear > 0\.55\) \{\s*float holes = smoothstep\(0\.55,/);
    expect(src).toMatch(/if \(wear > 0\.3\) \{\s*float cracks = smoothstep\(0\.3,/);
    expect(src).toMatch(/if \(wear > 0\.0\) \{\s*float stain = smoothstep\(0\.0,/);
  });
  it('roads: the close-up detail read only where it weighs, with the derivatives taken outside the branch (VIA-05)', () => {
    const src = readFileSync('src/render/mesh/detailLayer.ts', 'utf8');
    // Read where the road material and the structures' layers read it (`mesh/roadEdges.ts` ROAD_MAP, applyRoadLayers): every read guarded so.
    const reads = readFileSync('src/render/mesh/roadEdges.ts', 'utf8');
    // The derivatives right before the guarded read; the road material's own read also inside its `#ifdef ROAD_DETAIL` (a batch's material has none, `roadEdges.ts`).
    const guarded = reads.match(/vec2 detailDx = dFdx\(detailUv\), detailDy = dFdy\(detailUv\);\s*(?:#ifdef ROAD_DETAIL\s*)?if \(detailW > 0\.0\) \{/g) ?? [];
    expect(guarded.length).toBeGreaterThan(0);
    expect(guarded.length).toBe((reads.match(/vec2 detailDx = /g) ?? []).length);
    expect(src).not.toMatch(/texture2D\(tex,/);
    expect(src).toMatch(/textureGrad\(tex, uv, dx, dy\)/);
  });
  it('terrain: the paint layers read only on a plate painted (TER-02)', () => {
    const src = readFileSync('src/render/terrain.ts', 'utf8');
    expect(src).toMatch(/if \(uHasPaint > 0\.5\) \{\s*pa = texture\(uPaint/);
    expect(src).toMatch(/uHasPaint\.value = 1;/);
  });
});
