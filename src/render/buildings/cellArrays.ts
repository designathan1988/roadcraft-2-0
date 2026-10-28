import { least, most } from '@core/minMax';
import { DataUtils } from 'three';
import { CELL } from '@world/cells';
import { FINISHES, type Finish } from '@world/buildings/materials';
import { FURNITURE_KINDS, type FurnitureKind } from '@world/buildings/interior';
import { FACADE_PROP_KINDS } from './facadeProps';
import type { BuildingChunk, PartBatch, PartKind, RunChunk, ShellChunk } from './chunk';
import type { MassShells } from './buildingMesh';
import { ROOM_FLOATS } from './roomBehind';
import { LOOK_FLOATS, SHELL_PARTS, SHELL_PART_KINDS } from './shellParts';
import { POSE_FLOATS, poseMatrixInto } from './partPose';

/** A BATCH OF BUILDINGS AS ARRAYS: what `buildingMesh.ts` `meshesOf` wraps in meshes */

/** Parts drawn with a colour per instance: awnings, the window frames and balcony railings in their building's trim (the materials are white), the shell's parts in their paint. */
export const COLOURED_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['awning', 'frame', 'railing', 'fin', 'louvre', 'brise', ...FACADE_PROP_KINDS, ...SHELL_PART_KINDS]));

/** What filing a kind reads of its screen (`kit.ts` `PartScreen`), sent with each job (`kitBoxes`): its first coarser level's error, its box (the kit's `Axes`), its finest level's triangles. Here, not in `partFiling.ts`: the batches' boxes carry it, and the filing reads the batches. */
export interface PartBanding {
  readonly first: readonly [number, number, number] | null;
  readonly extent: readonly [number, number, number];
  readonly triangles: number;
}
export type PartBandings = Readonly<Record<PartKind, PartBanding>>;

/** What a batch takes: the part kinds, whether the shells and the furniture; the preview's look (`ghost`) or the faded one (`dim`). */
export interface CellSelection {
  readonly parts: readonly PartKind[];
  readonly shells: boolean;
  readonly furniture: boolean;
  readonly ghost: boolean;
  readonly dim: boolean;
  /** The far level's cell (its column and row, `BATCH_CELL`): its shells' places quantized on the cell's grid (`ShellGrid`); none: in floats (the detail's millimetre steps). */
  readonly grid?: readonly [number, number];
}

/** A cell's grid its far level's shells are laid on (`cellShellGrid`): one origin and one step for every piece of the cell, so a corner two pieces share is one point of it, bit for bit. */
export interface ShellGrid {
  /** The grid's origin, three's axes. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Metres a step: every axis alike (the mesh's scale is uniform, so its normals stay as they are). */
  readonly step: number;
}
/** How far past its cell a cell's buildings may reach on its grid, m: 250 + 2 x 60 = 370 m, under the 384 m (256 + 2 x 64) whose step was the bound. */
const SHELL_GRID_MARGIN = 60;
/** The grid's step: the cell (250 m) and its margins (2 x 60 m) in an unsigned short, 5.65 mm (a point within 2.9 mm, a hundredth of the far level's 0.3 m). */
export const SHELL_GRID_STEP = (CELL + 2 * SHELL_GRID_MARGIN) / 65535;

/** A cell's grid, its height from the lowest of its shells. */
const cellShellGrid = (i: number, j: number, lowest: number): ShellGrid =>
  ({ x: i * CELL - SHELL_GRID_MARGIN, y: lowest, z: -(j + 1) * CELL - SHELL_GRID_MARGIN, step: SHELL_GRID_STEP });

/** Pieces with their places on a grid: four unsigned shorts a vertex (the fourth left over: no 3-short format in Direct3D 11); null where a point falls off it (the cell keeps its floats). */
function onGrid(pieces: readonly ShellArrays[], grid: ShellGrid): ShellArrays[] | null {
  const out: ShellArrays[] = [];
  for (const piece of pieces) {
    const p = piece.position as Float32Array, n = p.length / 3;
    const q = new Uint16Array(n * 4);
    for (let v = 0; v < n; v++) {
      for (let k = 0; k < 3; k++) {
        const s = Math.round((p[v * 3 + k]! - (k === 0 ? grid.x : k === 1 ? grid.y : grid.z)) / grid.step);
        if (!(s >= 0 && s <= 65535)) return null;
        q[v * 4 + k] = s;
      }
    }
    out.push({ ...piece, position: q, place: grid });
  }
  return out;
}

/** A box and a sphere: minX, minY, minZ, maxX, maxY, maxZ, then centre x, y, z and radius (three's `Box3` and `Sphere`). */
export type Bounds = Float64Array;

/** The name of a batch's one shell mesh (`buildingMesh.ts` `meshesOf`), as `fade.ts` and the memory counters find it. */
export const SHELL_MESH = 'building-shell';

/** The finish id of a shell's part per instance, and of a ruin's piece per vertex (`finishes.ts`): its place in `FINISHES`, its layer of the finishes' maps. */
export const FINISH_ATTRIBUTE = 'shellFinish';
/** The shell's vertex attribute of its normal, octahedral (`octNormal`): two shorts read normalised (`finishes.ts`). */
export const SHELL_NORMAL = 'shellOctNormal';
/** The shell's vertex attribute of its paint: rgb over `COLOUR_RANGE` and the finish id in w, four unsigned shorts read normalised (`finishes.ts`). */
export const PAINT_ATTRIBUTE = 'shellPaint';

/** A finish's id, as the shell's program reads it. */
export const finishId = (finish: Finish): number => FINISHES.indexOf(finish);

/** The brightest linear colour a shell's paint holds: a light paint shaded up (1.1), the building's own shade (1.05) and the tone (1.03) stay under it. */
export const COLOUR_RANGE = 2;
/** The largest unsigned short: a paint's channel and its finish id over it. */
export const PAINT_UNIT = 65535;
/** The largest signed short: a normal's and a wear's channel over it (WebGL 2: a normalised short reads back as c / 32767). */
export const NORMAL_UNIT = 32767;

/** A linear colour channel as the shell's paint holds it: 16 bits over `COLOUR_RANGE`, a step of 3e-5 (a byte would band the dark paints). */
export const paintShort = (x: number): number => Math.round(Math.max(0, Math.min(1, Math.fround(x) / COLOUR_RANGE)) * PAINT_UNIT);
/** A number in [-1, 1] as a signed short the GPU reads back normalised: the shell's normal and wear. */
const snorm16 = (x: number): number => Math.round(Math.max(-1, Math.min(1, x)) * NORMAL_UNIT);

/** Numbers a shell vertex carries in its paint (`paint`): four shorts, rgb and its finish with its wear (`finishWear`). */
export const SHELL_SHORTS = 4;
/** Numbers a shell vertex carries in its normal (`normal`): two signed shorts, octahedral (`octNormal`). */
export const NORMAL_SHORTS = 2;
/** A wear's steps in the paint's fourth short (`finishWear`): its high byte. */
export const WEAR_STEPS = 255;

/** A wear (0..1) as the shell carries it: a byte's step, `WEAR_STEPS`. */
export const wearByte = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * WEAR_STEPS);
/** The paint's fourth short: the finish id in its low byte, the wear's byte over it (`finishes.ts` reads both back). */
export const finishWear = (finish: number, wear: number): number => finish + 256 * wearByte(wear);

/** A unit normal as two signed shorts, octahedral (Cigolle et al. 2014, "A Survey of Efficient Representations for Independent Unit Vectors"): 4 bytes, to 1e-4 rad. */
export function octNormal(x: number, y: number, z: number, out: Int16Array, at: number): void {
  const sum = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / sum, v = y / sum;
  if (z < 0) {
    const su = u >= 0 ? 1 : -1, sv = v >= 0 ? 1 : -1;
    const nu = (1 - Math.abs(v)) * su, nv = (1 - Math.abs(u)) * sv;
    u = nu; v = nv;
  }
  out[at] = snorm16(u); out[at + 1] = snorm16(v);
}

/** A normal back from its two shorts, as the shell's program reads it (`finishes.ts` `shellOctNormal`). */
export function octDecode(a: number, b: number): [number, number, number] {
  let x = Math.max(-1, a / NORMAL_UNIT), y = Math.max(-1, b / NORMAL_UNIT);
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) { const nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1), ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1); x = nx; y = ny; }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** A piece of a batch's shells of every finish, one geometry drawn in one call: 24 bytes a vertex, 44 on the far level's runs of bays with openings */
interface ShellArrays {
  /** Floats, or on its cell's grid (`place`): four unsigned shorts, read normalised and put in place by the mesh's matrix. */
  readonly position: Float32Array | Uint16Array;
  readonly place?: ShellGrid;
  /** The normal, octahedral in two signed shorts (`octNormal`): the uv is worked out from it and the place (`shellParts.ts` `shellUv`), so it needs more than a byte. */
  readonly normal: Int16Array;
  /** The paint's linear rgb (tone and grime in it) over `COLOUR_RANGE`, and the finish id with the wear (`finishWear`, `PAINT_ATTRIBUTE`), unsigned shorts. */
  readonly paint: Uint16Array;
  /** 16 bits: a piece's vertices fit them (`SHELL_PIECE`), but for a single building larger than that. */
  readonly index: Uint16Array | Uint32Array;
  readonly bounds: Bounds;
  /** The far level's runs of bays with openings only (`RunChunk`): each vertex's bay width and storey height (`FACADE_FLOATS`), its grid (`FACADE_GRID` shorts) and its opening (`FACADE_BYTES`, `facadeLevel.ts`). */
  readonly facade?: Uint16Array;
  readonly grid?: Int16Array;
  readonly opening?: Uint8Array;
  /** The detail level's runs (`RunChunk.near`): drawn over the near shell (`kit.facadeNear`). */
  readonly near?: true;
}

interface InstanceArrays {
  readonly count: number;
  readonly poses: Float32Array;
  /** Each instance's tint, linear rgb in half floats (`HALF_FLOAT`), `TINT_HALVES` an instance: 8 bytes, not 12. */
  readonly instanceColor?: Uint16Array;
  /** Window panes: each one's light slot (-1: none) and the room behind it. */
  readonly litSlot?: Float32Array;
  readonly rooms?: Uint16Array;
  /** The shell's parts: each one's finish id, wear and ground (`shellParts.ts`). */
  readonly looks?: Float32Array;
  readonly bounds: Bounds;
}

export interface CellArrays {
  /** Every finish's shells in pieces of whole buildings whose vertices fit 16-bit indices, then the far level's runs of bays with openings in pieces of their own; none when the batch takes none or has none. */
  readonly shells: readonly ShellArrays[];
  readonly parts: Readonly<Partial<Record<PartKind, InstanceArrays>>>;
  readonly furniture: Readonly<Partial<Record<FurnitureKind, InstanceArrays>>>;
}

/** Each part's and each piece of furniture's geometry box (minX, minY, minZ, maxX, maxY, maxZ), as the kit draws them. */
export interface KitBoxes {
  readonly parts: Readonly<Record<PartKind, readonly number[]>>;
  readonly furniture: Readonly<Partial<Record<FurnitureKind, readonly number[]>>>;
  /** What filing a cell's parts by band reads of each kind's screen, as the kit has them now (`partFiling.ts`). */
  readonly bandings?: PartBandings;
}

/** The batch of `chunks` that `selection` takes, as arrays. */
/** `groups`: each chunk's square (`cellWork.ts` gives the shells the cell's halves by whole detail cells, `partFiling.ts` shellPieceOf), its shells then pieced square by square: each piece's box that square's, so three leaves out of the view and out of each sun cascade the squares outside them (a piece of buildings from across the whole cell was drawn whole for a corner of it in view). */
export function cellArrays(chunks: readonly BuildingChunk[], selection: CellSelection, boxes: KitBoxes, groups?: readonly string[]): CellArrays {
  const { ghost, dim } = selection;
  const floats = selection.shells ? [...shellPieces(chunks, (c) => c.shells, groups), ...shellPieces(chunks, (c) => c.runs, groups)] : [];
  // The far level's: on its cell's grid, its height from its lowest point (`ShellGrid`).
  let lowest = Infinity;
  for (const piece of floats) lowest = Math.min(lowest, piece.bounds[1]!);
  const shells = selection.grid && floats.length ? onGrid(floats, cellShellGrid(selection.grid[0], selection.grid[1], lowest)) ?? floats : floats;
  const parts: Partial<Record<PartKind, InstanceArrays>> = {};
  for (const kind of selection.parts) {
    // A lantern's light on the wall is light, not a part: no ghost or faded copy of it.
    if (kind === 'wash' && (ghost || dim)) continue;
    let count = 0;
    for (const chunk of chunks) count += chunk.parts[kind].count;
    if (count === 0) continue;
    const glassy = !ghost && (kind === 'glass' || kind === 'glassDark');
    // DO NOT colour only the trims there: the material seen with and without instance colours was built again and again
    const coloured = !ghost && (dim || COLOURED_PARTS.has(kind));
    // The shell's parts read their finish, wear and ground as the shell's vertices do, faded too (`fade.ts`); the preview's ghost reads none.
    const looked = !ghost && SHELL_PARTS.has(kind);
    const arrays = partArrays(chunks, kind, count, glassy, coloured, looked);
    parts[kind] = { count, ...arrays, bounds: instanceBounds(arrays.poses, count, boxes.parts[kind]) };
  }
  const furniture: Partial<Record<FurnitureKind, InstanceArrays>> = {};
  // Furniture, only where an interior is drawn: one batch per kind.
  if (!ghost && selection.furniture && chunks.some((c) => c.furniture)) {
    for (const kind of FURNITURE_KINDS) {
      let count = 0;
      for (const chunk of chunks) count += chunk.furniture?.[kind]?.count ?? 0;
      const box = boxes.furniture[kind];
      if (count === 0 || !box) continue;
      const poses = furniturePoses(chunks, kind, count);
      furniture[kind] = { count, poses, bounds: instanceBounds(poses, count, box) };
    }
  }
  return { shells, parts, furniture };
}

/** Half floats per vertex of the far level's window grid (`buildingMesh.ts` `FacadeStamp`): one bay's width and one storey's height, to a millimetre or two. */
export const FACADE_FLOATS = 2;
/** Shorts per vertex of the far level's window grid, each a whole number: bay and level (u, v, whole at a run's corners), kind + `FACADE_FLIP` where the bays run against the face's own horizontal, volume * 4 + side. */
export const FACADE_GRID = 4;
/** Bytes per vertex of the far level's opening (a0, a1, h0, h1, shares of the bay) its frames' colour (r, g, b) and whether its rooms are offices (255) or homes (0). */
export const FACADE_BYTES = 12;

/** A cell's buildings from afar as one mesh's arrays (`massCells.ts`), in THE FACADE LEVEL'S OWN FORMAT (`buildingMesh.ts` massShells): the shells'
 *  vertices (`ShellArrays`: a place, an octahedral normal, a paint with its finish and wear) and the runs of bays' with their window grid; its
 *  triangles the shells' first (drawn by the shells' material), its runs' from `runs` on (drawn by the facade level's, `facadeLevel.ts`). */
export interface CellMass {
  /** Floats, or on its square's grid (`place`, `massGrid`): four unsigned shorts, read normalised and put in place by the mesh's matrix. */
  readonly position: Float32Array | Uint16Array;
  readonly place?: ShellGrid;
  /** Two signed shorts a vertex, octahedral (`octNormal`, `SHELL_NORMAL`). */
  readonly normal: Int16Array;
  /** Four unsigned shorts a vertex: the paint's linear rgb over `COLOUR_RANGE` and the finish with its wear (`PAINT_ATTRIBUTE`). */
  readonly paint: Uint16Array;
  /** The runs' window grid a vertex (`FACADE_FLOATS` half floats, `FACADE_GRID` shorts, `FACADE_BYTES` bytes), zero on the shells' vertices. */
  readonly facade: Uint16Array;
  readonly grid: Int16Array;
  readonly opening: Uint8Array;
  readonly index: Uint16Array | Uint32Array;
  /** The first index of the runs' triangles: the shells' before it. */
  readonly runs: number;
  readonly bounds: Bounds;
  readonly top: number;
  /** The tallest thing its level left out, m (`MassShells.error`): 0 for a cell's, what a tile's or a plate's choice reads (`massCells.ts`). */
  readonly error: number;
}

/** The index array a cell's mesh needs: 16 bits where its vertices fit (a cell of 240 m mostly does), else 32. */
export function indexArray(vertices: number, indices: number): Uint16Array | Uint32Array {
  return vertices > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices);
}

/** A square of cells a level's masses stand in (`levelKeys.ts`): its first column and row and its side in cells. */
export interface MassSquare { readonly i0: number; readonly j0: number; readonly n: number }

/** A square's grid for its masses (as `cellShellGrid` for a cell's shells): the square and its margins in an unsigned short, every axis alike, its height from its lowest point; a cell's step 5.65 mm, a tile's 17.1 mm, a plate's 32.3 mm (a point within half of it, a hundredth of the level's error). */
function massGrid(square: MassSquare, lowest: number): ShellGrid {
  const span = square.n * CELL + 2 * SHELL_GRID_MARGIN;
  return { x: square.i0 * CELL - SHELL_GRID_MARGIN, y: lowest, z: -(square.j0 + square.n) * CELL - SHELL_GRID_MARGIN, step: span / 65535 };
}

/** A mass's places in floats, as the GPU reads them back (from its grid, if on one). */
export function massPlaces(mass: CellMass): Float32Array {
  const place = mass.place;
  if (!place) return mass.position as Float32Array;
  const q = mass.position as Uint16Array, n = q.length / 4, out = new Float32Array(n * 3), span = Math.fround(place.step * 65535);
  for (let v = 0; v < n; v++) {
    out[v * 3] = Math.fround(Math.fround(q[v * 4]! / 65535) * span) + Math.fround(place.x);
    out[v * 3 + 1] = Math.fround(Math.fround(q[v * 4 + 1]! / 65535) * span) + Math.fround(place.y);
    out[v * 3 + 2] = Math.fround(Math.fround(q[v * 4 + 2]! / 65535) * span) + Math.fround(place.z);
  }
  return out;
}

/** A mass's places in floats put on its square's grid; the mass as it was where a point falls off it. */
export function massOnGrid(mass: CellMass, square: MassSquare): CellMass {
  const p = massPlaces(mass), n = p.length / 3;
  const grid = massGrid(square, mass.bounds[1]!);
  const q = new Uint16Array(n * 4);
  for (let v = 0; v < n; v++) {
    for (let k = 0; k < 3; k++) {
      const s = Math.round((p[v * 3 + k]! - (k === 0 ? grid.x : k === 1 ? grid.y : grid.z)) / grid.step);
      if (!(s >= 0 && s <= 65535)) return mass;
      q[v * 4 + k] = s;
    }
  }
  return { ...mass, position: q, place: grid };
}

/** The buildings' levels from afar of a cell, a tile or a plate (`buildingMesh.ts` massShells), merged as one set of arrays, on `square`'s grid
 *  when given (`massGrid`); null when none has any. */
export function cellMass(masses: readonly MassShells[], square?: MassSquare): CellMass | null {
  const merged = mergedMass(masses);
  return merged && square ? massOnGrid(merged, square) : merged;
}

/** Arrays of `vertices` vertices of the mass format (`CellMass`), zero. */
function massArrays(vertices: number): { position: Float32Array; normal: Int16Array; paint: Uint16Array; facade: Uint16Array; grid: Int16Array; opening: Uint8Array } {
  return {
    position: new Float32Array(vertices * 3), normal: new Int16Array(vertices * NORMAL_SHORTS), paint: new Uint16Array(vertices * SHELL_SHORTS),
    facade: new Uint16Array(vertices * FACADE_FLOATS), grid: new Int16Array(vertices * FACADE_GRID), opening: new Uint8Array(vertices * FACADE_BYTES),
  };
}

/** A square's masses joined from its cells' slices (`cellWork.ts` slices: each cell's masses merged in floats, `concatMass`), in the cells'
 *  order, put on the square's grid: every slice's shells' triangles, then every slice's runs' (two draws for the square). */
export function joinMass(slices: readonly CellMass[], square: MassSquare): CellMass | null {
  const joined = concatMass(slices);
  return joined && massOnGrid(joined, square);
}

/** Masses in floats one after the other (each a building's, or a cell's slice), in their order: their vertices end to end, every one's shells'
 *  triangles, then every one's runs'. Associative: the buildings of a cell joined, then the cells, are the buildings joined at once, byte for
 *  byte (`cellSlices.spec.ts`). */
export function concatMass(slices: readonly CellMass[]): CellMass | null {
  let vertices = 0, indices = 0, error = 0, top = -Infinity;
  for (const s of slices) { vertices += s.position.length / 3; indices += s.index.length; error = Math.max(error, s.error); top = Math.max(top, s.top); }
  if (indices === 0) return null;
  const out = massArrays(vertices), index = indexArray(vertices, indices);
  const bases: number[] = [];
  let v = 0;
  for (const s of slices) {
    if (s.place) throw new Error('[buildings] a cell\'s slice of masses on a grid: slices are kept in floats');
    out.position.set(s.position, v * 3);
    out.normal.set(s.normal, v * NORMAL_SHORTS);
    out.paint.set(s.paint, v * SHELL_SHORTS);
    out.facade.set(s.facade, v * FACADE_FLOATS);
    out.grid.set(s.grid, v * FACADE_GRID);
    out.opening.set(s.opening, v * FACADE_BYTES);
    bases.push(v);
    v += s.position.length / 3;
  }
  let n = 0;
  slices.forEach((s, k) => { for (let i = 0; i < s.runs; i++) index[n++] = s.index[i]! + bases[k]!; });
  const runs = n;
  slices.forEach((s, k) => { for (let i = s.runs; i < s.index.length; i++) index[n++] = s.index[i]! + bases[k]!; });
  return { ...out, index, runs, bounds: shellBounds(out.position), top, error };
}

/** The masses merged, their places in floats: every building's shells, then every building's runs of bays (`CellMass.runs`). */
function mergedMass(masses: readonly MassShells[]): CellMass | null {
  let vertices = 0, indices = 0, error = 0;
  const fragments = (m: MassShells): { shells: ShellChunk[]; runs: RunChunk[] } => ({
    shells: FINISHES.flatMap((f) => (m.shells[f] ? [m.shells[f]] : [])), runs: FINISHES.flatMap((f) => (m.runs?.[f] ? [m.runs[f]] : [])),
  });
  const all = masses.map(fragments);
  for (const [k, m] of masses.entries()) {
    error = Math.max(error, m.error);
    for (const c of [...all[k]!.shells, ...all[k]!.runs]) { vertices += c.position.length / 3; indices += c.index.length; }
  }
  if (indices === 0) return null;
  const out = massArrays(vertices), index = indexArray(vertices, indices);
  let v = 0, top = -Infinity;
  const shellIndex: number[] = [], runIndex: number[] = [];
  const put = (c: ShellChunk | RunChunk, into: number[]): void => {
    out.position.set(c.position, v * 3);
    out.normal.set(c.normal, v * NORMAL_SHORTS);
    out.paint.set(c.paint, v * SHELL_SHORTS);
    if ('facade' in c) {
      out.facade.set(c.facade, v * FACADE_FLOATS);
      out.grid.set(c.grid, v * FACADE_GRID);
      out.opening.set(c.opening, v * FACADE_BYTES);
    }
    for (let i = 0; i < c.index.length; i++) into.push(c.index[i]! + v);
    for (let i = 1; i < c.position.length; i += 3) top = Math.max(top, c.position[i]!);
    v += c.position.length / 3;
  };
  for (const { shells, runs } of all) { for (const c of shells) put(c, shellIndex); for (const c of runs) put(c, runIndex); }
  index.set(shellIndex, 0);
  index.set(runIndex, shellIndex.length);
  return { ...out, index, runs: shellIndex.length, bounds: shellBounds(out.position), top, error };
}

/** A typed array written at its end, its room doubled as it fills. */
class Grown<T extends Float32Array | Uint16Array | Int16Array | Uint8Array | Uint32Array> {
  length = 0;
  constructor(private array: T, private readonly make: (n: number) => T) {}
  /** `values` written at the end. */
  push(values: ArrayLike<number>): void {
    if (this.length + values.length > this.array.length) {
      const bigger = this.make(Math.max(this.array.length * 2, this.length + values.length));
      bigger.set(this.array.subarray(0, this.length) as never);
      this.array = bigger;
    }
    this.array.set(values as never, this.length);
    this.length += values.length;
  }
  /** `count` zeros written at the end. */
  zeros(count: number): void {
    this.push(new Uint8Array(count));
  }
  /** What was written, in an array of its own size. */
  done(): T {
    return this.array.slice(0, this.length) as T;
  }
}

/**
 * Buildings' levels from afar (`buildingMesh.ts` massShells) written one after the other as one mass in floats: each building's shells' vertices
 * then its runs', its shells' triangles filed with every building's shells' and its runs' with every building's runs' - the bytes `concatMass`
 * makes of their masses one by one, without a mass a building. DO NOT keep each building's own arrays till the end: a tile's four hundred were
 * thousands of objects alive at once (`cellJobMemory.spec.ts`).
 */
export class MassAppender {
  private readonly position = new Grown(new Float32Array(3 * 256), (n) => new Float32Array(n));
  private readonly normal = new Grown(new Int16Array(NORMAL_SHORTS * 256), (n) => new Int16Array(n));
  private readonly paint = new Grown(new Uint16Array(SHELL_SHORTS * 256), (n) => new Uint16Array(n));
  private readonly facade = new Grown(new Uint16Array(FACADE_FLOATS * 256), (n) => new Uint16Array(n));
  private readonly grid = new Grown(new Int16Array(FACADE_GRID * 256), (n) => new Int16Array(n));
  private readonly opening = new Grown(new Uint8Array(FACADE_BYTES * 256), (n) => new Uint8Array(n));
  private readonly shellIndex = new Grown(new Uint32Array(768), (n) => new Uint32Array(n));
  private readonly runIndex = new Grown(new Uint32Array(768), (n) => new Uint32Array(n));
  private vertices = 0;
  private error = 0;
  private top = -Infinity;

  /** A building's level, after the ones before. */
  add(m: MassShells): void {
    this.error = Math.max(this.error, m.error);
    const fragments = (list: readonly (ShellChunk | RunChunk)[], into: Grown<Uint32Array>): void => {
      for (const c of list) {
        const base = this.vertices, n = c.position.length / 3;
        this.position.push(c.position);
        this.normal.push(c.normal);
        this.paint.push(c.paint);
        if ('grid' in c) {
          const r = c as RunChunk;
          this.facade.push(r.facade); this.grid.push(r.grid); this.opening.push(r.opening);
        } else { this.facade.zeros(n * FACADE_FLOATS); this.grid.zeros(n * FACADE_GRID); this.opening.zeros(n * FACADE_BYTES); }
        const shifted = new Uint32Array(c.index.length);
        for (let i = 0; i < c.index.length; i++) shifted[i] = c.index[i]! + base;
        into.push(shifted);
        for (let i = 1; i < c.position.length; i += 3) this.top = Math.max(this.top, c.position[i]!);
        this.vertices += n;
      }
    };
    fragments(FINISHES.flatMap((f) => (m.shells[f] ? [m.shells[f]] : [])), this.shellIndex);
    fragments(FINISHES.flatMap((f) => (m.runs?.[f] ? [m.runs[f]] : [])), this.runIndex);
  }

  /** The mass of every building added, in floats; null for none. */
  done(): CellMass | null {
    const shells = this.shellIndex.length, indices = shells + this.runIndex.length;
    if (indices === 0) return null;
    const index = indexArray(this.vertices, indices);
    index.set(this.shellIndex.done(), 0);
    index.set(this.runIndex.done(), shells);
    const position = this.position.done();
    return {
      position, normal: this.normal.done(), paint: this.paint.done(), facade: this.facade.done(), grid: this.grid.done(), opening: this.opening.done(),
      index, runs: shells, bounds: shellBounds(position), top: this.top, error: this.error,
    };
  }
}

/** Every buffer of a cell's masses: handed over, not copied. */
export const cellMassBuffers = (c: CellMass): ArrayBuffer[] =>
  [c.position, c.normal, c.paint, c.facade, c.grid, c.opening, c.index, c.bounds].map((a) => a.buffer as ArrayBuffer);

/** What a batch sends to the GPU, in bytes: every array but the bounds (kept on the page), the kit's shared geometry not counted. */
export function cellBytes(arrays: CellArrays): number {
  let bytes = 0;
  // An array let go once on the GPU (`gpuOnly`) counts nothing: the sum is the budget's, never a crash.
  for (const s of arrays.shells) bytes += (s.position?.byteLength ?? 0) + (s.normal?.byteLength ?? 0) + (s.paint?.byteLength ?? 0) + (s.index?.byteLength ?? 0) + (s.facade?.byteLength ?? 0) + (s.grid?.byteLength ?? 0) + (s.opening?.byteLength ?? 0);
  for (const list of [arrays.parts, arrays.furniture]) {
    for (const p of Object.values(list) as (InstanceArrays | undefined)[]) {
      if (!p) continue;
      bytes += p.poses?.byteLength ?? 0;
      for (const a of [p.instanceColor, p.litSlot, p.rooms, p.looks]) if (a) bytes += a.byteLength;
    }
  }
  return bytes;
}

/** Every array buffer of a batch: handed over, not copied (MDN, `postMessage` transfer). */
export function cellBuffers(arrays: CellArrays): ArrayBuffer[] {
  const out: ArrayBufferLike[] = [];
  for (const s of arrays.shells) {
    out.push(s.position.buffer, s.normal.buffer, s.paint.buffer, s.index.buffer, s.bounds.buffer);
    if (s.facade) out.push(s.facade.buffer);
    if (s.grid) out.push(s.grid.buffer);
    if (s.opening) out.push(s.opening.buffer);
  }
  for (const list of [arrays.parts, arrays.furniture]) {
    for (const p of Object.values(list) as (InstanceArrays | undefined)[]) {
      if (!p) continue;
      out.push(p.poses.buffer, p.bounds.buffer);
      for (const a of [p.instanceColor, p.litSlot, p.rooms, p.looks]) if (a) out.push(a.buffer);
    }
  }
  return out as ArrayBuffer[];
}

/** The most vertices a shell piece holds: every index of it fits 16 bits (meshoptimizer's advice: half the index memory and fetch), 65535 left out (WebGL 2.0 spec, "PRIMITIVE_RESTART_FIXED_INDEX is always enabled"). */
export const SHELL_PIECE = 0xffff;

/** A chunk's shell fragments as a piece reads them: the plain ones, or the far level's runs (with their window grid). */
type FragmentsOf = (chunk: BuildingChunk) => Readonly<Partial<Record<Finish, ShellChunk | RunChunk>>> | undefined;

/** The vertices of a chunk's fragments, every finish. */
function chunkVertices(chunk: BuildingChunk, of: FragmentsOf): number {
  let n = 0;
  const fragments = of(chunk);
  if (fragments) for (const finish of FINISHES) n += (fragments[finish]?.position.length ?? 0) / 3;
  return n;
}

/** Every chunk's fragments in pieces, the chunks in order, a piece closed before a chunk would take it past `SHELL_PIECE` vertices (a chunk is never cut: a larger one is a piece alone, with 32-bit indices). */
function shellPieces(chunks: readonly BuildingChunk[], of: FragmentsOf, groups?: readonly string[]): ShellArrays[] {
  // By group: each group's chunks in their order, the groups in the order they first come (the same chunks make the same pieces, `buildingMesh.ts` refill).
  if (groups) {
    const byGroup = new Map<string, BuildingChunk[]>();
    chunks.forEach((chunk, i) => { const key = groups[i]!; const list = byGroup.get(key); if (list) list.push(chunk); else byGroup.set(key, [chunk]); });
    if (byGroup.size > 1) return [...byGroup.values()].flatMap((list) => shellPieces(list, of));
  }
  const pieces: ShellArrays[] = [];
  let from = 0, vertices = 0;
  for (let i = 0; i < chunks.length; i++) {
    const n = chunkVertices(chunks[i]!, of);
    if (vertices > 0 && vertices + n > SHELL_PIECE) {
      const piece = shellArrays(chunks.slice(from, i), of);
      if (piece) pieces.push(piece);
      from = i;
      vertices = 0;
    }
    vertices += n;
  }
  const last = shellArrays(chunks.slice(from), of);
  if (last) pieces.push(last);
  return pieces;
}

/** The fragments of every finish of `chunks` in one set of arrays, finish by finish in `FINISHES` order (the chunks' arrays, already in the GPU's layout, concatenated; the indices shifted), or null when none has any. */
function shellArrays(chunks: readonly BuildingChunk[], of: FragmentsOf): ShellArrays | null {
  let vertices = 0;
  let indices = 0;
  let runs = false, near = false;
  for (const chunk of chunks) {
    const fragments = of(chunk);
    if (!fragments) continue;
    for (const finish of FINISHES) {
      const part = fragments[finish];
      if (!part) continue;
      vertices += part.position.length / 3;
      indices += part.index.length;
      if ('facade' in part) { runs = true; if (part.near) near = true; }
    }
  }
  if (indices === 0) return null;
  const position = new Float32Array(vertices * 3);
  const normal = new Int16Array(vertices * NORMAL_SHORTS);
  const paint = new Uint16Array(vertices * SHELL_SHORTS);
  const index = indexArray(vertices, indices);
  const facade = runs ? new Uint16Array(vertices * FACADE_FLOATS) : undefined;
  const grid = runs ? new Int16Array(vertices * FACADE_GRID) : undefined;
  const opening = runs ? new Uint8Array(vertices * FACADE_BYTES) : undefined;
  let v = 0;
  let n = 0;
  for (const finish of FINISHES) {
    for (const chunk of chunks) {
      const part = of(chunk)?.[finish];
      if (!part) continue;
      position.set(part.position, v * 3);
      normal.set(part.normal, v * NORMAL_SHORTS);
      paint.set(part.paint, v * SHELL_SHORTS);
      if ('facade' in part) {
        facade?.set(part.facade, v * FACADE_FLOATS);
        grid?.set(part.grid, v * FACADE_GRID);
        opening?.set(part.opening, v * FACADE_BYTES);
      }
      offsetIndices(index, n, part.index, v);
      v += part.position.length / 3;
      n += part.index.length;
    }
  }
  const bounds = shellBounds(position);
  return { position, normal, paint, index, bounds, ...(facade && grid && opening ? { facade, grid, opening } : {}), ...(near ? { near: true as const } : {}) };
}

/** 1 in half float: an instance with no tint of its own. */
const HALF_ONE = DataUtils.toHalfFloat(1);
/** Half floats an instance's tint takes, from where it is made to every mesh that draws it: its rgb and one left over. DO NOT draw it three wide:
 *  D3D11 has no three-component half format, and ANGLE copies every such buffer to a four-wide one on the CPU (`formatutils11.cpp`: R16G16B16_FLOAT
 *  VERTEX_CONVERT_CPU), the parts' tints at every cell come or gone under a moving camera (the move reports' "HALF x3", 2026-10-27). */
export const TINT_HALVES = 4;

/** A batch's own instance arrays from its chunks, in order: the matrices, the colours of a coloured kind */
function partArrays(chunks: readonly BuildingChunk[], kind: PartKind, count: number, glassy: boolean, coloured: boolean, looked: boolean): {
  poses: Float32Array; instanceColor?: Uint16Array; litSlot?: Float32Array; rooms?: Uint16Array; looks?: Float32Array;
} {
  const poses = new Float32Array(count * POSE_FLOATS);
  const instanceColor = coloured ? new Uint16Array(count * TINT_HALVES).fill(HALF_ONE) : undefined;
  const litSlot = glassy ? new Float32Array(count) : undefined;
  const rooms = glassy ? new Uint16Array(count * ROOM_FLOATS) : undefined;
  const looks = looked ? new Float32Array(count * LOOK_FLOATS) : undefined;
  let at = 0;
  for (const chunk of chunks) {
    const batch: PartBatch = chunk.parts[kind];
    if (batch.count === 0) continue;
    poses.set(batch.poses, at * POSE_FLOATS);
    if (instanceColor && batch.colours) {
      for (let i = 0; i < batch.count; i++) for (let k = 0; k < 3; k++) instanceColor[(at + i) * TINT_HALVES + k] = DataUtils.toHalfFloat(batch.colours[i * 3 + k]!);
    }
    if (litSlot) {
      if (batch.slots) litSlot.set(batch.slots, at);
      else litSlot.fill(-1, at, at + batch.count);
    }
    if (rooms && batch.rooms) rooms.set(batch.rooms, at * ROOM_FLOATS);
    if (looks && batch.looks) looks.set(batch.looks, at * LOOK_FLOATS);
    at += batch.count;
  }
  return { poses, ...(instanceColor ? { instanceColor } : {}), ...(litSlot ? { litSlot } : {}), ...(rooms ? { rooms } : {}), ...(looks ? { looks } : {}) };
}

/** The furniture of one kind of every chunk, its poses in chunk order. */
function furniturePoses(chunks: readonly BuildingChunk[], kind: FurnitureKind, count: number): Float32Array {
  const poses = new Float32Array(count * POSE_FLOATS);
  let at = 0;
  for (const chunk of chunks) {
    const batch = chunk.furniture?.[kind];
    if (!batch) continue;
    poses.set(batch.poses, at * POSE_FLOATS);
    at += batch.count;
  }
  return poses;
}

/** A fragment's indices written into `out` at `at`, each `add` more (its vertices' place in the merged arrays): a loop of its own, DO NOT inline it in `shellArrays` (entered on the stack, its code left at every fragment's end, 205 times a job). */
function offsetIndices(out: Uint16Array | Uint32Array, at: number, from: ArrayLike<number>, add: number): void {
  for (let i = 0; i < from.length; i++) out[at + i] = from[i]! + add;
}

/** What `shellBounds`'s loops write: the box (min x, y, z, max x, y, z) and the farthest squared distance from its centre. */
const SHELL_BOX = new Float64Array(7);

/** A shell's box and sphere as three's `BufferGeometry.computeBoundingBox` and `computeBoundingSphere` work them out */
/** DO NOT work the box's centre and radius out after its loops in one function: entered on the stack (OSR), its code never saw them run and left there for each shell (`instanceBounds`). */
function shellBounds(position: Float32Array): Bounds {
  boxOfPoints(position, SHELL_BOX);
  const minX = SHELL_BOX[0]!, minY = SHELL_BOX[1]!, minZ = SHELL_BOX[2]!, maxX = SHELL_BOX[3]!, maxY = SHELL_BOX[4]!, maxZ = SHELL_BOX[5]!;
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  farthestFrom(position, cx, cy, cz, SHELL_BOX);
  return Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz, Math.sqrt(SHELL_BOX[6]!));
}

/** The box of the points, written into `out` after each one. */
function boxOfPoints(position: Float32Array, out: Float64Array): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i]!, y = position[i + 1]!, z = position[i + 2]!;
    minX = least(minX, x); minY = least(minY, y); minZ = least(minZ, z);
    maxX = most(maxX, x); maxY = most(maxY, y); maxZ = most(maxZ, z);
    out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  }
}

/** The farthest squared distance of the points from (cx, cy, cz), written into `out[6]` after each one. */
function farthestFrom(position: Float32Array, cx: number, cy: number, cz: number, out: Float64Array): void {
  let far = 0;
  out[6] = far;
  for (let i = 0; i < position.length; i += 3) {
    const dx = cx - position[i]!, dy = cy - position[i + 1]!, dz = cz - position[i + 2]!;
    far = most(far, dx * dx + dy * dy + dz * dz);
    out[6] = far;
  }
}

/** One instance's matrix, written over by each instance `instanceBounds` reads. */
const BOUNDS_MATRIX = new Float32Array(16);
/** The box `boxOfInstances` widens: min x, y, z, max x, y, z. */
const BOUNDS_BOX = new Float64Array(6);

/** An instanced batch's box and sphere as three's `InstancedMesh.computeBoundingBox` works the box out */
/** DO NOT end the loop over the instances with the box's sums in the same function: entered on the stack (OSR) on its first long batch, its code never saw the sums run and left on them for every batch after (138 times a job), each batch's start run unoptimised, every number boxed. */
function instanceBounds(poses: Float32Array, count: number, box: readonly number[]): Bounds {
  boxOfInstances(poses, count, box, BOUNDS_BOX);
  const minX = BOUNDS_BOX[0]!, minY = BOUNDS_BOX[1]!, minZ = BOUNDS_BOX[2]!, maxX = BOUNDS_BOX[3]!, maxY = BOUNDS_BOX[4]!, maxZ = BOUNDS_BOX[5]!;
  const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
  return Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ, (minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5, Math.sqrt(sx * sx + sy * sy + sz * sz) * 0.5);
}

/** The box of every instance's corners, written into `out` (min x, y, z, max x, y, z) after each instance: nothing after the loop for its code to have never run. */
function boxOfInstances(poses: Float32Array, count: number, box: readonly number[], out: Float64Array): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  const [bx0, by0, bz0, bx1, by1, bz1] = box as [number, number, number, number, number, number];
  const matrices = BOUNDS_MATRIX, o = 0;
  for (let i = 0; i < count; i++) {
    // Each instance's matrix as the GPU makes it from its pose (`partPose.ts`).
    poseMatrixInto(poses, i * POSE_FLOATS, matrices, 0);
    const e0 = matrices[o]!, e1 = matrices[o + 1]!, e2 = matrices[o + 2]!, e3 = matrices[o + 3]!;
    const e4 = matrices[o + 4]!, e5 = matrices[o + 5]!, e6 = matrices[o + 6]!, e7 = matrices[o + 7]!;
    const e8 = matrices[o + 8]!, e9 = matrices[o + 9]!, e10 = matrices[o + 10]!, e11 = matrices[o + 11]!;
    const e12 = matrices[o + 12]!, e13 = matrices[o + 13]!, e14 = matrices[o + 14]!, e15 = matrices[o + 15]!;
    // The corners in three's order (000, 001, 010, 011, 100, 101, 110, 111), each through the matrix.
    for (let c = 0; c < 8; c++) {
      const x = c & 4 ? bx1 : bx0, y = c & 2 ? by1 : by0, z = c & 1 ? bz1 : bz0;
      const w = 1 / (e3 * x + e7 * y + e11 * z + e15);
      const px = (e0 * x + e4 * y + e8 * z + e12) * w;
      const py = (e1 * x + e5 * y + e9 * z + e13) * w;
      const pz = (e2 * x + e6 * y + e10 * z + e14) * w;
      // Comparisons, not the built-ins: each `Math.min` here was a call and a boxed result (`core/minMax.ts`).
      minX = least(minX, px); minY = least(minY, py); minZ = least(minZ, pz);
      maxX = most(maxX, px); maxY = most(maxY, py); maxZ = most(maxZ, pz);
    }
    out[0] = minX; out[1] = minY; out[2] = minZ; out[3] = maxX; out[4] = maxY; out[5] = maxZ;
  }
}
