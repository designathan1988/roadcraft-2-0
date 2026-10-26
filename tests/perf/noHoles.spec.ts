import { Box3, Frustum, Matrix4, type Mesh, type Object3D } from 'three';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLargeCityMap } from '@editor/smallCityMap';
import { prepareCity } from '@editor/preparedCity';
import { geometryCost, gpuLedger } from '@render/gpuLedger';
import { levelsOf } from '@render/mesh/roadLod';
import { GEOMETRY_BUDGETS, NETWORK_FAR_MB, type QualityLevel, roadBudgetMB } from '@render/quality';
import { CELL as ROAD_BLOCK } from '@render/roadSurfaceEntries';
import { m } from '@world/units';
import { installNullPage, primeCookedSurfaces } from '../support/nullGpu';
import { HEIGHT, WIDTH, drawnPieces, openCityMap, setView, type City, type View } from '../support/sceneHarness';

/**
 * NO HOLE IN THE TOWN OR IN ITS STREETS AT ANY VIEW: the city of 25,000 buildings (`scripts/look/step-25k.json`) opened on the null GPU as
 * the menu opens it, on every tier. Right after the curtain the camera jumps to the map and to each corner and edge at mid distance, a
 * few frames each; then the view's road cells are let build (the cells the view wants, never the map's: `mesh/roadResidency.ts`), and the
 * camera tours the photographs' views, each till it stands, the masses out of the view let go for the tier's budget on the way. At every stop:
 * - every 256 m cell of buildings is drawn by something (its detail, its masses, its tile's or plate's, the base's: `buildingCensus`,
 *   `render/buildings/massBase.ts`), the base's meshes in the scene and shown;
 * - every road block's cell (614.4 m) in the view's frustum that has roads has road surface drawn (a block's full or far level, or the
 *   network's far level), and the blocks' full levels hold no more than the tier's `roadsNearMB` (`render/mesh/roadResidency.ts`);
 * - once each view stands, the view wants no cell it has not got, the blocks' far levels hold no more than the tier's `roadsFarMB` (the
 *   cells past it drawn by the network's far level), and the roads' surfaces together no more than `roadBudgetMB`.
 */

const OPEN: View = [0, 0, 1.8, 45, 79];
const TIERS = (process.env['CENSUS_TIERS'] ?? 'low,medium,high,ultra').split(',') as QualityLevel[];
/** Frames a tour's view may take to stand, and frames in a row alike for it to stand. */
const MOST = 200;
const STILL = 8;
/** Frames the view's road cells may take to be built before the tour (on the null GPU their tiles are cut on the page, a frame each). */
const CELL_FRAMES = 6000;
const MIB = 1048576;
/** The city's reach from its middle, m (`buildLargeCityMap` radius). */
const REACH = m(2800);
/** The side of the cells the roads are counted in (the road blocks', `roadSurfaces.ts`). */
const ROAD_CELL = ROAD_BLOCK;

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
async function frame(city: City): Promise<void> {
  if (city.net.revision !== city.doc.revision) city.net.rebuild();
  city.scene.draw(city.net, city.sim, 1, 1 / 60);
  await turn();
}
async function frames(city: City, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame(city);
}

/** The cells of buildings nothing draws, and how many cells each level draws. */
function buildingCensus(city: City): { holes: string[]; by: Record<string, number> } {
  const holes: string[] = [];
  const by: Record<string, number> = {};
  for (const [key, drawn] of city.scene.buildingCensus()) {
    by[drawn ?? 'none'] = (by[drawn ?? 'none'] ?? 0) + 1;
    if (drawn === null) holes.push(key);
  }
  let baseShown = 0;
  city.scene.scene.traverseVisible((o) => { if (o.name === 'building-massing-base') baseShown++; });
  if ((by['base'] ?? 0) > 0 && baseShown === 0) holes.push('base drawn by no visible mesh');
  return { holes, by };
}

const roadCellOf = (x: number, y: number): string => `${Math.floor(x / ROAD_CELL)},${Math.floor(y / ROAD_CELL)}`;

/** The road cells the network passes through (its centrelines sampled every 20 m). */
function roadCells(city: City): Set<string> {
  const cells = new Set<string>();
  for (const ribbon of city.net.ribbons.values()) {
    const line = ribbon.full;
    for (let s = 0; s <= line.length; s += m(20)) { const f = line.sampleAt(Math.min(s, line.length)); cells.add(roadCellOf(f.p.x, f.p.y)); }
  }
  return cells;
}

/** The road cells in the camera's frustum with roads and no road surface drawn; the blocks' full and far levels' bytes, the network's far level's, and every road surface's together. */
function roadCensus(city: City, wanted: ReadonlySet<string>): { missing: string[]; nearMB: number; farMB: number; networkMB: number; roadsMB: number } {
  const camera = city.scene.viewCamera();
  camera.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const drawn = new Set<string>();
  const box = new Box3();
  let near = 0, far = 0, network = 0, roads = 0;
  city.scene.scene.traverse((o: Object3D) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const levels = levelsOf(mesh);
    const bytes = geometryCost(mesh.geometry).bytes;
    if (levels?.coarse && levels.full) near += bytes;
    if (mesh.name.endsWith('-far') && mesh.parent?.name === 'road-network') far += bytes;
    if (mesh.name === 'road-far-network') network += bytes;
    if (mesh.parent?.name === 'road-network' || mesh.name === 'road-far-network') roads += bytes;
  });
  for (const { box: piece } of drawnPieces(city.scene.scene, (name) => name.startsWith('asphalt') || name === 'road-far-network')) {
    box.copy(piece);
    for (let i = Math.floor(box.min.x / ROAD_CELL); i <= Math.floor(box.max.x / ROAD_CELL); i++) {
      for (let j = Math.floor(-box.max.z / ROAD_CELL); j <= Math.floor(-box.min.z / ROAD_CELL); j++) drawn.add(`${i},${j}`);
    }
  }
  const missing: string[] = [];
  for (const key of wanted) {
    const [i, j] = key.split(',').map(Number) as [number, number];
    // The cell's box in three's axes (the plan's y is -z), from below the ground to over any deck.
    box.min.set(i * ROAD_CELL, -50, -(j + 1) * ROAD_CELL);
    box.max.set((i + 1) * ROAD_CELL, 100, -j * ROAD_CELL);
    if (frustum.intersectsBox(box) && !drawn.has(key)) missing.push(key);
  }
  return { missing, nearMB: near / MIB, farMB: far / MIB, networkMB: network / MIB, roadsMB: roads / MIB };
}

interface Stop {
  readonly name: string; readonly holes: readonly string[]; readonly by: Record<string, number>; readonly baseMB: number; readonly massesMB: number; readonly evictions: number;
  readonly roadsMissing: readonly string[]; readonly roadsNearMB: number; readonly roadsFarMB: number; readonly roadsNetworkMB: number; readonly roadsMB: number;
  /** The road cells the view wants not built yet, and the cells built or being built (`mesh/roadResidency.ts`). */
  readonly roadsWanted: number;
  readonly roadsTaken: number;
}

async function tour(tier: QualityLevel): Promise<{ stops: Stop[]; frames: number; cellFrames: number; roadCells: number }> {
  primeCookedSurfaces(process.cwd());
  const { data, buildings } = prepareCity(buildLargeCityMap(7, REACH));
  const { city, frames: opened } = await openCityMap(data, buildings, { large: true, view: OPEN, quality: tier });
  const roads = roadCells(city);
  const stops: Stop[] = [];
  const stop = (name: string): void => {
    const { holes, by } = buildingCensus(city);
    const { missing, nearMB, farMB, networkMB, roadsMB } = roadCensus(city, roads);
    const masses = ['plate masses', 'tile masses', 'cell masses', 'base masses'] as const;
    stops.push({
      name, holes: holes.slice(0, 12), by, baseMB: gpuLedger.bytes('base masses') / MIB,
      massesMB: masses.reduce((sum, cls) => sum + gpuLedger.bytes(cls), 0) / MIB, evictions: city.scene.buildingLevels()['evictions'] ?? 0,
      roadsMissing: missing, roadsNearMB: nearMB, roadsFarMB: farMB, roadsNetworkMB: networkMB, roadsMB,
      roadsWanted: city.scene.openingState().roadsWanted, roadsTaken: city.scene.openingState().roadsTaken,
    });
  };
  let cellFrames = 0;
  try {
    stop('opening');
    // Right after the curtain: the map, then each corner and edge at mid distance, three frames each.
    const jumps: [string, View][] = [['map', [0, 0, 0.12, 45, 48]]];
    for (const [name, x, y] of [['ne', 0.7, 0.7], ['sw', -0.7, -0.7], ['nw', -0.7, 0.7], ['se', 0.7, -0.7], ['e', 0.8, 0], ['n', 0, 0.8]] as const) jumps.push([`${name}-mid12`, [x * REACH, y * REACH, 1.2, 45, 48]]);
    for (const [name, view] of jumps) {
      setView(city.scene, view);
      await frames(city, 3);
      stop(`early ${name}`);
    }
    // The district view's road cells built: the ones the view wants, the roads past the opening solved first (`completeSolve`).
    setView(city.scene, [0, 0, 2.5, 45, 48]);
    for (; cellFrames < CELL_FRAMES && (city.scene.openingState().solvePending || city.scene.openingState().roadsWanted > 0 || city.scene.worldBusy); cellFrames++) await frame(city);
    stop('district built');
    // The tour: each view till it stands, the governor's read every frame; a census on arrival and once it stands.
    const views: [string, View][] = [
      ['map', [0, 0, 0.12, 45, 48]], ['district', [0, 0, 2.5, 45, 48]], ['street', [150, 0, 5, 20, 35]],
      ['ne-district', [1960, 1960, 2.5, 45, 48]], ['sw-district', [-1960, -1960, 2.5, 45, 48]], ['e-mid12', [2240, 0, 1.2, 45, 48]],
      ['n-district', [0, 2240, 2.5, 45, 48]], ['back-map', [0, 0, 0.12, 45, 48]], ['nw-mid12', [-1960, 1960, 1.2, 45, 48]], ['back-district', [0, 0, 2.5, 45, 48]],
    ];
    for (const [name, view] of views) {
      setView(city.scene, view);
      await frame(city);
      stop(`${name} arrived`);
      let last = '', still = 0;
      for (let i = 0; i < MOST && still < STILL; i++) {
        await frame(city);
        city.scene.governGeometry();
        const key = JSON.stringify(city.scene.buildingLevels());
        still = key === last && !city.scene.worldBusy ? still + 1 : 0;
        last = key;
      }
      stop(`${name} settled`);
    }
    return { stops, frames: opened, cellFrames, roadCells: roads.size };
  } finally {
    city.scene.dispose();
  }
}

describe('the city of 25,000 buildings has no hole in its town or its streets at any view, on every tier', () => {
  let page: { restore(): void };
  const tours = new Map<QualityLevel, Awaited<ReturnType<typeof tour>>>();
  beforeAll(async () => {
    page = installNullPage(WIDTH, HEIGHT, process.cwd());
    for (const tier of TIERS) {
      tours.set(tier, await tour(tier));
      if (process.env['CENSUS_OUT']) writeFileSync(process.env['CENSUS_OUT'], JSON.stringify(Object.fromEntries(tours), null, 1));
    }
  }, 9_000_000);
  afterAll(() => page.restore());

  it('draws every cell of buildings right after the opening and through a tour that lets levels go', () => {
    for (const [tier, { stops }] of tours) for (const stop of stops) expect(stop.holes, `${tier} ${stop.name}: cells of buildings nothing draws`).toEqual([]);
  });

  it('lets levels go for the budget on the way (the tour proves the base under them)', () => {
    for (const [tier, { stops }] of tours) if (tier === 'low') expect(stops.at(-1)!.evictions, `${tier}: levels let go`).toBeGreaterThan(0);
  });

  it('keeps the base small: under a tenth of the lowest tier\'s masses budget', () => {
    for (const [tier, { stops }] of tours) expect(stops.at(-1)!.baseMB, `${tier}: the base's MB`).toBeLessThan(GEOMETRY_BUDGETS.low.massesMB / 10);
  });

  it('draws road surface in every road cell of the view at every stop', () => {
    for (const [tier, { stops }] of tours) for (const stop of stops) expect(stop.roadsMissing, `${tier} ${stop.name}: road cells in view with no road drawn`).toEqual([]);
  });

  it('holds the roads\' full levels under the tier\'s budget at every stop, the view\'s cells building on', () => {
    for (const [tier, { stops }] of tours) {
      const budget = GEOMETRY_BUDGETS[tier].roadsNearMB;
      for (const stop of stops) expect(stop.roadsNearMB, `${tier} ${stop.name}: the roads' full levels, MB`).toBeLessThanOrEqual(budget);
    }
  });

  it('holds the roads\' far levels and the roads\' whole under the tier\'s budgets once each view stands, wanting no cell it has not got', () => {
    for (const [tier, { stops }] of tours) {
      const budget = GEOMETRY_BUDGETS[tier];
      for (const stop of stops.filter((s) => s.name.endsWith('settled'))) {
        expect(stop.roadsWanted, `${tier} ${stop.name}: the road cells the view wants not built`).toBe(0);
        expect(stop.roadsFarMB, `${tier} ${stop.name}: the roads' far levels, MB`).toBeLessThanOrEqual(budget.roadsFarMB);
        expect(stop.roadsNetworkMB, `${tier} ${stop.name}: the network's far level, MB`).toBeLessThanOrEqual(NETWORK_FAR_MB);
        expect(stop.roadsMB, `${tier} ${stop.name}: the roads' surfaces, MB`).toBeLessThanOrEqual(roadBudgetMB(budget));
      }
    }
  });

  it('builds the view\'s road cells and never the map\'s: the cells taken stay under the map\'s road cells at every stop', () => {
    for (const [tier, { stops, roadCells }] of tours) {
      expect(roadCells).toBeGreaterThan(40);
      for (const stop of stops) expect(stop.roadsTaken, `${tier} ${stop.name}: cells taken of ${roadCells}`).toBeLessThan(roadCells);
    }
  });
});
