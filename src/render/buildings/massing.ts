import { Color } from 'three';
import { resolveBlocks } from '@world/buildings/blocks';
import { floorHeight, frontFloorHeight, type GroundAt, type PavedAt } from '@world/buildings/foundation';
import { closedBlocks } from '@world/buildings/geometry';
import type { Finish, MaterialSpec } from '@world/buildings/materials';
import type { BayComponent, Building, LotSurface } from '@world/buildings/types';
import { m } from '@world/units';
import { BAY_FLOATS, FACE_FLOATS, GROUP_FLOATS, MASS_FLATTENED, type MassProgram, type ProgramStage, SIDE_FLOATS } from './program';

/** A BUILDING FROM AFAR: its blocks as they stand, one plain mesh, with the windows drawn by the shader. DRAWN FROM THE BUILDING'S PROGRAM
 *  (`program.ts`), never by a walk of its own: the cell's, the tile's and the plate's masses are each a filter over the one mass stage the
 *  building's walk wrote (`buildingMesh.ts` emitProgram), each leaving out what its `MassDetail` drops. */

export interface MassingChunk {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly colour: Float32Array;
  /** Per vertex: metres along its face, the face's bay width */
  readonly facade: Float32Array;
  /** Per vertex: the share of a bay its windows take across (1: a curtain wall), and the building's seed */
  readonly glazing: Float32Array;
  /** Per vertex: its windows' sill and head in the storey (`windowCode`). */
  readonly window: Float32Array;
  readonly index: Uint32Array;
  /** The tallest thing this level left out or laid flat, m (`MassDetail`): 0 at the cell's level. */
  readonly error: number;
}

/** WHAT A LEVEL OF THE MASSES LEAVES OUT: the cell's (all of it), a tile's (L2) and a plate's (L3, `massLevels.ts`) */
export interface MassDetail {
  /** The tallest thing left out or laid flat, m: a relief and its cheeks, a parapet, a box on the roof, a machine room. */
  readonly drop: number;
  /** Each block a box: its pitched roof under `drop` laid flat at its eaves (L3). */
  readonly boxes: boolean;
}
export const CELL_DETAIL: MassDetail = { drop: 0, boxes: false };
/** A tile's: under 3 m (a machine room, `MACHINE_ROOM_H`; a parapet; an arcade's set-back, `ARCADE`). */
export const TILE_DETAIL: MassDetail = { drop: m(3), boxes: false };
/** A plate's: under 8 m, the pitched roofs of houses and low blocks flattened too. */
export const PLATE_DETAIL: MassDetail = { drop: m(8), boxes: true };

/** Where the wall of a block on the ground starts: below the lowest ground under it, as the detailed plinth does. */
export const BURY = m(1.5);

export const TERRACE_RGB = rgbOf(0xb0a595);
/** A sawtooth's glazed face from afar (`buildingMesh.ts` SAW_GLASS). */
export const SAW_GLASS_RGB = rgbOf(0x3c5360);

export function rgbOf(hex: number, shade = 1): [number, number, number] {
  const c = new Color().setHex(hex);
  return [c.r * shade, c.g * shade, c.b * shade];
}

export type Rgb = readonly [number, number, number];
/** Where a window sits in its storey from afar when its bay says nothing of it (a pillar's arcade): shares of the storey height from its floor. */
export const MASS_SILL = 0.3;
export const MASS_HEAD = 0.85;
/** A window's sill and head (shares of the storey) as one number a vertex: 32 steps each, an integer under 1,024 a half float holds exactly
 *  (`cellArrays.ts` MASS_GRID's fourth, `massingMaterial.ts` reads it back). */
export const windowCode = (sill: number, head: number): number =>
  Math.round(Math.min(Math.max(sill, 0), 1) * 31) * 32 + Math.round(Math.min(Math.max(head, 0), 1) * 31);
/** A facade's pattern at a vertex: along, bay, storey height, first storey's height; the glass share, the window's sill and head. */
interface Facade { readonly bay: number; readonly storey: number; readonly z0: number; readonly share: number; readonly sill: number; readonly head: number }
const NO_FACADE: Facade = { bay: 0, storey: 1, z0: 0, share: 0, sill: MASS_SILL, head: MASS_HEAD };

/** A typed array written at its end, its room doubled as it fills: DO NOT gather numbers in a `number[]` (8 bytes each and its copies as it grows) for a typed array made at the end. */
class Grown<T extends Float32Array | Uint32Array> {
  length = 0;
  constructor(private array: T, private readonly make: (n: number) => T) {}
  private room(n: number): T {
    if (this.length + n > this.array.length) {
      const bigger = this.make(Math.max(this.array.length * 2, this.length + n));
      bigger.set(this.array.subarray(0, this.length) as never);
      this.array = bigger;
    }
    return this.array;
  }
  push1(a: number): void { const t = this.room(1); t[this.length++] = a; }
  push2(a: number, b: number): void { const t = this.room(2); t[this.length++] = a; t[this.length++] = b; }
  push3(a: number, b: number, c: number): void { const t = this.room(3); t[this.length++] = a; t[this.length++] = b; t[this.length++] = c; }
  push4(a: number, b: number, c: number, d: number): void { const t = this.room(4); t[this.length++] = a; t[this.length++] = b; t[this.length++] = c; t[this.length++] = d; }
  /** What was written, in an array of its own size. */
  done(): T {
    return this.array.slice(0, this.length) as T;
  }
}
const floats = (n: number): Float32Array => new Float32Array(n);
const uints = (n: number): Uint32Array => new Uint32Array(n);

class MassWriter {
  readonly position = new Grown(floats(96), floats);
  readonly normal = new Grown(floats(96), floats);
  readonly colour = new Grown(floats(96), floats);
  readonly facade = new Grown(floats(128), floats);
  readonly glazing = new Grown(floats(64), floats);
  readonly window = new Grown(floats(32), floats);
  readonly index = new Grown(uints(96), uints);
  /** The tallest thing left out so far (`leaves`). */
  error = 0;
  constructor(frame: MassProgram['frame'], private readonly seed: number, readonly detail: MassDetail = CELL_DETAIL) {
    this.f = frame;
  }

  /** Whether a thing `size` m tall or deep is left out at this level; its size kept as the level's error when it is. */
  leaves(size: number): boolean {
    if (!(size > 0)) return false;
    if (size > this.detail.drop) return false;
    this.error = Math.max(this.error, size);
    return true;
  }

  /** The building's frame, once: DO NOT turn its rotation into a cosine and a sine and a point object for each point (`localToWorld`, the same arithmetic). */
  private readonly f: MassProgram['frame'];

  /** A point of the building's plan at height z, in three's axes. */
  P(lx: number, ly: number, z: number): [number, number, number] {
    const f = this.f;
    return [f.x + lx * f.c - ly * f.s, z, -(f.y + lx * f.s + ly * f.c)];
  }

  /** A plan direction (local) and up, as a three normal. */
  N(lx: number, ly: number, up = 0): [number, number, number] {
    const c = this.f.c, s = this.f.s;
    const wx = lx * c - ly * s, wy = lx * s + ly * c;
    const l = Math.hypot(wx, wy, up) || 1;
    return [wx / l, up / l, -wy / l];
  }

  /** A convex polygon of points (three's axes), all with one normal and colour; `along` its points' metres along their face */
  face(points: readonly (readonly [number, number, number])[], n: readonly [number, number, number], rgb: Rgb, f: Facade = NO_FACADE, along?: readonly number[]): void {
    const base = this.position.length / 3;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      this.position.push3(p[0], p[1], p[2]);
      this.normal.push3(n[0], n[1], n[2]);
      this.colour.push3(rgb[0], rgb[1], rgb[2]);
      this.facade.push4(along?.[i] ?? 0, f.bay, f.storey, f.z0);
      this.glazing.push2(f.share, this.seed);
      this.window.push1(windowCode(f.sill, f.head));
    }
    // Wound to face its normal (three's axes mirror the plan's y).
    const a = points[0]!, b = points[1]!, c = points[2]!;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const forward = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] >= 0;
    for (let i = 1; i + 1 < points.length; i++) {
      if (forward) this.index.push3(base, base + i, base + i + 1);
      else this.index.push3(base, base + i + 1, base + i);
    }
  }

  /** A flat polygon's triangles (`earcut`'s, of `points`) with its points written once and shared, as `face` would lay each triangle: DO NOT write a slab's every triangle's corners again. */
  polygon(points: readonly (readonly [number, number, number])[], tris: ArrayLike<number>, n: readonly [number, number, number], rgb: Rgb): void {
    const base = this.position.length / 3;
    for (const p of points) {
      this.position.push3(p[0], p[1], p[2]);
      this.normal.push3(n[0], n[1], n[2]);
      this.colour.push3(rgb[0], rgb[1], rgb[2]);
      this.facade.push4(0, NO_FACADE.bay, NO_FACADE.storey, NO_FACADE.z0);
      this.glazing.push2(NO_FACADE.share, this.seed);
      this.window.push1(windowCode(NO_FACADE.sill, NO_FACADE.head));
    }
    for (let i = 0; i < tris.length; i += 3) {
      const ia = tris[i]!, ib = tris[i + 1]!, ic = tris[i + 2]!;
      const a = points[ia]!, b = points[ib]!, c = points[ic]!;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const forward = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] >= 0;
      if (forward) this.index.push3(base + ia, base + ib, base + ic);
      else this.index.push3(base + ia, base + ic, base + ib);
    }
  }

  chunk(): MassingChunk {
    return {
      position: this.position.done(),
      normal: this.normal.done(),
      colour: this.colour.done(),
      facade: this.facade.done(),
      glazing: this.glazing.done(),
      window: this.window.done(),
      index: this.index.done(),
      error: this.error,
    };
  }
}

/** The building's own shade, as the detailed one has it (`buildingMesh.ts` `emitBuilding`). */
export const shadeOf = (b: Building): number => 0.93 + (((b.id * 2654435761) >>> 0) % 1000) / 1000 * 0.12;

/** A building's colours from afar: a material's tint in its own shade, times its finish's tone (`finishes.ts` `finishAlbedo`) when given. */
export function massColours(b: Building, tone?: Readonly<Record<Finish, readonly [number, number, number]>>): (spec: MaterialSpec) => Rgb {
  const shade = shadeOf(b);
  return (spec) => {
    const c = rgbOf(spec.colour, shade), t = tone?.[spec.finish];
    return t ? [c[0] * t[0], c[1] * t[1], c[2] * t[2]] : c;
  };
}

/** A building's floor as the detailed one's (`buildingMesh.ts` `emitChunk`, `floorHeight`); undefined with no closed block. */
export function massFloor(b: Building, naturalAt: GroundAt, pavedAt?: PavedAt): number | undefined {
  const resolved = resolveBlocks(b);
  return closedBlocks(resolved.volumes).length > 0 ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
}

/** A building's floor as its base stands it (`massBase.ts`, the top level, drawn from afar): its lots' front pavement, no bay laid out (`frontFloorHeight`); undefined with no closed block. Never handed to the finer levels: they stand on `massFloor`. */
export function baseFloor(b: Building, naturalAt: GroundAt, pavedAt?: PavedAt): number | undefined {
  const resolved = resolveBlocks(b);
  return closedBlocks(resolved.volumes).length > 0 ? frontFloorHeight(resolved, naturalAt, pavedAt) : undefined;
}

/** The colours of a lot's surface (`buildingMesh.ts` draws them in their finishes) */
export const LOT_COLOURS: Readonly<Record<LotSurface, number>> = {
  grass: 0x6f9a4c, paving: 0xc4beb2, gravel: 0xa9a294, sand: 0xe2cf9c, water: 0x4f8fb3,
  asphalt: 0x515457, concrete: 0xb9b6ae, pavers: 0x9a958c, tiles: 0xb4785a,
};

/** The share of a bay its window takes across, by what the bay holds (a curtain wall is all glass). */
export const GLASS_SHARE: Partial<Record<BayComponent, number>> = {
  window: 0.5, sashWindow: 0.5, shutteredWindow: 0.5, brise: 0.5,
  wideWindow: 0.75, ribbon: 0.8, bayWindow: 0.75,
  frenchWindow: 0.6, balcony: 0.6, gourmet: 0.7, loggia: 0.7,
  door: 0.35, doubleDoor: 0.5, shopfront: 0.85, pillar: 0.7,
};

/** A block's walls at a level, from its bays (`MassProgram.bays`, the layout the building's walk read): a storey's bays side by side with
 *  the same offset and glass one run, the runs alike one above the other one wall whose windows the shader counts up from the lowest
 *  (`massingMaterial.ts`); a relief or an arcade the level leaves out laid flat, its wall run on with its neighbours (one quad where they were coplanar). */
function writeWalls(w: MassWriter, p: MassProgram, block: number, floor: number): void {
  /** One run of a storey, before the storeys alike are stacked into one. */
  interface Run { side: number; a0: number; a1: number; d: number; z0: number; z1: number; zb: number; height: number; glass: number; sill: number; head: number; colour: Rgb }
  const runs: Run[] = [];
  const bays = p.bays;
  const offsetOf = (i: number): number => { const d = bays[i * BAY_FLOATS + 5]!; return w.leaves(Math.abs(d)) ? 0 : d; };
  for (let row = p.blockRows[block]!; row < p.blockRows[block + 1]!; row++) {
    const end = p.rows[row + 1]!;
    let i = p.rows[row]!;
    while (i < end) {
      const f = i * BAY_FLOATS;
      let j = i + 1;
      while (j < end && Math.abs(offsetOf(j) - offsetOf(i)) < 1e-3 && bays[j * BAY_FLOATS + 6] === bays[f + 6]
        && bays[j * BAY_FLOATS + 12] === bays[f + 12] && bays[j * BAY_FLOATS + 13] === bays[f + 13]
        && Math.abs(bays[j * BAY_FLOATS + 1]! - (bays[(j - 1) * BAY_FLOATS + 1]! + bays[(j - 1) * BAY_FLOATS + 2]!)) < 1e-3) j++;
      const l = (j - 1) * BAY_FLOATS;
      const z0 = bays[f + 3]! + floor, height = bays[f + 4]!;
      runs.push({
        side: bays[f]!, a0: bays[f + 1]!, a1: bays[l + 1]! + bays[l + 2]!, d: offsetOf(i), z0, z1: z0 + height,
        zb: bays[f + 11] ? z0 - BURY : z0, height, glass: bays[f + 7]!, sill: bays[f + 12]!, head: bays[f + 13]!, colour: [bays[f + 8]!, bays[f + 9]!, bays[f + 10]!],
      });
      i = j;
    }
  }
  // DO NOT draw a quad a storey: the storeys alike, one above the other, are one wall.
  const alike = (p: Run, q: Run): boolean => p.side === q.side && Math.abs(p.a0 - q.a0) < 1e-3 && Math.abs(p.a1 - q.a1) < 1e-3 && Math.abs(p.d - q.d) < 1e-3
    && Math.abs(p.height - q.height) < 1e-3 && p.glass === q.glass && p.sill === q.sill && p.head === q.head && p.colour[0] === q.colour[0] && p.colour[1] === q.colour[1] && p.colour[2] === q.colour[2];
  runs.sort((p, q) => p.side - q.side || p.a0 - q.a0 || p.d - q.d || p.z0 - q.z0);
  for (let i = 0; i < runs.length;) {
    const first = runs[i]!;
    let z1 = first.z1, j = i + 1;
    while (j < runs.length && alike(runs[j]!, first) && Math.abs(runs[j]!.z0 - z1) < 1e-3) z1 = runs[j++]!.z1;
    i = j;
    const { side, a0, a1, d, z0, zb, colour } = first;
    let o = p.blockSides[block]! * SIDE_FLOATS;
    while (p.sides[o] !== side) o += SIDE_FLOATS;
    const sx = p.sides[o + 1]!, sy = p.sides[o + 2]!, tx = p.sides[o + 3]!, ty = p.sides[o + 4]!, nx = p.sides[o + 5]!, ny = p.sides[o + 6]!;
    const at = (a: number, out: number, z: number): [number, number, number] => w.P(sx + tx * a + nx * out, sy + ty * a + ny * out, z);
    const facade = { bay: p.sides[o + 7]!, storey: first.height, z0, share: first.glass, sill: first.sill, head: first.head };
    w.face([at(a0, d, zb), at(a1, d, zb), at(a1, d, z1), at(a0, d, z1)], w.N(nx, ny), colour, facade, [a0, a1, a1, a0]);
    if (Math.abs(d) > 1e-3) {
      // Its cheeks at both ends and its head: a box standing out, or a recess.
      const sign = d > 0 ? 1 : -1;
      w.face([at(a0, 0, zb), at(a0, d, zb), at(a0, d, z1), at(a0, 0, z1)], w.N(-tx * sign, -ty * sign), colour);
      w.face([at(a1, d, zb), at(a1, 0, zb), at(a1, 0, z1), at(a1, d, z1)], w.N(tx * sign, ty * sign), colour);
      w.face([at(a0, 0, z1), at(a1, 0, z1), at(a1, d, z1), at(a0, d, z1)], w.N(0, 0, sign), colour);
    }
  }
}

/** A program's faces into the writer, `up` added to each height (the body's floor; 0 for the lots, laid where they lie), each kept or left
 *  out by its group (`dropped`; none for the lots). */
function writeFaces(w: MassWriter, src: { readonly faces: Float64Array; readonly points: Float64Array; readonly tris: Uint32Array }, up: number, dropped: readonly boolean[]): void {
  const f = src.faces;
  for (let o = 0; o < f.length; o += FACE_FLOATS) {
    const group = f[o]!, mode = f[o + 1]!;
    if (group >= 0) {
      const out = dropped[group]!;
      if (mode === MASS_FLATTENED ? !out : out) continue;
    }
    const first = f[o + 8]!, count = f[o + 9]!;
    const points: [number, number, number][] = [];
    for (let k = first; k < first + count; k++) points.push([src.points[k * 3]!, src.points[k * 3 + 1]! + up, src.points[k * 3 + 2]!]);
    const n: [number, number, number] = [f[o + 2]!, f[o + 3]!, f[o + 4]!], rgb: Rgb = [f[o + 5]!, f[o + 6]!, f[o + 7]!];
    if (f[o + 11]! > 0) w.polygon(points, src.tris.subarray(f[o + 10]!, f[o + 10]! + f[o + 11]!), n, rgb);
    else w.face(points, n, rgb);
  }
}

/** A building's masses at a level (`detail`): a filter over its program's mass stage (`program.ts`), its body put on its lots' floor (the
 *  floor the level stands it on), its walls joined by what the level leaves out, every other face kept or left out by its group (a parapet,
 *  a box on the roof, a machine room; a pitched roof laid flat at its eaves by a level of boxes, its slab drawn instead), its paved lots as
 *  they lie. Null when nothing is drawn. */
export function massOf(stage: ProgramStage, detail: MassDetail = CELL_DETAIL): MassingChunk | null {
  const p = stage.mass, floor = stage.lots.floor ?? 0;
  const w = new MassWriter(p.frame, p.seed, detail);
  for (let block = 0; block + 1 < p.blockRows.length; block++) writeWalls(w, p, block, floor);
  // Each group asked once (`leaves` keeps the largest left out as the level's error); a pitched roof only by a level of boxes.
  const dropped: boolean[] = [];
  for (let g = 0; g < p.groups.length; g += GROUP_FLOATS) dropped.push(p.groups[g + 1] ? detail.boxes && w.leaves(p.groups[g]!) : w.leaves(p.groups[g]!));
  writeFaces(w, p, floor, dropped);
  writeFaces(w, stage.lots, 0, []);
  return w.position.length ? w.chunk() : null;
}
