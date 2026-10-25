import type { Tile } from './mesh/tileMesh';
import { CELL, type PartKey } from './roadSurfaceEntries';

/**
 * # THE ROADS' FOOTPRINTS ON THE GROUND, PART BY PART
 *
 * What each part of the road surfaces put in place draws over the ground (`roads/pieceMesh.ts` FOOTPRINT, kept in its bundle with its surfaces):
 * the triangles the terrain is cut away under and meets the outline of (`terrainSeams.ts`). A build stages its parts' footprints as it makes them
 * (`stage`); they become the footprint the terrain reads only when the build is put in place (`commit`, at `RoadSurfaces.adopt`), so the ground is
 * never cut for a road not drawn yet, nor left cut for one taken away.
 */

/** A world box: x0, y0, x1, y1. */
export type FootprintRect = readonly [number, number, number, number];

interface Footprint {
  /** The part's digest it was made at (`roadSurfaces.ts` PassTile.value). */
  readonly value: number;
  /** x, y, h of three corners each, world coordinates. */
  readonly tris: Float64Array;
  readonly box: FootprintRect;
}

/** Cells the footprints are filed under (the road blocks', `roadSurfaceEntries.ts`: 500 m). */
const FILE = CELL;
const cellKey = (i: number, j: number): number => (i + 32_768) * 65_536 + (j + 32_768);

export class RoadFootprints {
  private readonly parts = new Map<string, Footprint>();
  private readonly cells = new Map<number, Set<string>>();
  /** What the build being made changes, by part: its footprint, or null for a part it takes away. */
  private readonly staged = new Map<string, Footprint | null>();
  /** Where the footprints changed since they were last asked (`takeMoved`); null: anywhere. */
  private moved: FootprintRect[] | null = [];

  /** A part's footprint as the build being made draws it: from its bundle's `FOOTPRINT` tile (x, h, -y), none for a part with none; `keep`, the
   *  triangles of it the terrain is cut along (a tunnel's where its cutting is open, not where it bores under the hill). */
  stage(pass: string, part: PartKey, value: number, tile: Tile | null | undefined, keep?: (x: number, y: number, h: number) => boolean): void {
    const id = `${pass}|${part}`;
    if (!tile || tile.positions.length < 9) { this.staged.set(id, null); return; }
    const p = tile.positions;
    const out: number[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let t = 0; t + 8 < p.length; t += 9) {
      if (keep && !keep((p[t]! + p[t + 3]! + p[t + 6]!) / 3, -(p[t + 2]! + p[t + 5]! + p[t + 8]!) / 3, (p[t + 1]! + p[t + 4]! + p[t + 7]!) / 3)) continue;
      for (let v = 0; v < 9; v += 3) {
        const x = p[t + v]!, y = -p[t + v + 2]!;
        out.push(x, y, p[t + v + 1]!);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    this.staged.set(id, out.length ? { value, tris: Float64Array.from(out), box: [x0, y0, x1, y1] } : null);
  }

  /** Whether a part's footprint at `value` is known (put in place, or staged by the build being made). */
  has(pass: string, part: PartKey, value: number): boolean {
    const id = `${pass}|${part}`;
    const staged = this.staged.get(id);
    if (staged !== undefined) return staged !== null && staged.value === value;
    return this.parts.get(id)?.value === value;
  }

  /** A part the build being made takes away. */
  drop(pass: string, part: PartKey): void {
    this.staged.set(`${pass}|${part}`, null);
  }

  /** A pass the build being made has no more: every part of it. */
  dropPass(pass: string): void {
    const prefix = `${pass}|`;
    for (const id of this.parts.keys()) if (id.startsWith(prefix)) this.staged.set(id, null);
    for (const id of this.staged.keys()) if (id.startsWith(prefix)) this.staged.set(id, null);
  }

  /** The build put in place: what it staged is the footprint now, the boxes it changed kept for `takeMoved`. */
  commit(): void {
    for (const [id, next] of this.staged) {
      const was = this.parts.get(id);
      if (was?.value === next?.value && (was === undefined) === (next === null)) continue;
      if (was) { this.file(id, was.box, false); this.parts.delete(id); this.moved?.push(was.box); }
      if (next) { this.parts.set(id, next); this.file(id, next.box, true); this.moved?.push(next.box); }
    }
    this.staged.clear();
  }

  /** Every footprint gone at once (the roads let go: none drawn), its staging with it. */
  clear(): void {
    if (this.parts.size) this.moved = null;
    this.parts.clear();
    this.cells.clear();
    this.staged.clear();
  }

  /** Where the footprints changed since last asked (null: anywhere), and from now on none. */
  takeMoved(): FootprintRect[] | null {
    const moved = this.moved;
    this.moved = [];
    return moved;
  }

  /** The triangles (x, y, h of three corners each, world) of every footprint whose box meets `rect`. */
  meeting(rect: FootprintRect): Float64Array[] {
    const ids = new Set<string>();
    for (let i = Math.floor(rect[0] / FILE); i <= Math.floor(rect[2] / FILE); i++) {
      for (let j = Math.floor(rect[1] / FILE); j <= Math.floor(rect[3] / FILE); j++) for (const id of this.cells.get(cellKey(i, j)) ?? []) ids.add(id);
    }
    const out: Float64Array[] = [];
    for (const id of ids) {
      const f = this.parts.get(id)!;
      if (f.box[2] < rect[0] || f.box[0] > rect[2] || f.box[3] < rect[1] || f.box[1] > rect[3]) continue;
      out.push(f.tris);
    }
    return out;
  }

  private file(id: string, box: FootprintRect, add: boolean): void {
    for (let i = Math.floor(box[0] / FILE); i <= Math.floor(box[2] / FILE); i++) {
      for (let j = Math.floor(box[1] / FILE); j <= Math.floor(box[3] / FILE); j++) {
        const key = cellKey(i, j);
        let set = this.cells.get(key);
        if (add) { if (!set) this.cells.set(key, set = new Set()); set.add(id); } else if (set) { set.delete(id); if (!set.size) this.cells.delete(key); }
      }
    }
  }
}
