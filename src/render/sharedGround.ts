import { PLATE_SIZE, plateCentre, plateIndex, plateOf } from '@world/bounds';
import { type ReliefVersion, reliefHeight } from '@world/terrain';
import { sampleCorners } from './terrainShaping';
import { type JoinedSeams, seamHeightAt } from './terrainSeams';

/** THE GROUND'S HEIGHTS IN SHARED MEMORY: each plate's corners as drawn and as they were before the roads, the plate's own arrays (`terrain.ts`), read by any worker as the page reads them (`flatAtlas.ts`) */

/** One plate's corners and the diagonals they are drawn with, as drawn (`renderedHeightAt`) and natural (`naturalRenderedHeightAt`). */
export interface PlateHeights {
  readonly rendered: Float64Array;
  readonly natural: Float64Array;
  readonly flip: Uint8Array;
  readonly naturalFlip: Uint8Array;
}

/** What a job reads the ground from: each plate's buffer (null: a plate not made, read off the relief), its grid and the relief. */
export interface SharedGroundData {
  /** Corners a side, the cell, half the plate, the base level the corners carry. */
  readonly n: number;
  readonly cell: number;
  readonly half: number;
  readonly base: number;
  readonly relief: ReliefVersion | null;
  /** The plates made, by key (`world/bounds.ts` `plateOf`); a plate not in it is read off the relief. */
  readonly plates: ReadonlyMap<number, SharedArrayBuffer>;
  /** Plates made but left out of `plates` (`groundAround`): a read there is a miss, not the relief. */
  readonly away?: readonly number[];
  /** Each plate's cut cells as last cut (`packSeams`), by key: the ground as drawn there is theirs (`terrainSeams.ts`), not the grid's. */
  readonly seams?: ReadonlyMap<number, SharedArrayBuffer>;
}

/** What `seamHeightAt` reads of a plate's cut cells, as `packSeams` lays it: its normals and errors stay with the plate. */
type SeamReads = Pick<JoinedSeams, 'positions' | 'seam' | 'index' | 'cells' | 'cellStart' | 'cellTris'>;

/** A plate's cut cells in one buffer a worker reads (`unpackSeams`): four counts (cells, triangles, vertices, filed triangles), then the cells,
 *  their starts, the filed triangles and the index (32-bit integers), the positions and the corners (32-bit floats). A new buffer each cut: a job
 *  handed one reads the cut it was handed. */
function packSeams(seams: JoinedSeams): SharedArrayBuffer {
  const c = seams.cells.length, t = seams.index.length / 3, v = seams.positions.length / 3, k = seams.cellTris.length;
  const words = 4 + c + (c + 1) + k + t * 3 + v * 3 + v * 3;
  const buffer = new SharedArrayBuffer(words * 4);
  const ints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  ints.set([c, t, v, k]);
  let o = 4;
  ints.set(seams.cells, o); o += c;
  ints.set(seams.cellStart, o); o += c + 1;
  ints.set(seams.cellTris, o); o += k;
  ints.set(seams.index, o); o += t * 3;
  floats.set(seams.positions, o); o += v * 3;
  floats.set(seams.seam, o);
  return buffer;
}

/** `packSeams`' buffer read back as views (no copy). */
function unpackSeams(buffer: SharedArrayBuffer): SeamReads {
  const ints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  const c = ints[0]!, t = ints[1]!, v = ints[2]!, k = ints[3]!;
  let o = 4;
  const cells = ints.subarray(o, o += c), cellStart = ints.subarray(o, o += c + 1), cellTris = ints.subarray(o, o += k), index = ints.subarray(o, o += t * 3);
  const positions = floats.subarray(o, o += v * 3), seam = floats.subarray(o, o + v * 3);
  return { cells, cellStart, cellTris, index, positions, seam };
}

/** The ground as a building reads it: as drawn, and as it was before the roads cut it. */
export interface GroundReaders {
  readonly groundAt: (x: number, y: number) => number;
  readonly naturalAt: (x: number, y: number) => number;
}

/** The ground as drawn, as the page reads it, with the shared plates it reads (`flatAtlas.ts` `renderedHeightAt`): a job handed it reads the same ground in a worker. */
export interface SharedGroundAt {
  (x: number, y: number): number;
  readonly share?: GroundShare;
}

/** Whether memory can be shared with the workers: a cross-origin isolated page (MDN, `SharedArrayBuffer`, COOP/COEP), or Node. */
function canShareMemory(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
}

/** A plate's bytes: two corner arrays of doubles, two diagonal arrays of bytes. */
const plateBytes = (n: number): number => n * n * 16 + (n - 1) * (n - 1) * 2;

/** A plate's arrays over its buffer, laid one after the other. */
function viewsOf(buffer: SharedArrayBuffer, n: number): PlateHeights {
  const corners = n * n, cells = (n - 1) * (n - 1);
  return {
    rendered: new Float64Array(buffer, 0, corners),
    natural: new Float64Array(buffer, corners * 8, corners),
    flip: new Uint8Array(buffer, corners * 16, cells),
    naturalFlip: new Uint8Array(buffer, corners * 16 + cells, cells),
  };
}

/** DO NOT copy the plates' heights for the workers: the plate writes its corners into the shared buffer itself, a stroke or a road reaching the workers as it lands, no message */
export class GroundShare {
  /** The plates made only: the world has no list of plates to hold a slot for each. */
  private readonly buffers = new Map<number, SharedArrayBuffer>();
  /** Each plate's cut cells as last cut (`setSeams`). */
  private readonly seams = new Map<number, SharedArrayBuffer>();
  private relief: ReliefVersion | null = null;
  /** What jobs are handed, made again only when a plate is made or let go, or the relief changes. */
  private data: SharedGroundData | null = null;
  private readonly shared = canShareMemory();

  constructor(private readonly n: number, private readonly cell: number, private readonly half: number, private readonly base: number) {}

  /** A plate made: the arrays it keeps its corners in, shared (null where memory cannot be shared: the plate makes its own). */
  open(key: number): PlateHeights | null {
    if (!this.shared) return null;
    const buffer = new SharedArrayBuffer(plateBytes(this.n));
    this.buffers.set(key, buffer);
    this.data = null;
    return viewsOf(buffer, this.n);
  }

  /** A plate let go: read off the relief from now on, as the page reads it. */
  close(key: number): void {
    this.seams.delete(key);
    if (!this.buffers.delete(key)) return;
    this.data = null;
  }

  /** A plate's cut cells cut again (null: none now): read by the jobs handed the ground from now on. */
  setSeams(key: number, seams: JoinedSeams | null): void {
    if (!this.shared || !this.buffers.has(key)) return;
    if (seams) this.seams.set(key, packSeams(seams)); else if (!this.seams.delete(key)) return;
    this.data = null;
  }

  setRelief(relief: ReliefVersion | null): void {
    if (relief === this.relief) return;
    this.relief = relief;
    this.data = null;
  }

  /** What a job reads the ground from; null where memory cannot be shared. */
  get current(): SharedGroundData | null {
    if (!this.shared) return null;
    return this.data ??= { n: this.n, cell: this.cell, half: this.half, base: this.base, relief: this.relief, plates: new Map(this.buffers), seams: new Map(this.seams) };
  }
}

/** The ground of the plates over `rect` alone ([x0, y0, x1, y1]), the others made said `away`: what a job sent to another process carries (`jobs/processWorker.ts`), whose memory is not the page's - every plate is copied there, and all of a large city's went with every cell job (~33 MB, JOB-03). */
export function groundAround(data: SharedGroundData, rect: readonly [number, number, number, number]): SharedGroundData {
  const near = new Set<number>();
  const i0 = plateIndex(rect[0]), i1 = plateIndex(rect[2]);
  const j0 = plateIndex(rect[1]), j1 = plateIndex(rect[3]);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) near.add(plateOf((i + 0.5) * PLATE_SIZE, (j + 0.5) * PLATE_SIZE));
  const plates = new Map<number, SharedArrayBuffer>(), away: number[] = [];
  for (const [key, buffer] of data.plates) if (near.has(key)) plates.set(key, buffer); else away.push(key);
  const seams = new Map<number, SharedArrayBuffer>();
  for (const [key, buffer] of data.seams ?? []) if (near.has(key)) seams.set(key, buffer);
  return { ...data, plates, away, seams };
}

/** The ground read off the shared plates, point for point as `flatAtlas.ts` `ask` and `terrain.ts` `sampleGrid` read it on the page; `missed`, told of a read on a plate left `away` (its height then the relief's: the job is asked again over it). */
export function sharedGroundReaders(data: SharedGroundData, missed?: (x: number, y: number) => void): GroundReaders {
  const grid = { n: data.n, cell: data.cell, half: data.half };
  const views = new Map<number, PlateHeights | null>();
  const away = data.away?.length ? new Set(data.away) : null;
  const viewOf = (key: number, x: number, y: number): PlateHeights | null => {
    let v = views.get(key);
    if (v === undefined) {
      if (away?.has(key)) { missed?.(x, y); return null; }
      const buffer = data.plates.get(key);
      views.set(key, v = buffer ? viewsOf(buffer, data.n) : null);
    }
    return v;
  };
  /** Each plate's cut cells, read once (`unpackSeams`). */
  const cuts = new Map<number, SeamReads | null>();
  const cutOf = (key: number): SeamReads | null => {
    let cut = cuts.get(key);
    if (cut === undefined) { const buffer = data.seams?.get(key); cuts.set(key, cut = buffer ? unpackSeams(buffer) : null); }
    return cut;
  };
  /** A plate not made: the base and the map's own relief (`flatAtlas.ts` `bareAt`). */
  const bare = (x: number, y: number): number => data.base + (data.relief === null ? 0 : reliefHeight(data.relief, x, y));
  const read = (natural: boolean) => (x: number, y: number): number => {
    // The plate and its centre without an object a read: a building's emission reads the ground thousands of times.
    const cx = plateCentre(x), cy = plateCentre(y);
    const lx = x - cx, ly = y - cy;
    const key = plateOf(x, y);
    const v = viewOf(key, x, y);
    if (!v || !(lx >= -data.half && lx <= data.half && ly >= -data.half && ly <= data.half)) return bare(cx + lx, cy + ly);
    if (natural) return sampleCorners(grid, v.natural, v.naturalFlip, lx, ly);
    // In a cut cell, the terrain drawn there, as the page reads it (`terrain.ts` renderedHeightAt).
    const cut = cutOf(key);
    const seam = cut ? seamHeightAt(cut as JoinedSeams, grid, (i) => v.rendered[i]!, lx, ly) : undefined;
    return seam ?? sampleCorners(grid, v.rendered, v.flip, lx, ly);
  };
  return { groundAt: read(false), naturalAt: read(true) };
}
