import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLargeCityMap } from '@editor/smallCityMap';
import { prepareCity } from '@editor/preparedCity';
import { CELL as BLOCK } from '@render/roadSurfaceInputs';
import { m } from '@world/units';
import { installNullPage, primeCookedSurfaces } from '../support/nullGpu';
import { HEIGHT, WIDTH, drawnPieces, openCityMap, setView, type City, type View } from '../support/sceneHarness';

/**
 * THE ROADS' CELLS FOLLOW THE VIEW, AND ARE THE VIEW'S ALONE (`renderer.ts` cellStep, `mesh/roadResidency.ts`): the city of the
 * 25,000-building step (`scripts/look/step-25k.json`: seed 7 over 2,800 m) opened on the null GPU on the low tier, the camera taken to
 * each corner in turn once the roads past the opening are solved; within a few steps the road block under it is drawn by its detailed
 * blocks (markings, crossings, kerbs), and the network's far level no longer draws there. And the cells built stay a fraction of the
 * map's road cells: the ones the view wanted, under the tier's far budget, the ones left behind let go. DO NOT build the map's cells and
 * let them go after: the page held every block of a 10 km city and died of it (2026-10-26).
 */

/** A road block's side, the far level's cells (`renderer.ts` FAR_ROAD_CELL), its lines from the origin (`roads/pieceOwner.ts` ownerCell). */
const CELL = BLOCK;
/** The frames a corner's block may take to be drawn in detail: a step of a few cells under way when the camera moved, and the corner's own
 *  (on the null GPU no road tile worker is made: each tile is built on the page, a frame each). */
const MOST_FRAMES = 1500;
/** The city's reach from its middle, m (`buildLargeCityMap` radius). */
const REACH = m(2800);

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
async function frame(city: City): Promise<void> {
  if (city.net.revision !== city.doc.revision) city.net.rebuild();
  city.scene.draw(city.net, city.sim, 1, 1 / 60);
  await turn();
}

const cellOf = (x: number, y: number): string => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

/** The road cells the network passes through (its centrelines sampled every 20 m). */
function roadCells(city: City): Set<string> {
  const cells = new Set<string>();
  for (const ribbon of city.net.ribbons.values()) {
    const line = ribbon.full;
    for (let s = 0; s <= line.length; s += m(20)) { const f = line.sampleAt(Math.min(s, line.length)); cells.add(cellOf(f.p.x, f.p.y)); }
  }
  return cells;
}

/** The triangles each kind of road mesh draws in a cell: the detailed blocks' carriageway (`asphalt...`), and the network's far level. */
function drawnIn(city: City, key: string): { detailed: number; network: number } {
  const out = { detailed: 0, network: 0 };
  for (const network of [true, false]) {
    for (const { box, triangles } of drawnPieces(city.scene.scene, (name) => (network ? name === 'road-far-network' : name.startsWith('asphalt')))) {
      // The scene's z is the plan's -y; a block (a cell of the far level) lies in one cell: its middle tells which.
      if (cellOf((box.min.x + box.max.x) / 2, -(box.min.z + box.max.z) / 2) !== key) continue;
      if (network) out.network += triangles; else out.detailed += triangles;
    }
  }
  return out;
}

interface Corner { readonly name: string; readonly frames: number; readonly ms: number; readonly taken: number; readonly detailed: number; readonly network: number }

describe('the roads\' cells follow the view', () => {
  let page: { restore(): void };
  const corners: Corner[] = [];
  let mapCells = 0;
  let takenAtEnd = 0;
  beforeAll(async () => {
    page = installNullPage(WIDTH, HEIGHT, process.cwd());
    primeCookedSurfaces(process.cwd());
    const { data, buildings } = prepareCity(buildLargeCityMap(7, REACH));
    const { city } = await openCityMap(data, buildings, { large: true, view: [0, 0, 1.8, 45, 79], quality: 'low' });
    try {
      mapCells = roadCells(city).size;
      // The view's cells are taken once the roads past the opening are solved (`completeSolve`).
      for (let i = 0; i < 600 && city.scene.openingState().solvePending; i++) await frame(city);
      process.stderr.write(`[cells] solved; ${city.scene.openingState().roadsTaken} cells taken of ${mapCells} with roads
`);
      const reach = m(2400);
      for (const [name, x, y] of [['ne', 0.7, 0.7], ['sw', -0.7, -0.7], ['nw', -0.7, 0.7], ['se', 0.7, -0.7]] as const) {
        const view: View = [x * reach, y * reach, 2.5, 45, 48];
        setView(city.scene, view);
        const key = cellOf(view[0], view[1]);
        const since = performance.now();
        let frames = 0, drawn = drawnIn(city, key);
        for (; frames < MOST_FRAMES && !(drawn.detailed > 0 && drawn.network === 0); frames++) {
          await frame(city);
          drawn = drawnIn(city, key);
        }
        corners.push({ name, frames, ms: Math.round(performance.now() - since), taken: city.scene.openingState().roadsTaken, ...drawn });
        process.stderr.write(`[cells] ${JSON.stringify(corners[corners.length - 1])}
`);
      }
      // The last corner's view left to stand: what it wants built, what it does not want let go.
      for (let i = 0; i < 400 && (city.scene.openingState().roadsWanted > 0 || city.scene.worldBusy); i++) await frame(city);
      takenAtEnd = city.scene.openingState().roadsTaken;
    } finally {
      city.scene.dispose();
    }
  }, 1_500_000);
  afterAll(() => page.restore());

  it('draws the block under the camera in detail within a few steps at each corner', () => {
    expect(corners.length).toBe(4);
    for (const c of corners) {
      expect(c.detailed, `${c.name}: detailed road triangles under the camera`).toBeGreaterThan(0);
      expect(c.network, `${c.name}: far network triangles under the camera`).toBe(0);
      expect(c.frames, `${c.name}: frames to the detailed roads`).toBeLessThan(MOST_FRAMES);
    }
  });

  it('builds the view\'s cells and never the map\'s: the cells taken stay under half the map\'s road cells', () => {
    expect(mapCells).toBeGreaterThan(40);
    for (const c of corners) expect(c.taken, `${c.name}: cells taken of ${mapCells}`).toBeLessThan(mapCells / 2);
    expect(takenAtEnd, `cells taken once the last view stands, of ${mapCells}`).toBeLessThan(mapCells / 2);
  });
});
