import type { Building, BuildingId } from '@world/buildings/types';
import { storedBounds } from '@world/buildings/geometry';
import type { RecordRef, RowBox, RowPlace } from '@world/buildings/recordTable';
import type { ChangeKind, ChangeRect } from '@world/changes';
import { CELL } from '@world/cells';
import { TILE } from '@world/tiles';
import type { Lot } from '@world/lotRecord';
import { lotBounds, lotCentre } from '@world/lotRings';
import type { UtilityPole, UtilitySpan } from '@world/utilities';
import type { LandscapeItem } from '@world/landscape';
import type { Barrier } from '@world/barriers';
import type { DocTable } from '@world/docBinary';
import {
  type GlobalPart, type RoadDoc, type RoadNode, type RoadSegment,
  savedBarrier, savedLandscape, savedNode, savedPole, savedSegment, savedSpan, spanPlace,
} from '@world/doc';

/** THE LAYERS OF THE MAP SAVED BY SQUARES (`chunkedSave.ts`): each keyed kind of record (where a record stands, how its square's table is cut from the map's, its form in the file), each ordered list, the parts kept outside the squares, and the squares themselves. */

/** The side of the squares the map is saved by: the world's tile (CLAUDE.md, "One grid"; `world/tiles.ts` TILE, 1,000 m). */
export const SAVE_TILE = TILE;
/** Buildings and lots by the world's cell: a dense tile holds thousands of buildings of ~7 KB, one edit would write megabytes. */
const DENSE_SQUARE = CELL;

/** The keyed layers (records with ids, any order) and the ordered lists (the order is meaning: stamps and dabs are laid in turn). */
export type KeyedName = 'nodes' | 'segments' | 'poles' | 'spans' | 'landscape' | 'barriers' | 'buildings' | 'lots';
export type ListName = 'stamps' | 'paint' | 'fog' | 'gullies' | 'clouds' | 'trees' | 'clearings' | 'elements' | 'zones' | 'zoneMarks';
export type LayerName = KeyedName | ListName;
export const KEYED_NAMES: readonly KeyedName[] = ['nodes', 'segments', 'poles', 'spans', 'landscape', 'barriers', 'buildings', 'lots'];
export const LIST_NAMES: readonly ListName[] = ['stamps', 'paint', 'fog', 'gullies', 'clouds', 'trees', 'clearings', 'elements', 'zones', 'zoneMarks'];
export const LAYER_NAMES: readonly LayerName[] = [...KEYED_NAMES, ...LIST_NAMES];

interface Place { readonly x: number; readonly y: number }
interface Keyed { readonly id: number }

/** A keyed layer: its records by id, the point that files each one (one square per record, so it is stored once) and its form in the file. */
interface KeyedSpec<T extends Keyed = Keyed> {
  readonly side: number;
  readonly kinds: readonly ChangeKind[];
  /** The layer's records by id: a `TableItems` for a kind kept in a table (its ids and places read from the columns, no record decoded). */
  items(doc: RoadDoc): ReadonlyMap<number, T>;
  /** Where a record stands, nothing decoded for one of a table; undefined: nowhere (a road whose end is gone), the square at the origin. */
  placeOf(doc: RoadDoc, id: number): Place | undefined;
  /** A record written on the page, as the file holds it. */
  saved(record: T): unknown;
  /** The record's place in its store's order, where the order means something (the lots: the first one holds a point). */
  order?(doc: RoadDoc, id: number): number;
  /** A kind kept in a table (`DOC_TABLES`): its squares are record tables, their rows copied from the map's. `table`: the kind's name there. */
  readonly table: DocTable | null;
  /** Where a record of the table is read without decoding (its table's buffer and row); null for one written on the page. */
  ref?(doc: RoadDoc, id: number): RecordRef | null;
  /** The place columns of a record written on the page, for its square's table (a lot's centre, a wire's poles). */
  readonly columns?: RowPlace<T>;
  /** The box columns of a record written on the page, for its square's table (a building's box, `storedBounds`): the map files it by place from them when opened. */
  readonly box?: RowBox<T>;
}
const keyed = <T extends Keyed>(spec: KeyedSpec<T>): KeyedSpec => spec as unknown as KeyedSpec;
const nodeOf = (doc: RoadDoc, id: number): RoadNode | undefined => (doc.nodes as ReadonlyMap<number, RoadNode>).get(id);

/** DO NOT file a road in every tile it crosses: a road is filed by its end `a`, a span by its pole `a`, a barrier by its first point, a lot by its centre. */
export const KEYED: Readonly<Record<KeyedName, KeyedSpec>> = {
  nodes: keyed<RoadNode>({
    side: SAVE_TILE, kinds: ['roads', 'traffic'], table: null, items: (doc) => doc.nodes as ReadonlyMap<number, RoadNode>, placeOf: nodeOf, saved: savedNode,
  }),
  segments: keyed<RoadSegment>({
    side: SAVE_TILE, kinds: ['roads', 'traffic'], table: null, items: (doc) => doc.segments as ReadonlyMap<number, RoadSegment>,
    placeOf: (doc, id) => { const s = (doc.segments as ReadonlyMap<number, RoadSegment>).get(id); return s && nodeOf(doc, s.a); }, saved: savedSegment,
  }),
  poles: keyed<UtilityPole>({
    side: SAVE_TILE, kinds: ['utilities'], table: 'poles', items: (doc) => doc.poles as ReadonlyMap<number, UtilityPole>,
    placeOf: (doc, id) => doc.recordPlace('poles', id), saved: savedPole, ref: (doc, id) => doc.recordRef('poles', id),
  }),
  spans: keyed<UtilitySpan>({
    side: SAVE_TILE, kinds: ['utilities'], table: 'spans', items: (doc) => doc.poleSpans as ReadonlyMap<number, UtilitySpan>,
    placeOf: (doc, id) => doc.recordPlace('spans', id), saved: savedSpan, ref: (doc, id) => doc.recordRef('spans', id), columns: spanPlace,
  }),
  landscape: keyed<LandscapeItem>({
    side: SAVE_TILE, kinds: ['landscape'], table: 'landscape', items: (doc) => doc.landscape,
    placeOf: (doc, id) => doc.recordPlace('landscape', id), saved: savedLandscape, ref: (doc, id) => doc.recordRef('landscape', id),
  }),
  barriers: keyed<Barrier>({
    side: SAVE_TILE, kinds: ['barriers'], table: null, items: (doc) => doc.barriers, placeOf: (doc, id) => doc.barriers.get(id)?.points[0], saved: savedBarrier,
  }),
  // `JSON.stringify` of a record is the text of its copy (`cloneBuilding` is a JSON round trip): the record itself is handed on.
  buildings: keyed<Building>({
    side: DENSE_SQUARE, kinds: ['buildings'], table: 'buildings', items: (doc) => doc.buildings.itemsOf(),
    placeOf: (doc, id) => doc.buildings.placeOf(id as BuildingId), saved: (b) => b, ref: (doc, id) => doc.buildings.tableRef(id as BuildingId),
    box: (b) => storedBounds(b),
  }),
  lots: keyed<Lot>({
    side: DENSE_SQUARE, kinds: ['lots'], table: 'lots', items: (doc) => doc.lotStore.itemsOf(), placeOf: (doc, id) => doc.lotStore.placeOf(id),
    saved: (lot) => lot, order: (doc, id) => doc.lotStore.orderOf(id) ?? 0, ref: (doc, id) => doc.lotStore.tableRef(id), columns: lotCentre, box: lotBounds,
  }),
};

/** An ordered list: its items and the point that files each one. */
interface ListSpec<T extends object = object> {
  readonly side: number;
  readonly kinds: readonly ChangeKind[];
  list(doc: RoadDoc): readonly T[];
  at(item: T): Place;
}
const listed = <T extends object>(spec: ListSpec<T>): ListSpec => spec as unknown as ListSpec;
const itself = (item: Place): Place => item;
export const LISTS: Readonly<Record<ListName, ListSpec>> = {
  stamps: listed<Place>({ side: SAVE_TILE, kinds: ['terrain'], list: (doc) => doc.terrainStamps, at: itself }),
  paint: listed<Place>({ side: SAVE_TILE, kinds: ['paint'], list: (doc) => doc.terrainPaint, at: itself }),
  fog: listed<Place>({ side: SAVE_TILE, kinds: ['fog'], list: (doc) => doc.fogDabs, at: itself }),
  gullies: listed<Place>({ side: SAVE_TILE, kinds: ['gullies'], list: (doc) => doc.gullyDabs, at: itself }),
  clouds: listed<Place>({ side: SAVE_TILE, kinds: ['clouds'], list: (doc) => doc.clouds, at: itself }),
  trees: listed<Place>({ side: SAVE_TILE, kinds: ['trees'], list: (doc) => doc.trees, at: itself }),
  clearings: listed<Place>({ side: SAVE_TILE, kinds: ['clearings'], list: (doc) => doc.treeClearings, at: itself }),
  elements: listed<Place>({ side: SAVE_TILE, kinds: ['elements'], list: (doc) => doc.elements, at: itself }),
  zones: listed<{ readonly x0: number; readonly y0: number }>({ side: SAVE_TILE, kinds: ['zones'], list: (doc) => doc.zones, at: (z) => ({ x: z.x0, y: z.y0 }) }),
  zoneMarks: listed<Place>({ side: SAVE_TILE, kinds: ['zones'], list: (doc) => doc.zoneMarks, at: itself }),
};

/** The kinds each part kept outside the tiles is written again for. */
export const GLOBAL_KINDS: Readonly<Record<GlobalPart, readonly ChangeKind[]>> = {
  values: ['terrain', 'fog', 'gullies', 'nature', 'weather', 'economy', 'markingStyle'],
  lotKeys: ['lotKeys'],
  people: ['people'],
  transit: ['transit'],
};

/** A record with no place (a road whose end is gone) is filed in the square at the origin. */
const NOWHERE = '0,0';
export const squareAt = (at: Place | undefined, side: number): string => (at && Number.isFinite(at.x) && Number.isFinite(at.y) ? `${Math.floor(at.x / side)},${Math.floor(at.y / side)}` : NOWHERE);
export function squareRect(square: string, side: number): ChangeRect {
  const comma = square.indexOf(',');
  const cx = Number(square.slice(0, comma)), cy = Number(square.slice(comma + 1));
  return [cx * side, cy * side, (cx + 1) * side, (cy + 1) * side];
}
export const meets = (a: ChangeRect, b: ChangeRect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Which of a keyed layer's squares are stored, and which are not the map's any more. No record's square: found from the places when a square is written (`membersOf`). */
export class KeyedState {
  /** The squares with a blob stored. */
  stored = new Set<string>();
  /** The squares whose blob is not the map's: written by the next save. */
  dirty = new Set<string>();
  /** The buildings' squares whose wears alone changed. */
  wear = new Set<string>();

  /** The stored squares a change reaches (null: all of them) made dirty. */
  dirtyStored(rects: readonly ChangeRect[] | null, side: number): void {
    for (const square of this.stored) if (rects === null || rects.some((r) => meets(r, squareRect(square, side)))) this.dirty.add(square);
  }
}

/** An ordered list's items by reference: each one's place in the order (a fraction between its neighbours') and its square. */
export class ListState {
  ords = new WeakMap<object, number>();
  square = new WeakMap<object, string>();
  counts = new Map<string, number>();
  stored = new Set<string>();
  dirty = new Set<string>();
  /** The diary wrote the list's kind since the last look, and where (null: anywhere). */
  changed = false;
  rects: ChangeRect[] | null = [];
}

export const freshKeyed = (): Record<KeyedName, KeyedState> =>
  Object.fromEntries(KEYED_NAMES.map((name) => [name, new KeyedState()])) as Record<KeyedName, KeyedState>;
export const freshLists = (): Record<ListName, ListState> =>
  Object.fromEntries(LIST_NAMES.map((name) => [name, new ListState()])) as Record<ListName, ListState>;

/** DO NOT number the items by their index: one item taken from the front would renumber, and write, every tile of the list */
export function placeInOrder(list: readonly object[], ords: WeakMap<object, number>): Set<object> | 'all' {
  const fresh = new Set<object>();
  let last = -Infinity;
  let i = 0;
  while (i < list.length) {
    const own = ords.get(list[i]!);
    if (own !== undefined && own > last) { last = own; i++; continue; }
    // A run of items with no place (new, or out of order) up to the next one whose place still holds.
    let j = i + 1;
    while (j < list.length) {
      const next = ords.get(list[j]!);
      if (next !== undefined && next > last) break;
      j++;
    }
    const count = j - i;
    const bound = j < list.length ? ords.get(list[j]!)! : undefined;
    const lo = last !== -Infinity ? last : bound !== undefined ? bound - count - 1 : 0;
    const hi = bound ?? lo + count + 1;
    const step = (hi - lo) / (count + 1);
    for (let k = 0; k < count; k++) {
      const value = lo + step * (k + 1);
      // No room left between two neighbours in a double: the whole list numbered again (every one of its tiles written).
      if (!(value > last) || !(value < hi)) { list.forEach((item, at) => ords.set(item, at + 1)); return 'all'; }
      ords.set(list[i + k]!, value);
      fresh.add(list[i + k]!);
      last = value;
    }
    i = j;
  }
  return fresh;
}

