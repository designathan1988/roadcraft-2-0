import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLargeCityMap } from '@editor/smallCityMap';
import { prepareCity } from '@editor/preparedCity';
import { CELL } from '@render/roadSurfaceEntries';
import { ROAD_TYPES } from '@world/roadTypes';
import type { SegmentId } from '@world/ids';
import { installNullPage, primeCookedSurfaces } from '../support/nullGpu';
import { HEIGHT, WIDTH, drawnPieces, openCityMap, type City, type View } from '../support/sceneHarness';

/**
 * A ROAD EDITED FAR FROM THE VIEW IS DRAWN BY THE NETWORK'S FAR LEVEL, MADE AGAIN FOR IT, AND BUILT IN DETAIL FOR NO ONE
 * (`mesh/roadResidency.ts`: the cells built are the view's; `networkFarRoads.ts` outdate): the large city opened on the null GPU as the
 * menu opens it (its view built in detail, every other road at the network's far level), and once the roads are solved the road farthest
 * from the view changed to another class. Its cell stays with the network's far level - no detailed block is built there, the cells
 * taken stay the view's - and the level is made again for the roads drawn.
 */

const OPEN: View = [0, 0, 1.8, 45, 79];
/** The far level's cells (`renderer.ts` FAR_ROAD_CELL): a road block's square, its lines from the origin (`roads/pieceOwner.ts` ownerCell). */
const FAR_CELL = CELL;

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
async function frame(city: City): Promise<void> {
  if (city.net.revision !== city.doc.revision) city.net.rebuild();
  city.scene.draw(city.net, city.sim, 1, 1 / 60);
  await turn();
}

/** The world boxes (plan x0, y0, x1, y1) of the visible meshes whose name passes `named`. */
function boxes(city: City, named: (name: string) => boolean): [number, number, number, number][] {
  // The scene's z is the plan's -y.
  return drawnPieces(city.scene.scene, named).map(({ box }) => [box.min.x, -box.max.z, box.max.x, -box.min.z]);
}

const covers = (list: readonly (readonly [number, number, number, number])[], x: number, y: number): boolean =>
  list.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);

describe('a road edited far from the view', () => {
  let page: { restore(): void };
  let result: { farBefore: boolean; farAfter: boolean; detailAfter: boolean; takenBefore: number; takenAfter: number; farCellInView: boolean };
  beforeAll(async () => {
    page = installNullPage(WIDTH, HEIGHT, process.cwd());
    primeCookedSurfaces(process.cwd());
    const { data, buildings } = prepareCity(buildLargeCityMap(7));
    const { city } = await openCityMap(data, buildings, { large: true, view: OPEN });
    try {
      // The roads past the opening solved, the view's cells built.
      for (let i = 0; i < 600 && (city.scene.openingState().solvePending || city.scene.openingState().roadsWanted > 0 || city.scene.worldBusy); i++) await frame(city);
      // The road farthest from the view, in a cell of the far level the view does not want.
      let far: { id: SegmentId; x: number; y: number; d: number } | null = null;
      for (const [id, ribbon] of city.net.ribbons) {
        const p = ribbon.full.sampleAt(ribbon.full.length / 2).p;
        const d = Math.hypot(p.x, p.y);
        if (!far || d > far.d) far = { id: id as SegmentId, x: p.x, y: p.y, d };
      }
      const cellOf = (v: number): number => Math.floor(v / FAR_CELL);
      const [i, j] = [cellOf(far!.x), cellOf(far!.y)];
      const centre = { x: (i + 0.5) * FAR_CELL, y: (j + 0.5) * FAR_CELL };
      const farOf = (): [number, number, number, number][] => boxes(city, (name) => name === 'road-far-network')
        .filter(([x0, y0, x1, y1]) => (x0 + x1) / 2 >= centre.x - FAR_CELL / 2 && (x0 + x1) / 2 <= centre.x + FAR_CELL / 2 && (y0 + y1) / 2 >= centre.y - FAR_CELL / 2 && (y0 + y1) / 2 <= centre.y + FAR_CELL / 2);
      const farBefore = farOf().length > 0;
      const farCellInView = covers(boxes(city, (name) => name.startsWith('asphalt')), far!.x, far!.y);
      const takenBefore = city.scene.openingState().roadsTaken;
      const segment = city.doc.segments.get(far!.id)!;
      city.doc.setSegmentType(far!.id, (segment.type + 1) % ROAD_TYPES.length);
      // The edit's build, and the network's far level made again for it, land within these frames.
      for (let k = 0; k < 300; k++) await frame(city);
      result = {
        farBefore, farAfter: farOf().length > 0, detailAfter: covers(boxes(city, (name) => name.startsWith('asphalt')), far!.x, far!.y),
        takenBefore, takenAfter: city.scene.openingState().roadsTaken, farCellInView,
      };
      if (process.env['FAR_EDIT_OUT']) writeFileSync(process.env['FAR_EDIT_OUT'], JSON.stringify(result));
    } finally {
      city.scene.dispose();
    }
  }, 1_500_000);
  afterAll(() => page.restore());

  it('leaves the edited road\'s cell to the network\'s far level, built in detail for no one', () => {
    expect(result.farCellInView, 'the farthest road was not among the view\'s cells').toBe(false);
    expect(result.farBefore, 'the cell stood in the far level before the edit').toBe(true);
    expect(result.farAfter, 'the cell stands in the far level after the edit').toBe(true);
    expect(result.detailAfter, 'the edited road drawn in detail').toBe(false);
    expect(result.takenAfter, 'the cells taken: the view\'s, no cell taken for the edit').toBeLessThanOrEqual(result.takenBefore);
  });
});
