import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Box3, type BufferGeometry, type InstancedMesh, type InterleavedBufferAttribute } from 'three';
import { Rng } from '@core/rng';
import { CELL } from '@world/cells';
import { instantiate } from '@world/buildings/blueprints';
import { madeToMeasure } from '@world/buildings/procedural';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { HYSTERESIS } from '@render/cellInstances';
import { ERROR_PIXELS } from '@render/propLevels';
import { emitProgram, kitBoxes } from '@render/buildings/buildingMesh';
import { cellArrays } from '@render/buildings/cellArrays';
import type { BuildingChunk } from '@render/buildings/chunk';
import { FarPartBatch } from '@render/buildings/farParts';
import { type BuildingKit, PART_KINDS, type PartKind, type PartLevel, createBuildingKit } from '@render/buildings/kit';
import { DETAIL_PARTS } from '@render/buildings/layerCells';
import { massFloor } from '@render/buildings/massing';
import { PartCell } from '@render/buildings/partCells';
import { DETAIL_CELL, type PartFiling, fileParts } from '@render/buildings/partFiling';
import { SHELL_PARTS } from '@render/buildings/shellParts';

/** THE FACADE LEVEL'S BATCHED PARTS DRAW A SMALL PROP'S SIMPLIFIED LEVEL ONLY WHERE ITS MEASURED ERROR IS NOT SEEN (`farParts.ts` choose): a level's
 *  two-sided distance from the finest (`kit.ts` measured) times the largest instance scale, on the screen at the nearest cell, under `ERROR_PIXELS`;
 *  else the kind's own coarsest level (a small prop's finest, as the batch drew it before the simplified levels). DO NOT draw a prop at its coarsest
 *  level whatever the distance: a balcony's plants lost their leaves and its pots were crumpled, 3.8 px off at 300 m (the far batch's sheets, 2026-10-24). */

const ground = (): number => 0;
/** A metre's pixels at a metre's distance: 1080 lines under a 35° view (the sheets' measure, `optimization/sheet.ts`). */
const PX_AT_METRE = 1080 / (2 * Math.tan((35 * Math.PI) / 360));
/** The eye's height over the ground. */
const EYE_Z = m(50);

/** The study's tower: the made-to-measure high residential building on the large lot (40 x 36 m), 25 floors (the catalogue's `residentialTower`). */
function tower(at: { x: number; y: number }, id: number): Building {
  const made = madeToMeasure('residential', 'high', { W: m(40), D: m(36) }, new Rng(1));
  return { ...instantiate(made.body, at, 0), id: id as BuildingId } as Building;
}

const cellOf = (b: Building): string => `${Math.floor(b.x / CELL)},${Math.floor(b.y / CELL)}`;

/** A facade cell's parts filed as its job files them (`cellWork.ts` runCellJob: the far program of each building, its detail parts by sub-cell, `fileParts`). */
function facadeFiling(kit: BuildingKit, buildings: readonly Building[], cell: string): PartFiling {
  const boxes = kitBoxes(kit);
  const byDetail = new Map<string, BuildingChunk[]>();
  for (const b of buildings) {
    const chunk = emitProgram(b, ground, undefined, ground, { near: false, far: true }, { floor: massFloor(b, ground) ?? null }).far!;
    const key = `${Math.floor(b.x / DETAIL_CELL)},${Math.floor(b.y / DETAIL_CELL)}`;
    const list = byDetail.get(key);
    if (list) list.push(chunk); else byDetail.set(key, [chunk]);
  }
  const parts = PART_KINDS.filter((k) => DETAIL_PARTS.has(k));
  const details = [...byDetail].map(([key, list]) => [key, cellArrays(list, { parts, shells: false, furniture: false, ghost: false, dim: false }, boxes)] as const);
  return fileParts(cell, details, boxes.bandings!);
}

/** A facade cell as the layer holds it (`cellRequests.ts` land): its shell's parts its own, the whole filing for the batch. */
const facadeCell = (kit: BuildingKit, key: string, filing: PartFiling): PartCell =>
  new PartCell(key, { bands: filing.bands.filter((band) => SHELL_PARTS.has(band.kind)) }, kit, filing);

const trianglesOfGeometry = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** The batch's meshes by kind (`building-<kind>`). */
function meshesOf(batch: FarPartBatch): Map<PartKind, InstancedMesh> {
  const out = new Map<PartKind, InstancedMesh>();
  for (const child of batch.group.children) out.set(child.name.slice('building-'.length) as PartKind, child as InstancedMesh);
  return out;
}

/** What the batch draws of one cell, from its filing: each batched kind's instances there times the geometry its mesh draws. */
function drawnOf(batch: FarPartBatch, filing: PartFiling): number {
  const meshes = meshesOf(batch);
  let n = 0;
  for (const band of filing.bands) {
    const mesh = meshes.get(band.kind);
    if (mesh) n += band.start[band.start.length - 1]! * trianglesOfGeometry(mesh.geometry);
  }
  return n;
}

/** Instances of a kind in a filing. */
const countOf = (filing: PartFiling, kind: PartKind): number =>
  filing.bands.filter((band) => band.kind === kind).reduce((n, band) => n + band.start[band.start.length - 1]!, 0);

/** The largest scale of a kind's instances in a filing (its bands' cell scales, `FiledBand.scale`). */
function scaleOf(filing: PartFiling, kind: PartKind): number {
  let most = 0;
  for (const band of filing.bands) {
    if (band.kind !== kind || band.start[band.start.length - 1]! === 0) continue;
    const s = band.scale, last = s.length - 3;
    most = Math.max(most, s[last]!, s[last + 1]!, s[last + 2]!);
  }
  return most;
}

/** The kit's level a mesh draws. */
const levelDrawn = (kit: BuildingKit, kind: PartKind, mesh: InstancedMesh): PartLevel =>
  kit.screen[kind].levels.find((level) => level.geometry.index === mesh.geometry.index && level.geometry.getAttribute('position') === mesh.geometry.getAttribute('position'))!;

/** The cell `key`'s distance from an eye on the plan at (x, y), `EYE_Z` up (as `FarPartBatch.view` measures it). */
function distanceTo(key: string, x: number, y: number): number {
  const comma = key.indexOf(',');
  const x0 = Number(key.slice(0, comma)) * CELL, y0 = Number(key.slice(comma + 1)) * CELL;
  return Math.hypot(Math.max(x0 - x, 0, x - (x0 + CELL)), Math.max(y0 - y, 0, y - (y0 + CELL)), EYE_Z);
}

describe('the far parts batch and the small props\' measured levels', () => {
  let kit: BuildingKit;
  let keyA = '', keyB = '';
  let filingA: PartFiling, filingB: PartFiling;
  /** The kinds a tower has instances of that have measured levels. */
  let measuredKinds: PartKind[] = [];
  beforeAll(async () => {
    kit = createBuildingKit();
    await kit.levelsReady;
    const a = tower({ x: m(60), y: m(60) }, 1), b = tower({ x: CELL + m(60), y: m(60) }, 2);
    keyA = cellOf(a); keyB = cellOf(b);
    filingA = facadeFiling(kit, [a], keyA);
    filingB = facadeFiling(kit, [b], keyB);
    measuredKinds = PART_KINDS.filter((kind) => countOf(filingA, kind) > 0 && kit.screen[kind].levels.some((level) => level.measured !== undefined));
  });

  /** A batch of the cells, and how often it told the view's budget. */
  function batchOf(keys: readonly string[]): { batch: FarPartBatch; cells: Map<string, PartCell>; told: () => number } {
    let told = 0;
    const batch = new FarPartBatch(kit, () => { told++; });
    const cells = new Map(keys.map((key) => [key, facadeCell(kit, key, key === keyA ? filingA : filingB)] as const));
    batch.sync(cells, () => true);
    return { batch, cells, told: () => told };
  }
  const look = (batch: FarPartBatch, away: number): void => batch.view(-away, CELL / 2, EYE_Z, PX_AT_METRE, null);

  it('draws no kind at a level whose measured error spans more than the bound, and the coarsest that is within it', () => {
    expect(measuredKinds.length).toBeGreaterThan(0);
    const { batch, cells } = batchOf([keyA, keyB]);
    const meshes = meshesOf(batch);
    let simplified = 0;
    // Before any view: every kind at its base, a small prop at its finest (as the batch drew it before the simplified levels).
    console.log(`the 25-floor tower's facade cell at the kinds' bases: ${batch.trianglesOf(keyA)} triangles of the far batch`);
    for (const away of [m(300), m(600), m(1200), m(3000), m(1200), m(300)]) {
      look(batch, away);
      for (const kind of measuredKinds) {
        const mesh = meshes.get(kind)!;
        const worst = Math.max(...[[keyA, filingA], [keyB, filingB]].map(([key, filing]) =>
          scaleOf(filing as PartFiling, kind) * PX_AT_METRE / Math.max(distanceTo(key as string, -away, CELL / 2), 1)));
        const levels = kit.screen[kind].levels;
        const drawn = levelDrawn(kit, kind, mesh);
        expect(drawn, `${kind} at ${away} m`).toBeDefined();
        if (drawn.measured !== undefined) {
          simplified++;
          expect(drawn.measured * worst, `${kind} at ${away} m`).toBeLessThanOrEqual(ERROR_PIXELS);
        }
        // Not finer than the coarsest level within the bound narrowed by the band a level is held in.
        const within = levels.filter((level) => level.measured !== undefined && level.measured * worst <= ERROR_PIXELS / (1 + HYSTERESIS));
        if (within.length) expect(levels.indexOf(drawn), `${kind} at ${away} m`).toBeGreaterThanOrEqual(levels.indexOf(within.at(-1)!));
      }
      // Each cell's triangles those its instances draw.
      expect(batch.trianglesOf(keyA)).toBe(drawnOf(batch, filingA));
      expect(batch.trianglesOf(keyB)).toBe(drawnOf(batch, filingB));
      const drawnLevels = measuredKinds.map((kind) => `${kind} ${levelDrawn(kit, kind, meshes.get(kind)!).triangles}`).join(', ');
      console.log(`the 25-floor tower's facade cell from ${away} m: ${batch.trianglesOf(keyA)} triangles of the far batch (${drawnLevels})`);
    }
    // Some prop simplified somewhere on the way: the rule is not a level never taken.
    expect(simplified).toBeGreaterThan(0);
    batch.dispose();
    for (const cell of cells.values()) cell.dispose();
  });

  it('takes a measured level far off, tells the budget and the sun, and draws the same copy again as the eye comes back', () => {
    const { batch, cells, told } = batchOf([keyA]);
    const meshes = meshesOf(batch);
    look(batch, m(300));
    const near = new Map([...meshes].map(([kind, mesh]) => [kind, mesh.geometry]));
    const nearTold = told();
    // The sun's stores read a batch's castBox, emptied after each pass (`renderer.ts` casterChanges).
    for (const mesh of meshes.values()) (mesh.userData['castBox'] as Box3 | undefined)?.makeEmpty();
    let letGo = 0;
    for (const geometry of near.values()) geometry.addEventListener('dispose', () => { letGo++; });
    look(batch, m(3000));
    const moved = measuredKinds.filter((kind) => meshes.get(kind)!.geometry !== near.get(kind));
    expect(moved.length).toBeGreaterThan(0);
    expect(told()).toBeGreaterThan(nearTold);
    for (const kind of moved) {
      const mesh = meshes.get(kind)!;
      expect(levelDrawn(kit, kind, mesh).measured).toBeDefined();
      expect((mesh.userData['castBox'] as Box3).containsBox(mesh.userData['wholeBox'] as Box3)).toBe(true);
      // The same poses drawn by every copy of the kind.
      expect((mesh.geometry.getAttribute('instancePoseA') as InterleavedBufferAttribute).data)
        .toBe((near.get(kind)!.getAttribute('instancePoseA') as InterleavedBufferAttribute).data);
    }
    // The kinds that did not move: nothing told the sun of them.
    for (const [kind, mesh] of meshes) if (!moved.includes(kind)) expect((mesh.userData['castBox'] as Box3 | undefined)?.isEmpty() ?? true).toBe(true);
    expect(batch.trianglesOf(keyA)).toBe(drawnOf(batch, filingA));
    // Back near: the copies drawn before, kept, not made again; none let go on the way.
    look(batch, m(300));
    for (const kind of moved) expect(meshes.get(kind)!.geometry).toBe(near.get(kind));
    expect(letGo).toBe(0);
    expect(batch.trianglesOf(keyA)).toBe(drawnOf(batch, filingA));
    batch.dispose();
    for (const cell of cells.values()) cell.dispose();
  });

  it('holds a level within the band it is kept in, and does not enter it there', () => {
    // A kind's coarsest measured level, and the distance where its error spans 95 % of the bound: over the bound narrowed by the band.
    const kind = measuredKinds.find((k) => kit.screen[k].levels.filter((level) => level.measured !== undefined).length > 1) ?? measuredKinds[0]!;
    const coarsest = kit.screen[kind].levels.at(-1)!;
    const pixels = (0.95 * ERROR_PIXELS) / (coarsest.measured! * scaleOf(filingA, kind));
    // The eye `away` off the cell's side on the plan, `EYE_Z` up, where a metre at the cell spans `pixels` / scale.
    const away = Math.sqrt(Math.max((PX_AT_METRE / pixels) ** 2 - EYE_Z ** 2, 0));
    const { batch, cells } = batchOf([keyA]);
    const mesh = meshesOf(batch).get(kind)!;
    // From near: not entered.
    look(batch, m(300));
    look(batch, away);
    expect(levelDrawn(kit, kind, mesh)).not.toBe(coarsest);
    // From far: held.
    look(batch, m(5000));
    expect(levelDrawn(kit, kind, mesh)).toBe(coarsest);
    look(batch, away);
    expect(levelDrawn(kit, kind, mesh)).toBe(coarsest);
    batch.dispose();
    for (const cell of cells.values()) cell.dispose();
  });

  it('draws a cell that lands later at its kinds\' levels, and its buffers grown keep them', () => {
    // A measured kind with more instances over both towers than the batch's first buffers hold (256): they grow when the second lands.
    const kind = measuredKinds.find((k) => countOf(filingA, k) <= 256 && countOf(filingA, k) + countOf(filingB, k) > 256);
    expect(kind).toBeDefined();
    const { batch, cells } = batchOf([keyA]);
    const mesh = meshesOf(batch).get(kind!)!;
    look(batch, m(3000));
    const far = levelDrawn(kit, kind!, mesh);
    expect(far.measured).toBeDefined();
    look(batch, m(300));
    look(batch, m(3000));
    // Two copies made by now: the near one kept aside, the far one drawn.
    const drawnCopy = mesh.geometry;
    const poses = (drawnCopy.getAttribute('instancePoseA') as InterleavedBufferAttribute).data;
    const left = { drawn: -1 };
    drawnCopy.addEventListener('dispose', () => { left.drawn = Object.keys(drawnCopy.attributes).length + (drawnCopy.index ? 1 : 0); });
    const both = new Map([...cells, [keyB, facadeCell(kit, keyB, filingB)]]);
    batch.sync(both, () => true);
    // Grown: the level kept, drawn from the new poses; the old copy let go with its poses alone on it (its own to free), the kit's model kept.
    expect(levelDrawn(kit, kind!, mesh)).toBe(far);
    expect((mesh.geometry.getAttribute('instancePoseA') as InterleavedBufferAttribute).data).not.toBe(poses);
    expect(left.drawn).toBe(2);
    expect(far.geometry.getAttribute('position').array.length).toBeGreaterThan(0);
    expect(batch.trianglesOf(keyB)).toBe(drawnOf(batch, filingB));
    expect(batch.trianglesOf(keyA)).toBe(drawnOf(batch, filingA));
    batch.dispose();
    for (const cell of both.values()) cell.dispose();
  });

  it('lets every copy go on dispose, the kit\'s models kept', () => {
    const { batch, cells } = batchOf([keyA]);
    const meshes = meshesOf(batch);
    look(batch, m(3000));
    // The far copies, kept aside once the eye is back near.
    const aside = new Map([...meshes].map(([kind, mesh]) => [kind, mesh.geometry]));
    look(batch, m(300));
    const left: { kind: PartKind; attributes: number; drawn: boolean }[] = [];
    const watch = (kind: PartKind, g: BufferGeometry, drawn: boolean): void => {
      g.addEventListener('dispose', () => { left.push({ kind, attributes: Object.keys(g.attributes).length + (g.index ? 1 : 0), drawn }); });
    };
    for (const [kind, mesh] of meshes) {
      watch(kind, mesh.geometry, true);
      if (aside.get(kind) !== mesh.geometry) watch(kind, aside.get(kind)!, false);
    }
    expect([...meshes].some(([kind, mesh]) => aside.get(kind) !== mesh.geometry)).toBe(true);
    batch.dispose();
    // Every copy let go once: the one drawn with the batch's poses alone on it, its to free (`letGoPosed`, the kit's model taken off); those
    // kept aside bare (they share the poses).
    expect(left.filter((l) => l.drawn).length).toBe(meshes.size);
    expect(left.filter((l) => !l.drawn).length).toBe([...meshes].filter(([kind, mesh]) => aside.get(kind) !== mesh.geometry).length);
    for (const l of left) expect(l.attributes, l.kind).toBe(l.drawn ? 2 : 0);
    for (const kind of measuredKinds) for (const level of kit.screen[kind].levels) expect(level.geometry.getAttribute('position').array.length).toBeGreaterThan(0);
    for (const cell of cells.values()) cell.dispose();
  });

  it('has the layer choose its levels again when the batch draws a kind at another level', () => {
    const layer = readFileSync('src/render/buildings/layer.ts', 'utf8');
    // The batch tells the view's budget (`lodChanged`): its cells' triangles are read again (`chosenTriangles`).
    expect(layer).toMatch(/new FarPartBatch\(kit, lodChanged\)/);
  });
});
