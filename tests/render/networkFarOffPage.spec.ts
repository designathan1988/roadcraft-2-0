import { describe, expect, it } from 'vitest';
import { layCity } from '@editor/cityGenerator';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { FLAT_GROUND, buildRoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { RELIEF_FLAT } from '@world/terrain';
import { farLevelOf, farRoadInput } from '@render/networkFarInput';
import { FAR_CARRIAGEWAY, FAR_SECTION, buildFarRoadCells } from '@render/networkFarRoadsBuild';
import { pageSlots, resolveFarPieces } from '@render/networkFarRoads';
import { roadPaint } from '@render/roadPaint';

/**
 * THE MAP'S FAR LEVEL MADE OFF THE PAGE (`networkFarInput.ts` farLevelOf, `networkFarRoads.ts` resolveFarPieces): every cell's triangles as
 * the page would make them from its own whole network, and each carriageway vertex's paint the same once its piece's id is resolved to the
 * page's slot - the lines the shader inks read from the same texels.
 */

describe("the map's far level off the page", () => {
  it("is the page's own, cell for cell, its paint the same at every vertex", () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 3, size: 'small' }));
    doc.terrainRelief = RELIEF_FLAT;
    const net = new Network(doc);
    net.rebuild();
    const cell = 250;
    // The page's, from its own network.
    const elevation = buildRoadElevation(net, FLAT_GROUND);
    const own = buildFarRoadCells(farRoadInput(net, { onSegment: (s, x, y) => elevation.onSegment(s, x, y), at: (x, y) => elevation.at(x, y) }, FLAT_GROUND, cell, null, pageSlots(net)).input);
    // Off the page, as the message clones it, made the page's.
    const level = structuredClone(farLevelOf(net, cell).level);
    expect(level.paints.length).toBe(doc.segments.size);
    resolveFarPieces(level, doc);
    const byKey = (cells: readonly (typeof own)[number][]): Map<string, (typeof own)[number]> => new Map(cells.map((c) => [`${c.key}|${c.layer}`, c]));
    const a = byKey(own), b = byKey(level.cells);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    const table = roadPaint.segments.value.image.data as Float32Array;
    const texels = (slot: number): number[] => [...table.subarray(slot * 4 * 4, slot * 4 * 4 + 8)];
    let carriageways = 0;
    for (const [key, mine] of a) {
      const theirs = b.get(key)!;
      expect(theirs.positions).toEqual(mine.positions);
      expect(theirs.indices).toEqual(mine.indices);
      expect(theirs.colors).toEqual(mine.colors);
      if (mine.layer !== FAR_CARRIAGEWAY) continue;
      carriageways++;
      expect(theirs.sections.length).toBe(mine.sections.length);
      for (let v = 0; v < mine.sections.length / FAR_SECTION; v++) {
        const at = v * FAR_SECTION;
        expect(theirs.sections[at]).toBe(mine.sections[at]);
        expect(theirs.sections[at + 1]).toBe(mine.sections[at + 1]);
        // The same slot: both count the document's slots out by id (`roadPaint.ts`), and the same texels at it.
        const slot = mine.sections[at + 2]!, other = theirs.sections[at + 2]!;
        expect(other).toBe(slot);
        if (slot >= 0) expect(texels(other)).toEqual(texels(slot));
      }
    }
    expect(carriageways).toBeGreaterThan(1);
  });
});
