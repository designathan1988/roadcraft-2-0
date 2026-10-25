import { readFileSync } from 'node:fs';
import { Color } from 'three';
import { describe, expect, it } from 'vitest';

import { PALETTE_TEXELS, roadMarks } from '@render/roadMarks';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { MarkingStyleId } from '@world/roads/markingStyle';

/** THE ROADS' PAINT PALETTE, MADE AT LOAD (`roadMarks.ts`): every colour a mark is painted in is in it before any road is, and the shader inks a mark
 *  in its palette entry's colour (the paint's tone, the colour at 0.88, linear, as the paint's material had it). */
describe('the paint palette', () => {
  const atLoad = roadMarks.colours();
  const cities = [
    () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' })),
    () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document),
    () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8'))),
  ];
  for (const style of ['classic', 'br', 'us', 'eu'] as MarkingStyleId[]) {
    it(`holds every colour painted in the ${style} standard`, () => {
      const seen = new Set<string>();
      for (const make of cities) {
        const doc = make();
        doc.setMarkingStyle(style);
        const net = new Network(doc);
        net.rebuild();
        // Every road's and junction's marks, as the road surfaces place them (`roadSurfaceInputs.ts`).
        const inputs = new SurfaceInputs();
        inputs.refresh(net);
        for (const color of roadMarks.placedColours(doc)) seen.add(color);
      }
      expect(seen.size).toBeGreaterThan(1);
      expect([...seen].filter((c) => !atLoad.includes(c))).toEqual([]);
      expect(atLoad.length).toBeLessThanOrEqual(PALETTE_TEXELS);
    });
  }

  it('is what the shader reads a mark\'s colour from: each entry its texel, the paint\'s tone', () => {
    const data = roadMarks.texture.value.image.data as Float32Array;
    const tone = new Color();
    atLoad.forEach((color, index) => {
      expect(roadMarks.paletteIndex(color)).toBe(index);
      tone.set(color).multiplyScalar(0.88);
      expect([...data.slice(index * 4, index * 4 + 4)].map((v) => +v.toFixed(5))).toEqual([tone.r, tone.g, tone.b, 1].map((v) => +v.toFixed(5)));
    });
    // The chunk inks a run of a colour in that texel's colour (`roadMarksShader.ts` roadMarkInk), read from the entry's palette index.
    const chunk = readFileSync('src/render/roadMarksShader.ts', 'utf8');
    expect(chunk).toMatch(/int colour = int\(entry\.y \+ 0\.5\);/);
    expect(chunk).toMatch(/roadMark\(colour\)\.rgb/);
    // No paint material made at load any more: the renderer makes none, the road surfaces read none.
    const renderer = readFileSync('src/render/renderer.ts', 'utf8');
    expect(renderer).not.toMatch(/paintCatalogue/);
    expect(readFileSync('src/render/roadSurfaces.ts', 'utf8')).not.toMatch(/paintFor|paintMaterial/);
  });
});
