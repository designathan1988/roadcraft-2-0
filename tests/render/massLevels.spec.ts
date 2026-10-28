import { refOf } from '@world/buildings/recordTable';
import { describe, expect, it } from 'vitest';
import { Frustum, Plane, Vector3, type Mesh, type Object3D } from 'three';

import { type CellMass, cellMass } from '@render/buildings/cellArrays';
import type { CellEnv, CellPool } from '@render/buildings/cellPool';
import { type CellEntry, type CellJob, type CellResult, type JobKind, runCellJob } from '@render/buildings/cellWork';
import { createBuildingKit } from '@render/buildings/kit';
import { createMassCells } from '@render/buildings/massCells';
import type { PackedEntries } from '@render/buildings/chunk';
import { MassLevels } from '@render/buildings/massLevels';
import { baseOf, levelCells, plateOf, tileOf } from '@render/buildings/levelKeys';
import { type BaseMass, joinBase } from '@render/buildings/massBase';
import { CELL_DETAIL, PLATE_DETAIL, TILE_DETAIL, massFloor } from '@render/buildings/massing';
import { massShells } from '@render/buildings/buildingMesh';
import { emitProgram } from '@render/buildings/buildingMesh';
import { massCorners, massesOf } from './support/masses';
import { drawsSignature } from '@render/buildings/signature';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { CELL } from '@world/cells';

/** THE BUILDINGS' TILES (L2) AND PLATES (L3, drawn by their base, `massBase.ts`): chosen by their error on the screen, in place of their cells, asked again only where a cell changed */
const flat = (): number => 0;

function building(index: number, x: number, y: number): Building {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x, y, rotation: 0 } as Building;
}

/** The masses of a few buildings in a cell, with the error a level says it left out. */
function masses(x: number, y: number, error = 0): CellMass {
  const chunks = [0, 1, 2].map((i) => massesOf(building(i, x + i * m(40), y + m(20)), flat)!);
  return { ...cellMass(chunks)!, error };
}

/** A plate's level as it comes: its square's base (`massBase.ts`), the masses of `cells` (each as `masses` lays a cell) with the error it left out. */
function plateBase(error: number, cells: readonly string[] = ['0,0']): BaseMass {
  return joinBase(cells.map((cell) => {
    const [i, j] = cell.split(',').map(Number) as [number, number];
    return { cell, mass: masses(i * CELL + m(10), j * CELL + m(10), error) };
  }), levelCells(baseOf(0, 0)))!;
}

const meshNamed = (root: Object3D, name: string): Mesh[] => {
  const out: Mesh[] = [];
  root.traverse((o) => { if (o.name === name && (o as Mesh).isMesh) out.push(o as Mesh); });
  return out;
};

describe('a tile or a plate (its base) drawn in place of its cells', () => {
  it('lets nothing go for a coarser choice a frame tried and did not keep: the masses neither leave the scene nor are asked again (the still view, `__stillLog`)', () => {
    const kit = createBuildingKit();
    const released: string[] = [];
    const far = createMassCells(kit, CELL, (key) => released.push(key));
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    far.planLevel(tileOf(0, 0));
    const choose = (orthoPx: number): void => far.choose(m(128), m(128), m(500), 1000, orthoPx, false);
    choose(2);
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    far.landBase(baseOf(0, 0), plateBase(m(10), ['0,0', '1,0']));
    choose(2);
    far.settle();
    const before = meshNamed(far.group, 'building-massing');
    expect(before).toHaveLength(2);
    let removed = 0;
    far.group.addEventListener('childremoved', () => { removed++; });
    // The frame's error scales tried: a coarse one (the tile, then the plate whole), and the one kept, close.
    for (let frame = 0; frame < 10; frame++) {
      choose(0.3);
      choose(0.1);
      choose(2);
      far.settle();
    }
    expect(removed).toBe(0);
    expect(released).toEqual([]);
    expect(meshNamed(far.group, 'building-massing')).toEqual(before);
    expect(meshNamed(far.group, 'building-massing-tile')).toHaveLength(1);
    // Kept coarse at the frame's end: let go then.
    choose(0.3);
    far.settle();
    expect(released.sort()).toEqual(['0,0', '1,0']);
    far.dispose();
  });

  it('is chosen by what it leaves out on the screen, hides its cells, and gives way to them near', () => {
    const kit = createBuildingKit();
    const released: string[] = [];
    const far = createMassCells(kit, CELL, (key) => released.push(key));
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    far.planLevel(tileOf(0, 0));
    // A frame's choice, and its end (`settle`): what it left unexposed or unwanted let go.
    const look = (orthoPx: number, near: boolean | ReadonlySet<string> = false): void => { far.choose(m(128), m(128), m(500), 1000, orthoPx, near); far.settle(); };
    // Close first: the plate refined, so its tile is wanted and its masses taken.
    look(2);
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    far.landBase(baseOf(0, 0), plateBase(m(10), ['0,0', '1,0']));
    // A cell's mesh by where it stands.
    const cellMesh = (key: string): Mesh | undefined => meshNamed(far.group, 'building-massing').find((mesh) => (mesh.geometry.boundingBox!.min.x < CELL) === (key === '0,0'));
    const tile = meshNamed(far.group, 'building-massing-tile')[0]!;
    // The plate drawn: its base drawing its cells (`syncBases`).
    const byPlate = (key: string): boolean => { far.syncBases(); return far.census().get(key) === 'base'; };

    // Close: the cells, near; no level drawn.
    look(2);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.near('0,0')).toBe(true);
    expect(tile.visible).toBe(false);
    expect(byPlate('0,0')).toBe(false);
    // A tile's 4 m under 2 px (0.3 px a metre): the tile, its cells far and their masses let go (neither drawn nor wanted).
    look(0.3);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(tile.visible).toBe(true);
    expect(byPlate('0,0')).toBe(false);
    for (const key of ['0,0', '1,0']) {
      expect(far.near(key)).toBe(false);
      expect(cellMesh(key)).toBeUndefined();
    }
    expect(released.sort()).toEqual(['0,0', '1,0']);
    expect([...far.nearKeys()]).toEqual([]);
    // Hysteresis: a tile drawn stays drawn up to its 2 px (4 m at 0.45 px is 1.8 px).
    look(0.45);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    // The plate's 10 m under 2 px: the plate alone, the tile under it let go.
    released.length = 0;
    look(0.1);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(byPlate('0,0') && byPlate('1,0')).toBe(true);
    expect(meshNamed(far.group, 'building-massing-tile')).toEqual([]);
    expect(released).toEqual([tileOf(0, 0)]);
    expect(far.wanted(tileOf(0, 0))).toBe(false);
    // A tile coming while its plate stands for it: never uploaded.
    released.length = 0;
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    expect(meshNamed(far.group, 'building-massing-tile')).toEqual([]);
    expect(released).toEqual([tileOf(0, 0)]);
    // A cell held near (cut open, edited): neither its tile nor its plate stands in for it.
    look(0.1, new Set(['0,0']));
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(far.near('0,0')).toBe(true);
    // Back close: the cells again, their masses asked again and shown (no detail landed for them; the base under them meanwhile).
    look(2);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.near('1,0')).toBe(true);
    expect([...far.exposedCells()].sort()).toEqual(['0,0', '1,0']);
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    look(2);
    expect(cellMesh('1,0')!.visible).toBe(true);
    // Refined from a tile not drawn: hysteresis the other way (4 m at 0.45 px is 1.8 px, over 0.85 of 2).
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    look(0.45);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    // A level with no mass never stands in for its cells.
    far.landLevel(tileOf(0, 0), null);
    look(0.3);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(cellMesh('1,0')!.visible).toBe(true);
    far.dispose();
    kit.dispose();
  });

  it('refining, the plate drawn stands until its tile has come, and the tile until its cells have (no hole)', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL);
    far.planLevel(tileOf(0, 0));
    far.plan('0,0', 0, m(30));
    const look = (orthoPx: number): void => far.choose(m(128), m(128), m(500), 1000, orthoPx, false);
    far.landBase(baseOf(0, 0), plateBase(m(10)));
    look(0.1);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    // Nearer: the tile is wanted and has not come; the plate stays drawn meanwhile.
    look(0.3);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    expect(far.waiting).toBeGreaterThan(0);
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    look(0.3);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    // Close: the cell's masses not come, the tile stands; once come, the cell.
    look(2);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    expect([...far.exposedCells()]).toEqual(['0,0']);
    far.land('0,0', masses(m(10), m(10)));
    look(2);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    expect(far.near('0,0')).toBe(true);
    far.dispose();
    kit.dispose();
  });

  it('refining, the plate drawn over the view gives way once the tiles the view meets have come: one out of it never holds it (the opening on low)', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL);
    // Plate p:0,0 holds the tiles t:0,0 (cells 0..3) and t:-1,0 (cells -4..-1).
    for (const [i, key] of [[0, '0,0'], [-4, '-4,0']] as const) { far.planLevel(tileOf(i, 0)); far.plan(key, 0, m(30)); }
    far.landBase(baseOf(0, 0), plateBase(m(10)));
    far.choose(m(128), m(128), m(500), 1000, 0.1, false);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    // The view over x and y 300-1000 m: tile t:0,0 in it, t:-1,0 (x under 0) out of it - not asked while the curtain is up (`layer.ts` deferred).
    const view = new Frustum(
      new Plane(new Vector3(1, 0, 0), -m(300)), new Plane(new Vector3(-1, 0, 0), m(1000)),
      new Plane(new Vector3(0, 0, 1), m(1000)), new Plane(new Vector3(0, 0, -1), -m(300)),
      new Plane(new Vector3(0, 1, 0), m(1000)), new Plane(new Vector3(0, -1, 0), m(10_000)));
    const look = (): void => far.choose(m(650), m(650), m(500), 1000, 0.3, false, Infinity, view);
    look();
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    expect(far.waitingInView).toBeGreaterThan(0);
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    look();
    // The tile in the view drawn, the plate gone from it, nothing left for the view to wait for; the cells out of the view drawn by their base.
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(far.waitingInView).toBe(0);
    far.dispose();
    kit.dispose();
  });

  it('over the budget, never lets go a plate: it is its base, drawn under its tiles and asked for good (`massBase.ts`)', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL);
    far.planLevel(tileOf(0, 0));
    far.plan('0,0', 0, m(30));
    far.landBase(baseOf(0, 0), plateBase(m(10)));
    const view = new Frustum(
      new Plane(new Vector3(1, 0, 0), m(2000)), new Plane(new Vector3(-1, 0, 0), m(2000)),
      new Plane(new Vector3(0, 0, 1), m(2000)), new Plane(new Vector3(0, 0, -1), m(2000)),
      new Plane(new Vector3(0, 1, 0), m(1000)), new Plane(new Vector3(0, -1, 0), m(10_000)));
    const look = (orthoPx: number): void => far.choose(m(128), m(128), m(500), 1000, orthoPx, false, Infinity, view);
    look(0.1);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    expect(far.evictLevels(0)).toBe(0);
    // Nearer: its tile drawn in its place, the plate idle in the view - still there, nothing of it let go.
    look(0.3);
    far.landLevel(tileOf(0, 0), masses(m(10), m(10), m(4)));
    look(0.3);
    expect(far.coarse(tileOf(0, 0))).toBe(true);
    expect(far.evictLevels(0)).toBe(0);
    expect(far.levelDrawn(plateOf(0, 0))).toBe(true);
    expect(far.askable(plateOf(0, 0))).toBe(true);
    // Back out: drawn whole at once, nothing waited for.
    look(0.1);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    expect(far.coarse(tileOf(0, 0))).toBe(false);
    far.dispose();
    kit.dispose();
  });

  it('leaves out more the higher its level, and says how much', () => {
    let cell = 0, tile = 0, plate = 0, tileError = 0, plateError = 0;
    for (let i = 0; i < BLUEPRINTS.length; i++) {
      const b = building(i, 0, 0);
      const c = massesOf(b, flat, undefined, flat, undefined, CELL_DETAIL);
      const t = massesOf(b, flat, undefined, flat, undefined, TILE_DETAIL);
      const p = massesOf(b, flat, undefined, flat, undefined, PLATE_DETAIL);
      if (!c) continue;
      expect(c.error).toBe(0);
      expect(t!.error).toBeLessThanOrEqual(TILE_DETAIL.drop);
      expect(p!.error).toBeLessThanOrEqual(PLATE_DETAIL.drop);
      expect(massCorners(t!)).toBeLessThanOrEqual(massCorners(c));
      expect(massCorners(p!)).toBeLessThanOrEqual(massCorners(t!));
      cell += massCorners(c); tile += massCorners(t!); plate += massCorners(p!);
      tileError = Math.max(tileError, t!.error); plateError = Math.max(plateError, p!.error);
    }
    expect(tile).toBeLessThan(cell);
    expect(plate).toBeLessThan(tile);
    expect(tileError).toBeGreaterThan(0);
    expect(plateError).toBeGreaterThanOrEqual(tileError);
  });

  it("draws every level of the masses from one program, the same as a program of a copy of the record", () => {
    for (let i = 0; i < BLUEPRINTS.length; i++) {
      for (const turn of [0, 0.7]) {
        const b = { ...building(i, 0, 0), rotation: turn };
        const floor = massFloor(b, flat) ?? null;
        // One program (`emitProgram`), its every level a filter (`massShells`): nothing of it read from the record object or its memos again.
        const program = emitProgram(b, flat, undefined, flat, { near: false, far: false }, { floor });
        const copy = emitProgram(structuredClone(b), flat, undefined, flat, { near: false, far: false }, { floor });
        for (const detail of [CELL_DETAIL, TILE_DETAIL, PLATE_DETAIL]) expect(massShells(program, detail)).toEqual(massShells(copy, detail));
        // The coarser the level, never more triangles.
        const [c, t, p] = [CELL_DETAIL, TILE_DETAIL, PLATE_DETAIL].map((d) => { const s = massShells(program, d); return s ? massCorners(s) : 0; });
        expect(t).toBeLessThanOrEqual(c!);
        expect(p).toBeLessThanOrEqual(t!);
      }
    }
  });

  it("is made by the cells' job for its kind, merged, with its error", () => {
    // A building drawn by its masses (a signature one is drawn by its own body, `signature.ts`).
    const plain = BLUEPRINTS.findIndex((_, i) => !drawsSignature(building(i, 0, 0)));
    const b = building(plain, m(10), m(10));
    const job = (kind: JobKind): CellJob => ({
      id: 1, kind, cell: kind === 'massBase' ? baseOf(0, 0) : 'x', paved: false, boxes: { parts: {}, furniture: {} } as unknown as CellJob['boxes'],
      entries: [{ key: '1', sig: 1, digest: 1, record: refOf(b) }, { key: '2', sig: 2, digest: 1, record: refOf({ ...b, id: 2 as Building['id'], x: m(80) }) }],
    });
    const mass = (kind: JobKind): CellMass => {
      const reply = runCellJob(job(kind), { groundAt: flat, naturalAt: flat });
      if (reply.kind !== 'done') throw new Error(reply.kind);
      return kind === 'massBase' ? reply.result.base!.mass! : reply.result.mass!;
    };
    // The plate's level made by its base's job (`massBase.ts`).
    const cell = mass('mass'), tile = mass('massTile'), plate = mass('massBase');
    expect(cell.error).toBe(0);
    expect(tile.index.length).toBeLessThanOrEqual(cell.index.length);
    expect(plate.index.length).toBeLessThanOrEqual(tile.index.length);
    expect(plate.error).toBeGreaterThanOrEqual(tile.error);
  });
});

describe('the tiles and bases (the plates\' level) asked of the workers', () => {
  /** A pool that keeps what it is asked and answers when told. */
  function fakePool(): { pool: CellPool; asked: { kind: JobKind; key: string; entries: readonly CellEntry[] }[]; answer: () => void } {
    const asked: { kind: JobKind; key: string; entries: readonly CellEntry[]; done: (r: CellResult) => void; id: number }[] = [];
    const running = new Set<number>();
    let next = 1;
    const pool = {
      run(kind: JobKind, cell: string, entries: readonly CellEntry[], _env: CellEnv, done: (r: CellResult) => void) {
        const id = next++;
        asked.push({ kind, key: cell, entries, done, id });
        running.add(id);
        return id;
      },
      cancel(id: number) { running.delete(id); },
      isRunning(id: number) { return running.has(id); },
    } as unknown as CellPool;
    const answer = (): void => {
      for (const a of asked) if (running.delete(a.id)) a.done({ batch: null, parts: null, summaries: [], mass: null });
    };
    return { pool, asked, answer };
  }
  const env = { groundAt: flat, naturalAt: flat } as CellEnv;
  /** A cell's buildings packed (`PackedEntries`), each named by a letter: its id the letter's code. */
  const entries = (...keys: string[]): PackedEntries => ({ ids: Float64Array.from(keys, (key) => key.charCodeAt(0)), sigs: Float64Array.from(keys, (_key, i) => i + 1), digest: 7 });
  const named = (list: readonly CellEntry[]): string[] => list.map((e) => String.fromCharCode(Number(e.key))).sort();

  it('a change in one cell asks again its tile and its base only, once for every cell touched', () => {
    const { pool, asked, answer } = fakePool();
    const landed: string[] = [], removed: string[] = [];
    const levels = new MassLevels(pool, (key) => landed.push(key), (key) => removed.push(key), () => {}, () => true);
    levels.touch('0,0', entries('a', 'b'));
    levels.touch('1,1', entries('c'));
    // The plates from the cells' origin, eight cells a side (`levelKeys.ts`): cell 9 in tile 2 of plate 1, cell 4 in tile 1 of plate 0.
    levels.touch('9,0', entries('d'));
    levels.touch('4,0', entries('e'));
    levels.flush(env);
    const keys = asked.map((a) => `${a.kind} ${a.key}`).sort();
    // And the base over each plate's square, asked at once (`massBase.ts`): the plate's level, no job of the plate's.
    expect(keys).toEqual(['massBase b:0,0', 'massBase b:1,0', 'massTile t:0,0', 'massTile t:1,0', 'massTile t:2,0'].sort());
    // A tile is made of its cells' buildings; a base of its plate's.
    expect(named(asked.find((a) => a.key === 't:0,0')!.entries)).toEqual(['a', 'b', 'c']);
    expect(named(asked.find((a) => a.key === 'b:0,0')!.entries)).toEqual(['a', 'b', 'c', 'e']);
    expect(levels.asking).toBe(5);
    answer();
    expect(levels.asking).toBe(0);
    // The bases land by their own way (`landBase`).
    expect(landed.length).toBe(3);

    asked.length = 0;
    // One cell changed: its tile and base alone.
    levels.touch('9,0', entries('d', 'f'));
    // The same buildings on the same ground (the town filed again): nothing.
    levels.touch('0,0', entries('a', 'b'));
    levels.flush(env);
    expect(asked.map((a) => a.key).sort()).toEqual(['b:1,0', 't:2,0']);
    // Changed again before it came: the older job cancelled, the newer one asked.
    levels.touch('9,0', entries('d'));
    levels.flush(env);
    expect(levels.asking).toBe(2);

    // Its last building gone: the tile, the plate and the base are removed, not asked.
    asked.length = 0;
    levels.touch('9,0', null);
    levels.flush(env);
    expect(asked).toEqual([]);
    expect(removed.sort()).toEqual(['b:1,0', 'p:1,0', 't:2,0']);
    expect(levels.asking).toBe(0);
  });

  it('asks a tile only once the view wants it (its plate refined), and a base only once its plate is within a plate of the view (MISSION.md item 5)', () => {
    const { pool, asked, answer } = fakePool();
    const planned: string[] = [];
    const wanted = new Set<string>(['b:0,0']);
    const levels = new MassLevels(pool, () => {}, () => {}, (key) => planned.push(key), (key) => wanted.has(key));
    levels.touch('0,0', entries('a'));
    // Cell 9: tile 2, plate 1 (the plates from the cells' origin, `levelKeys.ts`).
    levels.touch('9,0', entries('b'));
    levels.flush(env);
    // The base the view wants asked at once; the other base, the plates and the tiles only planned. DO NOT ask every base of the map.
    expect(asked.map((a) => a.key)).toEqual(['b:0,0']);
    expect(planned.sort()).toEqual(['b:0,0', 'b:1,0', 'p:0,0', 'p:1,0', 't:0,0', 't:2,0']);
    answer();
    asked.length = 0;
    levels.pump(env);
    expect(asked).toEqual([]);
    // The view comes within a plate of the other plate: its base asked.
    wanted.add('b:1,0');
    levels.pump(env);
    expect(asked.map((a) => a.key)).toEqual(['b:1,0']);
    answer();
    asked.length = 0;
    // Let go past the ring for the budget (`massCells.ts` evictLevels): asked again only once the view wants it again.
    wanted.delete('b:1,0');
    levels.release('b:1,0');
    levels.pump(env);
    expect(asked).toEqual([]);
    wanted.add('b:1,0');
    levels.pump(env);
    expect(asked.map((a) => a.key)).toEqual(['b:1,0']);
    answer();
    asked.length = 0;
    // The eye comes near one plate: its tile asked, the other still not.
    wanted.add('t:0,0');
    levels.pump(env);
    expect(asked.map((a) => a.key)).toEqual(['t:0,0']);
    levels.pump(env);
    expect(asked.length).toBe(1);
    // Its masses let go (its plate drawn whole again, `massCells.ts`): asked again only once wanted again.
    answer();
    asked.length = 0;
    wanted.delete('t:0,0');
    levels.release('t:0,0');
    levels.pump(env);
    expect(asked).toEqual([]);
    wanted.add('t:0,0');
    levels.pump(env);
    expect(asked.map((a) => a.key)).toEqual(['t:0,0']);
  });
});

describe('a tile or a plate drawn before some of its buildings came in', () => {
  it('stands for none of them: its cells are not drawn by it until it is made again with them', () => {
    const kit = createBuildingKit();
    const far = createMassCells(kit, CELL, () => {});
    far.land('0,0', masses(m(10), m(10)));
    far.planLevel(plateOf(0, 0));
    far.landBase(baseOf(0, 0), plateBase(m(10)));
    // From afar: the plate drawn in place of its cells.
    far.choose(m(128), m(128), m(500), 1000, 0.1, false);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    // A cell come in under it (a tile loaded): no mesh of its own, the plate standing in its place.
    far.plan('1,1');
    expect(far.drawn('1,1')).toBe(true);
    // The plate's base of older buildings (`MassLevels.outdated`): drawing nothing of the cell.
    expect(far.drawn('1,1', (level) => level !== plateOf(0, 0))).toBe(false);
    far.dispose();
    kit.dispose();
  });

  it('is never coarsened into while outdated: the cells keep their masses until it is made again', () => {
    const kit = createBuildingKit();
    let stale = true;
    const far = createMassCells(kit, CELL, () => {}, (level) => !(stale && level === plateOf(0, 0)));
    far.planLevel(tileOf(0, 0));
    // Close first: the cells asked and drawn with their masses.
    far.choose(m(128), m(128), m(500), 1000, 2, false);
    far.land('0,0', masses(m(10), m(10)));
    far.land('1,0', masses(CELL + m(10), m(10)));
    far.landBase(baseOf(0, 0), plateBase(m(10), ['0,0', '1,0']));
    far.choose(m(128), m(128), m(500), 1000, 2, false);
    // From afar, the plate made before its cells' buildings changed: not drawn in their place, their masses kept and drawn.
    far.choose(m(128), m(128), m(500), 1000, 0.1, false);
    expect(far.coarse(plateOf(0, 0))).toBe(false);
    expect(meshNamed(far.group, 'building-massing').length).toBe(2);
    expect(far.drawn('0,0', (level) => !(stale && level === plateOf(0, 0)))).toBe(true);
    expect(far.waiting).toBeGreaterThan(0);
    // Made again: the plate stands for them.
    stale = false;
    far.choose(m(128), m(128), m(500), 1000, 0.1, false);
    expect(far.coarse(plateOf(0, 0))).toBe(true);
    // A cell's masses hidden under it draw nothing: drawn by the plate only while it is current.
    expect(far.drawn('0,0', (level) => level !== plateOf(0, 0))).toBe(false);
    far.dispose();
    kit.dispose();
  });

  it('is outdated from the change of a cell under it until its masses are made again', () => {
    const answers: ((result: CellResult) => void)[] = [];
    // A pool whose jobs wait for the test.
    const pool = {
      run: (_kind: JobKind, _key: string, _list: readonly CellEntry[], _env: CellEnv, done: (result: CellResult) => void) => answers.push(done),
      isRunning: () => true,
      cancel: () => {},
    } as unknown as CellPool;
    // The view wants its base (its plate within a plate of the view), not its tiles.
    const levels = new MassLevels(pool, () => {}, () => {}, () => {}, (key) => key[0] === 'b');
    expect(levels.outdated(plateOf(0, 0))).toBe(false);
    levels.touch('0,0', { ids: Float64Array.of(1), sigs: Float64Array.of(1), digest: 0 });
    expect(levels.outdated(plateOf(0, 0))).toBe(true);
    levels.flush({ groundAt: flat, naturalAt: flat });
    expect(levels.outdated(plateOf(0, 0))).toBe(true);
    // Its base answered (the plate's level, `massBase.ts`).
    for (const done of answers.splice(0)) done({ mass: null } as CellResult);
    expect(levels.outdated(plateOf(0, 0))).toBe(false);
  });
});

