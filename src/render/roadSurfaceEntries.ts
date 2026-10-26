import type { ChangeRect } from '@world/changes';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadStructure } from '@world/structures';
import type { Vec2 } from '@core/vec2';
import { m } from '@world/units';
import { ownerCell } from './roads/pieceOwner';
import type { Geom, Input } from './roads/pieceGeom';

/** THE ROAD SURFACES' INPUTS AS THEY ARE FILED (`roadSurfaceInputs.ts`): the pieces (a road, a junction), the part each is drawn as (the piece
 *  whole, in the block that owns it), the entries, their kinds and the order a walk of the map meets them in, and what the inputs held round the
 *  view count an item by (`InputResidency`) - plain data and pure functions. */

/** World size of one tile: the grid the inputs not derived are filed by (`roadSurfaceInputs.ts`), 10 cells of the universal grid (`world/grid.ts`
 *  GRID_CELL), its lines on the universal grid's (the grid starts at the origin). Nothing is cut at a tile's or a block's line: a piece is drawn
 *  whole in the block its owner point lies in (`roads/pieceOwner.ts`). */
export const TILE = m(100);
/** How far round a piece's box a shape of it may reach (a rounding past its edges). */
export const TILE_REACH = m(0.2);
/** Tiles a side of a block: a block is the network's far level's square (`renderer.ts` FAR_ROAD_CELL), a mesh a surface over 500 m of roads,
 *  half a tile of the world (`world/tiles.ts`): 2 x 2 blocks a tile. */
export const CHUNK = 5;
/** A block's square: the pieces whose owner point lies in it are drawn in it, whole (`roads/pieceOwner.ts`), at every level. */
export const CELL = TILE * CHUNK;

/** A piece's key: its id then what it is (`pieceKey`). A part's key: its piece's, then its owner block's column and row (`partKey`). Fixed-width
 *  hex, so two keys compare as their ids, kinds, columns and rows do (`byPart`). DO NOT pack them in a number: a tile's ids start at 2^52 + 2^20
 *  (`world/tiles.ts` tileIdBase), no bit is left past the id (MDN, Number.MAX_SAFE_INTEGER): `id * 2` ran a node into the next road and
 *  `piece * 2^24` lost the block, every part of a generated city read as block (-2048, -2048). */
export type PieceKey = string;
export type PartKey = string;
/** Hex digits of an id: every safe integer (under 2^53) in 14. */
const ID_DIGITS = 14;
/** Hex digits of a block's column or row, and their bias: 2^23 blocks each way, far past the world's reach (`world/tiles.ts` WORLD_REACH). */
const CELL_DIGITS = 6;
const CELL_BIAS = 2 ** 23;
const PIECE_LENGTH = ID_DIGITS + 1;

const hex = (n: number, digits: number): string => n.toString(16).padStart(digits, '0');

/** A piece's key from what it is (a road, a junction) and its id. */
export function pieceKey(kind: 'segment' | 'node', id: number): PieceKey {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`piece id ${id} is not a safe non-negative integer`);
  return hex(id, ID_DIGITS) + (kind === 'node' ? '1' : '0');
}
/** The piece of a part's key: what it is and its id. */
export function pieceOfPart(key: PartKey): { readonly kind: 'segment' | 'node'; readonly id: number } {
  return { kind: key.charCodeAt(ID_DIGITS) === 49 ? 'node' : 'segment', id: parseInt(key.slice(0, ID_DIGITS), 16) };
}
/** A part's key from its piece and its block's column and row. */
export function partKey(piece: PieceKey, cx: number, cy: number): PartKey {
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || Math.abs(cx) >= CELL_BIAS || Math.abs(cy) >= CELL_BIAS) throw new Error(`block ${cx},${cy} is past a part key's reach`);
  return piece + hex(cx + CELL_BIAS, CELL_DIGITS) + hex(cy + CELL_BIAS, CELL_DIGITS);
}
/** A part's block: its column and row. */
export function cellOfPart(key: PartKey): readonly [number, number] {
  return [
    parseInt(key.slice(PIECE_LENGTH, PIECE_LENGTH + CELL_DIGITS), 16) - CELL_BIAS,
    parseInt(key.slice(PIECE_LENGTH + CELL_DIGITS, PIECE_LENGTH + 2 * CELL_DIGITS), 16) - CELL_BIAS,
  ];
}
/** Parts in key order: by piece id, a road before a junction of the same id, then the block's column and row. */
export const byPart = (p: PartKey, q: PartKey): number => (p < q ? -1 : p > q ? 1 : 0);
/** A block's square from its column and row. */
const cellRect = (cx: number, cy: number): ChangeRect => [cx * CELL, cy * CELL, (cx + 1) * CELL, (cy + 1) * CELL];
/** The block's square of a part. */
export const cellRectOfPart = (key: PartKey): ChangeRect => { const [cx, cy] = cellOfPart(key); return cellRect(cx, cy); };
/** A piece's part: the piece whole, in the block its owner point `at` lies in (`roads/pieceOwner.ts`). */
export const ownedPart = (piece: PieceKey, at: Vec2): PartKey => { const [cx, cy] = ownerCell(at, CELL); return partKey(piece, cx, cy); };

/** How many items had their inputs made, for the scale tests: an edit far away makes few. */
export const surfaceInputWork = { segments: 0, nodes: 0 };

/** Everything a part of a piece is meshed from: its shapes by surface (`roadSurfaceReads.ts` slotOf), in input order. */
export type Reach = ReadonlyMap<string, readonly Input[]>;

/** One input of an item, as a pass files it: its surface (`slot`), its pass, and where a walk of the map meets it - `phase` */
export interface Entry {
  readonly input: Input;
  readonly slot: string;
  readonly phase: number;
  readonly id: number;
  readonly seq: number;
  readonly pass: string;
  /** The part of its piece it is read by (one: the piece whole, in its owner block). */
  readonly tiles: readonly PartKey[];
}

/** The phases of the walk the inputs are ordered by, as `roadSurfaces.ts` once walked the map */
export const PHASE = {
  road: 0, junction: 1,
} as const;

export const byWalk = (p: Entry, q: Entry): number => p.phase - q.phase || p.id - q.id || p.seq - q.seq;

/** A part of one pass: its entries by slot, and what it reads once put together. */
interface TileInputs {
  readonly key: PartKey;
  readonly slots: Map<string, Set<Entry>>;
  /** The pass's entries in it; at none it goes. */
  own: number;
  /** Put together (`reachOf`) and its digest; null when something in it changed since. */
  reach: Reach | null;
  digest: number;
}

/** One pass's parts, by key. */
export interface PassInputs {
  readonly id: string;
  readonly tiles: Map<PartKey, TileInputs>;
  /** The parts the items not derived now may put inputs in (`Superset`), with how many may: the pass has them, made when visited (`wakeTile`). */
  readonly dormant: Map<PartKey, number>;
  /** When it was made (`births`): a pass let go and made again is another pass to the build. */
  readonly born: number;
  /** The parts whose inputs changed (or that went) since the build last took them (`settle`). */
  readonly dirty: Set<PartKey>;
}

/** A pass of the surfaces as the build walks it: a structural level, or an alignment raised by hand. */
export interface SurfacePass {
  readonly id: string;
  readonly structure: RoadStructure;
  readonly segment?: SegmentId;
  readonly chain?: readonly SegmentId[];
}

/** Where an item not derived now may put inputs: its parts in each pass it may draw in. */
export interface Superset {
  readonly passes: readonly string[];
  readonly tiles: readonly PartKey[];
}

export interface SegmentItem {
  readonly pass: string | null;
  readonly ends: readonly [NodeId, NodeId];
  /** Its inputs, filed; null: not derived now (held round the view, `InputResidency`), its `superset` filed instead. */
  readonly entries: readonly Entry[] | null;
  /** The box its inputs lie in, world units; null: it has none. */
  readonly box: ChangeRect | null;
  readonly superset: Superset | null;
  /** What its inputs hold, bytes (`entryBytes`). */
  readonly bytes: number;
}

export interface NodeItem {
  readonly entries: readonly Entry[] | null;
  readonly box: ChangeRect | null;
  readonly superset: Superset | null;
  readonly bytes: number;
}

/** How the inputs are held round the view (`viewCells.ts`): what the cells derived round the parts visited may hold on the CPU, and how far round the eye they are kept. */
export interface InputResidency {
  readonly cpuBudget: number;
  readonly reach: number;
}

/** The game's residency (`renderer.ts`): the cells round the roads' focus kept, where the player edits (a part farther is derived when a build
 *  visits it, `wakeTile`), and room for a build's visit to sweep the map a column of cells at a time without deriving one again. */
export const ROAD_INPUT_RESIDENCY: InputResidency = Object.freeze({ cpuBudget: 48 * 1048576, reach: m(400) });

/** The items a cell of the residency found when it was derived: let go with it unless another held cell meets them. */
export interface CellHold {
  readonly segments: readonly SegmentId[];
  readonly nodes: readonly NodeId[];
}

/** How far past a part's piece its visit derives the items round it (`wakeTile`). */
export const WAKE_PAD = m(24);
/** How far past its roads' boxes and its plates a node's inputs may lie (its paint). */
export const NODE_PAD = m(6);
/** What an entry's input holds besides its numbers, and each number, bytes: an estimate for the budget. */
const ENTRY_BYTES = 460;
const NUMBER_BYTES = 8;
/** Each part an entry is filed in: its place in the part's set. */
const TILE_BYTES = 24;

/** The numbers a shape holds. */
function numbersOf(g: Geom): number {
  switch (g.kind) {
    case 'strip': return g.a.xy.length + g.a.s.length + g.b.xy.length + g.b.s.length;
    case 'fan': case 'poly': return g.ring.length + g.walls.length;
    case 'face': return g.run.xy.length + g.run.s.length + (g.normals?.length ?? 0);
    case 'stations': return g.s.length;
    case 'walls': return g.edges.length;
  }
}

/** What an item's entries hold on the CPU, bytes (an estimate, `ENTRY_BYTES`). */
export function entryBytes(entries: readonly Entry[]): number {
  let n = 0;
  for (const e of entries) n += ENTRY_BYTES + e.tiles.length * TILE_BYTES + numbersOf(e.input.geom) * NUMBER_BYTES;
  return n;
}

export const growRect = (r: ChangeRect, pad: number): ChangeRect => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
export const unite = (a: ChangeRect | null, b: ChangeRect | null): ChangeRect | null =>
  !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

export const alignmentPass = (root: SegmentId): string => `alignment-${root}`;
/** A pass at ground level: the ground's, or an alignment raised by hand (drawn from the ground's structure). */
export const isGroundPass = (pass: string): boolean => pass === 'ground' || pass.startsWith('alignment-');

export function entryOf(input: Input, slot: string, phase: number, id: number, seq: number, pass: string, parts: readonly PartKey[]): Entry {
  return { input, slot, phase, id, seq, pass, tiles: parts };
}
