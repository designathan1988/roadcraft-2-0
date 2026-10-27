import { FINISHES, type Finish } from '@world/buildings/materials';
import type { BuildingChunk, LotGround } from './chunk';
import type { FlagInstance } from './flagLayer';

/**
 * THE BUILDING'S PROGRAM: what ONE walk over a building makes of it (`buildingMesh.ts` emitProgram), kept by the building's record, and
 * every level of it drawn from that alone: the detail (`near`), the facade level (`far`), the masses at the cell's, the tile's and the
 * plate's detail (`massing.ts` massOf) and the base (`massBase.ts` writeBase) are filters over it, never a walk of their own.
 * Staged as a shape grammar derives a building (Müller et al. 2006, the mass model before the facades, https://history.siggraph.org/?p=113547)
 * and lazily, the view asking for the stages it draws (Steinberger et al. 2014, https://hgpu.org/?p=11204): the mass stage alone for the
 * levels drawn from afar (the whole map's plates and bases at the opening), the facades only where a cell is drawn in detail or at its facade level.
 * ONE PROGRAM A BUILDING, WHATEVER FLOOR IT IS STOOD ON: its body is kept over its floor (each height from it), the floor added by the level's
 * filter; only its paved lots stand on a floor (`LotsProgram`: their surfaces fall from the level they meet to the street), made again alone
 * when a building's floor is measured anew.
 */

/** A thing the masses leave out at a level (`MassDetail.drop`), asked once a level (`buildingMesh.ts` massShells): a parapet, a box on the roof, a
 *  machine room, a pitched roof's rise. Held two numbers a group (`MassProgram.groups`): its height or depth, and 1 where only a level of
 *  boxes asks it (`MassDetail.boxes`: a pitched roof, laid flat at its eaves there). */
export const GROUP_FLOATS = 2;

/** How a face of the masses depends on its group: kept unless the level leaves the group out; the pitched roof's own faces (kept unless laid flat); its flat slab (only where laid flat). */
export const MASS_KEEP = 0;
export const MASS_PITCHED = 1;
export const MASS_FLATTENED = 2;

/** A face of the masses, `FACE_FLOATS` numbers (`MassProgram.faces`): its group (-1: none, always drawn) and mode, its normal (three's axes),
 *  its first point and points (`MassProgram.points`, three doubles each), its first triangle corner and corners (`MassProgram.tris`; none: a
 *  convex fan), and its paint (`MassLook`: linear rgb, the finish's index in `FINISHES`). In the arrays the program already holds: DO NOT give a
 *  program a palette of its own, a tile's job held four hundred programs' few objects more each (`cellJobMemory.spec.ts`). */
export const FACE_FLOATS = 13;

/** A face's paint as the detail and the facade level lay it (`buildingMesh.ts` Paint): its linear colour and its finish, the finishes' maps
 *  the shells draw it with (`finishes.ts`). Every level drawn from afar lays it so (`buildingMesh.ts` massShells): the building's own look. */
export interface MassLook {
  readonly rgb: readonly [number, number, number];
  readonly finish: Finish;
}
/** One bay of a block's wall as the masses read it (`bayLayout`), as the walk records it: its side, its span along it, its storey (from its
 *  floor), its outward offset (a relief's push, an arcade's set-back); a storey on the ground runs down past the lowest ground under it
 *  (`BURY`). Held `BAY_FLOATS` numbers a bay (`MassProgram.bays`): the fields here in their order, its look as four (rgb, finish), then its
 *  block's volume id and grime foot (`MassRecorder.block`). */
export interface MassBay {
  readonly side: number;
  readonly start: number;
  readonly width: number;
  readonly z0: number;
  readonly height: number;
  readonly d: number;
  readonly ground: boolean;
  /** Its opening's sill and head, shares of the storey's height from its floor (`buildingMesh.ts` openingOf, the detail's and the facade level's own). */
  readonly sill: number;
  readonly head: number;
  /** What the facade level draws in it (`buildingMesh.ts` facadeKind with its streak, `FACADE_STREAK`; `FACADE_KIND.none` a plain wall), and its
   *  opening's two edges across, shares of its width (`openingOf`): the facade level's own run of bays (`emitFacadeRuns`). */
  readonly kind: number;
  readonly a0: number;
  readonly a1: number;
  /** Its wall's paint (`MassLook`), its bay's index along its side and its storey's level (the facade level's u and v: the shader picks each
   *  bay's pane by them, as `emitBay` does). */
  readonly look: MassLook;
  readonly index: number;
  readonly level: number;
  /** How many of the facade level's bays it holds side by side (the bays alike joined, `recordBlock`): its run's u from `index` to `index + bays`. */
  readonly bays: number;
  /** What stands out of its wall in the detail (balconies, slabs, fins, rails, bands, awnings: `buildingMesh.ts` CoverShell over its own
   *  `emitBay`), as a level from afar draws it once it is under the pixels: the share of the bay it covers seen from the front, its colour (linear). */
  readonly cover: number;
  readonly coverRgb: readonly [number, number, number];
}
export const BAY_FLOATS = 25;

/** A side of a block on the plan, local: its start, its direction along it, its outward normal; its bay's width (the facade's grid). Held `SIDE_FLOATS` numbers, its side first (`MassProgram.sides`). */
export interface MassSide {
  readonly x: number;
  readonly y: number;
  readonly tx: number;
  readonly ty: number;
  readonly nx: number;
  readonly ny: number;
  readonly bay: number;
}
export const SIDE_FLOATS = 8;

/** The mass stage of a program: what every level drawn from afar is drawn from, in a few flat arrays (a few KB a building: the programs
 *  kept by a worker are a plate's thousands, `cellJobMemory.spec.ts`); every height over the building's floor (its bays' feet, its faces'
 *  points), the floor added where a level is drawn (`buildingMesh.ts` massShells: the cells', the tiles', the plates' and the base's). */
export interface MassProgram {
  /** The building's frame on the plan (its walls laid from their local sides). */
  readonly frame: { readonly x: number; readonly y: number; readonly c: number; readonly s: number };
  /** The shader's seed for its windows (and its use: + 2 for offices and works). */
  readonly seed: number;
  /** How run-down the building is (`Building.decay`): its shells' weathering, as the detail's (`buildingMesh.ts` Shell.decay). */
  readonly decay: number;
  /** Its window frames' colour (the trim, linear), as the facade level's runs draw them. */
  readonly trim: readonly [number, number, number];
  /** Every block's bays (`BAY_FLOATS` each), storey row by row; each row's first bay and one past the last (`rows`); each block's first row and one past the last (`blockRows`). */
  readonly bays: Float64Array;
  readonly rows: Uint32Array;
  readonly blockRows: Uint32Array;
  /** Every block's sides (`SIDE_FLOATS` each), each block's first side and one past the last (`blockSides`). */
  readonly sides: Float64Array;
  readonly blockSides: Uint32Array;
  readonly groups: Float64Array;
  readonly faces: Float64Array;
  readonly points: Float64Array;
  readonly tris: Uint32Array;
}

/** The part of a program that stands on a floor: its paved lots as every level from afar lays them (faces, absolute), and its lots' ground
 *  as the page keeps it; `floor`: the floor they stand on (null: no closed block, the lots on the highest ground). */
export interface LotsProgram {
  readonly floor: number | null;
  readonly faces: Float64Array;
  readonly points: Float64Array;
  readonly tris: Uint32Array;
  readonly lotGround?: LotGround;
  readonly signatureFloor?: number;
}

/** What a level drawn from afar is drawn from (`buildingMesh.ts` massShells, `massBase.ts` writeBase): a building's body, and its lots on the
 *  floor the level stands it on (the body put on the lots' floor). */
export interface ProgramStage {
  readonly mass: MassProgram;
  readonly lots: LotsProgram;
}

/** What the page keeps of a building (`cellWork.ts` ChunkSummary): its flags, its lots' ground, a signature building's floor. */
export interface ProgramSummary {
  readonly flags?: readonly FlagInstance[];
  readonly lotGround?: LotGround;
  readonly signatureFloor?: number;
}

/** A building's program: its body's mass stage always, its flags over its floor, its lots on the floor it was walked on, the detail and the
 *  facade level (absolute: drawn on the building's measured floor) where a walk was asked for them. */
export interface BuildingProgram extends ProgramStage {
  /** Its flags, each one's height over the floor (three's y). */
  readonly flags: readonly FlagInstance[];
  readonly near?: BuildingChunk;
  readonly far?: BuildingChunk;
}

/** What the page keeps of a building on the floor its lots stand on (`lots`): its flags put on that floor, its lots' ground, a signature building's floor. */
export function summaryOf(p: BuildingProgram, lots: LotsProgram = p.lots): ProgramSummary {
  const floor = lots.floor ?? 0;
  return {
    ...(lots.lotGround ? { lotGround: lots.lotGround } : {}),
    ...(lots.signatureFloor !== undefined ? { signatureFloor: lots.signatureFloor } : {}),
    ...(p.flags.length ? { flags: p.flags.map((f) => ({ ...f, y: f.y + floor })) } : {}),
  };
}

/** Three plan numbers (x, y north, z up). */
type V3 = readonly [number, number, number];

/** THE MASS STAGE AS THE WALK WRITES IT (`buildingMesh.ts`): faces in three's axes from plan points, groups, blocks' bays, the base's shapes; packed flat once the walk is done (`done`). */
export class MassRecorder {
  private readonly bays: number[] = [];
  private readonly rows: number[] = [];
  private readonly blockRows: number[] = [];
  private readonly sides: number[] = [];
  private readonly blockSides: number[] = [];
  private readonly groupList: number[] = [];
  private readonly faceList: number[] = [];
  private readonly points: number[] = [];
  private readonly tris: number[] = [];
  /** The bays' covers kept for the worker's buildings (`ProgramCache.covers`), set by `emitProgram`; none, measured once a building. */
  covers: BayCovers | null = null;
  /** Its window frames' colour (`MassProgram.trim`), set by the walk. */
  trim: readonly [number, number, number] = [1, 1, 1];

  /** Every height written absolute, as the walk lays the building on its floor; taken over the floor when packed (`done`). */
  constructor(readonly frame: MassProgram['frame'], readonly seed: number, readonly decay = 0) {}

  /** A thing left out under `size` at a level; `boxesOnly`: a pitched roof, asked only by a level of boxes. */
  group(size: number, boxesOnly = false): number {
    this.groupList.push(size, boxesOnly ? 1 : 0);
    return this.groupList.length / GROUP_FLOATS - 1;
  }

  /** A closed block's sides and its bays, storey row by storey row; its volume's id and the foot its grime is measured from. */
  block(sides: ReadonlyMap<number, MassSide>, rows: readonly (readonly MassBay[])[], volume: number, foot: number): void {
    this.blockSides.push(this.sides.length / SIDE_FLOATS);
    for (const [side, s] of sides) this.sides.push(side, s.x, s.y, s.tx, s.ty, s.nx, s.ny, s.bay);
    this.blockRows.push(this.rows.length);
    for (const row of rows) {
      this.rows.push(this.bays.length / BAY_FLOATS);
      for (const q of row) {
        this.bays.push(q.side, q.start, q.width, q.z0, q.height, q.d, q.ground ? 1 : 0, q.sill, q.head, q.kind, q.a0, q.a1,
          q.look.rgb[0], q.look.rgb[1], q.look.rgb[2], FINISHES.indexOf(q.look.finish), q.index, q.level, q.bays, volume, foot,
          q.cover, q.coverRgb[0], q.coverRgb[1], q.coverRgb[2]);
      }
    }
  }

  /** A convex polygon of plan points (world), its normal (world plan, any length), its paint (`MassLook`). */
  face(points: readonly V3[], n: V3, look: MassLook, group = -1, mode = MASS_KEEP): void {
    this.add(points, null, n, look, group, mode);
  }

  /** How many faces are recorded so far (`tintUp`'s range). */
  get faceCount(): number {
    return this.faceList.length / FACE_FLOATS;
  }

  /** The faces recorded from `from` to `to` that look up in the roof's paint mixed toward what stands on the roof in the detail (`buildingMesh.ts`
   *  CoverShell): its colour by its share of the roof, as a level from afar sees it. */
  tintUp(from: number, to: number, roof: MassLook, share: number, rgb: readonly [number, number, number]): void {
    const f = this.faceList, finish = FINISHES.indexOf(roof.finish), t = Math.min(1, share);
    for (let i = from; i < to; i++) {
      const o = i * FACE_FLOATS;
      if (f[o + 3]! < 0.5 || f[o + 12] !== finish || f[o + 9] !== roof.rgb[0] || f[o + 10] !== roof.rgb[1] || f[o + 11] !== roof.rgb[2]) continue;
      for (let k = 0; k < 3; k++) f[o + 9 + k] = f[o + 9 + k]! + (rgb[k]! - f[o + 9 + k]!) * t;
    }
  }

  /** A flat polygon of plan points (world) and its triangles over them (earcut's). */
  polygon(points: readonly V3[], tris: ArrayLike<number>, n: V3, look: MassLook, group = -1, mode = MASS_KEEP): void {
    this.add(points, tris, n, look, group, mode);
  }

  private add(points: readonly V3[], tris: ArrayLike<number> | null, n: V3, look: MassLook, group: number, mode: number): void {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    // Three's axes (x, up, -north), as the masses' vertices hold them.
    this.faceList.push(group, mode, n[0] / l, n[2] / l, -n[1] / l, this.points.length / 3, points.length, this.tris.length, tris ? tris.length : 0,
      look.rgb[0], look.rgb[1], look.rgb[2], FINISHES.indexOf(look.finish));
    for (const p of points) this.points.push(p[0], p[2], -p[1]);
    if (tris) for (let k = 0; k < tris.length; k++) this.tris.push(tris[k]!);
  }

  /** The mass stage packed, every height taken over `floor` (the floor the walk stood the building on). */
  done(floor = 0): MassProgram {
    const bays = Float64Array.from(this.bays);
    // Its foot and its grime's foot over the floor.
    for (let i = 0; i < bays.length; i += BAY_FLOATS) { bays[i + 3]! -= floor; bays[i + 20]! -= floor; }
    // DO NOT keep them in single floats: a point taken over its floor, rounded to a float and put back on its floor fell a float's step off the
    // same point of a wall beside it (a parapet's foot off the wall's head), the masses' faces no longer closed (the catalogue's solids, stage 1b).
    const points = new Float64Array(this.points.length);
    for (let i = 0; i < points.length; i += 3) { points[i] = this.points[i]!; points[i + 1] = this.points[i + 1]! - floor; points[i + 2] = this.points[i + 2]!; }
    return {
      frame: this.frame, seed: this.seed, decay: this.decay, trim: this.trim,
      bays, rows: Uint32Array.from([...this.rows, this.bays.length / BAY_FLOATS]),
      blockRows: Uint32Array.from([...this.blockRows, this.rows.length]),
      sides: Float64Array.from(this.sides), blockSides: Uint32Array.from([...this.blockSides, this.sides.length / SIDE_FLOATS]),
      groups: Float64Array.from(this.groupList), faces: Float64Array.from(this.faceList),
      points, tris: Uint32Array.from(this.tris),
    };
  }

  /** What it recorded as a lots part (`LotsProgram`): its faces as laid (absolute), on `floor`. */
  lots(floor: number | null, lotGround?: LotGround, signatureFloor?: number): LotsProgram {
    return {
      floor, faces: Float64Array.from(this.faceList), points: Float64Array.from(this.points), tris: Uint32Array.from(this.tris),
      ...(lotGround ? { lotGround } : {}), ...(signatureFloor !== undefined ? { signatureFloor } : {}),
    };
  }
}

/** The bytes a program holds, as near as its arrays tell: what the cache weighs it by. */
function programBytes(p: BuildingProgram): number {
  const q = p.mass;
  let bytes = 512 + q.bays.byteLength + q.rows.byteLength + q.blockRows.byteLength + q.sides.byteLength + q.blockSides.byteLength
    + q.groups.byteLength + q.faces.byteLength + q.points.byteLength + q.tris.byteLength;
  bytes += lotsBytes(p.lots) + p.flags.length * 96;
  for (const chunk of [p.near, p.far]) {
    if (!chunk) continue;
    for (const s of Object.values(chunk.shells)) if (s) bytes += s.position.byteLength + s.normal.byteLength + s.paint.byteLength + s.index.byteLength;
    for (const r of Object.values(chunk.runs ?? {})) {
      if (r) bytes += r.position.byteLength + r.normal.byteLength + r.paint.byteLength + r.index.byteLength + r.facade.byteLength + r.grid.byteLength + r.opening.byteLength;
    }
    for (const batch of Object.values(chunk.parts)) bytes += batch.poses.byteLength + (batch.colours?.byteLength ?? 0) + (batch.looks?.byteLength ?? 0) + (batch.slots?.byteLength ?? 0) + (batch.rooms?.byteLength ?? 0);
    for (const batch of Object.values(chunk.furniture ?? {})) if (batch) bytes += batch.poses.byteLength + (batch.colours?.byteLength ?? 0);
  }
  return bytes;
}

/** The bytes a lots part holds (its lots' ground's surfaces counted a few hundred bytes a lot). */
function lotsBytes(l: LotsProgram): number {
  const bytes = 256 + l.faces.byteLength + l.points.byteLength + l.tris.byteLength;
  return bytes + (l.lotGround ? 512 : 0);
}

/** THE PROGRAMS A WORKER KEEPS, by record: a building's program is made once and every job of it after that reads it (`cellWork.ts`);
 *  an edit changes the record's digest, so only the edited building is walked again, its neighbours' programs read as they were.
 *  Least recently used first out, within a budget of bytes: each worker is a heap in the page's V8 cage (`jobPool.ts`), so a few tens of MB. */
/** A bay's cover as a level from afar draws it (`MassBay.cover`), by what decides it (`buildingMesh.ts` recordBlock's key): its share and
 *  its rgb a byte each in one number, as the run's vertex carries them (`packCover`). DO NOT keep an object and an array a bay: a worker
 *  keeps tens of thousands (`cellJobMemory.spec.ts`). */
export type BayCovers = Map<number, number>;
const coverByte = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255);
/** A cover packed into one number (`BayCovers`). */
export const packCover = (cover: number, rgb: readonly [number, number, number]): number =>
  ((coverByte(cover) << 24) | (coverByte(rgb[0]) << 16) | (coverByte(rgb[1]) << 8) | coverByte(rgb[2])) >>> 0;
/** A cover unpacked (`packCover`). */
export const unpackCover = (n: number): { readonly cover: number; readonly coverRgb: readonly [number, number, number] } =>
  ({ cover: ((n >>> 24) & 255) / 255, coverRgb: [((n >>> 16) & 255) / 255, ((n >>> 8) & 255) / 255, (n & 255) / 255] });
/** The most bays' covers a worker keeps: past it they are all let go and measured again as they come (a few hundred bytes each). */
const COVERS_MOST = 50_000;

export class ProgramCache {
  private readonly kept = new Map<string, { program: BuildingProgram; bytes: number }>();
  /** Each kind of bay measured once for every building of the worker's jobs (`recordBlock`): DO NOT measure each building's bays again,
   *  a town's opening ran its every bay through `emitBay` once more for its masses. */
  private readonly coverMap: BayCovers = new Map();
  /** The bays' covers kept, let go whole once past `COVERS_MOST`. */
  get covers(): BayCovers {
    if (this.coverMap.size > COVERS_MOST) this.coverMap.clear();
    return this.coverMap;
  }
  private readonly keptLots = new Map<string, { lots: LotsProgram; bytes: number }>();
  private bytes = 0;
  /** Since `resetCounts`: the buildings' bodies walked (`emitProgram`), the programs read instead of a walk, and the lots alone walked on a floor anew (`emitLotsAt`). */
  walks = 0;
  hits = 0;
  lotWalks = 0;
  constructor(private readonly budget: number) {}

  resetCounts(): void {
    this.walks = 0;
    this.hits = 0;
    this.lotWalks = 0;
  }

  /** A building's lots on a floor (`LotsProgram`), kept beside its program. */
  getLots(key: string): LotsProgram | undefined {
    const hit = this.keptLots.get(key);
    if (!hit) return undefined;
    this.keptLots.delete(key);
    this.keptLots.set(key, hit);
    return hit.lots;
  }

  setLots(key: string, lots: LotsProgram): void {
    const was = this.keptLots.get(key);
    if (was) { this.bytes -= was.bytes; this.keptLots.delete(key); }
    const bytes = lotsBytes(lots);
    this.keptLots.set(key, { lots, bytes });
    this.bytes += bytes;
    this.trim();
  }

  deleteLots(key: string): void {
    const was = this.keptLots.get(key);
    if (!was) return;
    this.keptLots.delete(key);
    this.bytes -= was.bytes;
  }

  /** Least recently used out, lots first, till the budget holds. */
  private trim(): void {
    for (const [k, v] of this.keptLots) {
      if (this.bytes <= this.budget) return;
      this.keptLots.delete(k);
      this.bytes -= v.bytes;
    }
    for (const [k, v] of this.kept) {
      if (this.bytes <= this.budget) return;
      this.kept.delete(k);
      this.bytes -= v.bytes;
    }
  }

  get(key: string): BuildingProgram | undefined {
    const hit = this.kept.get(key);
    if (!hit) return undefined;
    // The most recently used last: the map's order is the eviction's.
    this.kept.delete(key);
    this.kept.set(key, hit);
    return hit.program;
  }

  set(key: string, program: BuildingProgram): void {
    const was = this.kept.get(key);
    if (was) { this.bytes -= was.bytes; this.kept.delete(key); }
    const bytes = programBytes(program);
    if (bytes > this.budget) return;
    this.kept.set(key, { program, bytes });
    this.bytes += bytes;
    this.trim();
  }

  /** A program let go (a job that read past what it was handed: what it walked is not kept, `cellWork.ts`). */
  delete(key: string): void {
    const was = this.kept.get(key);
    if (!was) return;
    this.kept.delete(key);
    this.bytes -= was.bytes;
  }

  /** How many programs and bytes it holds. */
  get size(): { readonly programs: number; readonly lots: number; readonly bytes: number } {
    return { programs: this.kept.size, lots: this.keptLots.size, bytes: this.bytes };
  }

  clear(): void {
    this.kept.clear();
    this.keptLots.clear();
    this.coverMap.clear();
    this.bytes = 0;
  }
}
