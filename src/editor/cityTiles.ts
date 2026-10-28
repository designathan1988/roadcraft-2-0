import { controlPoint } from '@core/bezier';
import { SharedMembers } from '@world/buildings/intern';
import { buildingBounds } from '@world/buildings/geometry';
import { RecordTable, TableWriter, encodeRecords, tableRecords } from '@world/buildings/recordTable';
import { buildingSummaryColumns } from '@world/buildings/summary';
import type { Building, BuildingId } from '@world/buildings/types';
import { type RoadDoc as RoadDocType, RoadDoc, type SerializedDoc, savedNode, savedSegment } from '@world/doc';
import type { NodeId } from '@world/ids';
import { type Lot, lotBounds, lotCentre } from '@world/lots';
import { lotSummaryColumns } from '@world/lotSummary';
import { Network } from '@world/network';
import { LIKE_REACH } from '@world/growth/zoning';
import { OWNER, TILE, tileKey, tileOfKey } from '@world/tiles';
import { METERS_PER_UNIT, m } from '@world/units';
import { PreparedCityWriter } from './preparedCity';
import { growLots } from './smallCityMap';

/**
 * A CITY'S BUILDINGS GROWN TILE BY TILE, MANY TILES AT ONCE (the job workers, `cityGrowth.worker.ts`, `cityInTiles.ts`), NEVER ONE BY ONE
 * ON ONE THREAD: the city laid out first (`smallCityMap.ts` layoutCityOf: streets, lots, green, zones), then each 1 km tile's lots grown
 * by the game's own growth (`growLots`: `growOnLot`, every building made to measure, checked against its neighbours, its roads and its
 * slope), each tile on a document of its own holding its lots, the roads within `ROAD_MARGIN` of it and the buildings already grown on
 * the tiles round it within `EDGE_REACH` of its border (what a building reads: its lot and `growthReachOf`'s margin, the looks round it
 * within `LIKE_REACH`). Tiles of one phase (a 2 x 2 checkerboard, `phaseOf`) are a tile apart at least, so they never read each other and
 * grow at the same time; each later phase reads the earlier phases' buildings at its border, so no building stands on another (the
 * chunk-generation pyramid of a game world: a step that reads its neighbours waits for them, LayerProcGen, https://github.com/runevision/LayerProcGen).
 * Each tile's buildings take ids of its own range (`TILE_IDS`), its own stream with them (`lotStream`): the same city whatever order the
 * tiles run in. The tiles' tables joined into the city's without decoding a record (`assembleCity`, `TableWriter.copyRows`).
 */

/** How far past a tile's square its roads are taken: every road a lot of it is checked against (`growthReachOf`, 16 m and a projection), with every leg of each junction near it. */
const ROAD_MARGIN = m(150);
/** How far inside a tile's border its buildings are read by the tiles round it: the looks round a lot (`LIKE_REACH`) and a lot's checks. */
const EDGE_REACH = LIKE_REACH + m(20);
/** Ids a tile's buildings take: tile `ordinal`'s from `1 + ordinal * TILE_IDS`. A dense tile grows a few thousand. */
const TILE_IDS = 1 << 16;
/** Records held as objects while a tile grows, past which the older go to its table (`SpilledItems.spill`), as the city's growth does. */
const SPILL_AT = 4096;
const SPILL_KEEP = 1024;

/** What a tile's growth reads: its lots to grow, the roads round it, as a file holds them. */
export interface TileGrowth {
  readonly key: number;
  /** Its place among the city's tiles with lots, in key order: its ids' range. */
  readonly ordinal: number;
  /** 0 to 3: the tiles of a phase grow together (`phaseOf`). */
  readonly phase: number;
  readonly nodes: SerializedDoc['nodes'];
  readonly segments: SerializedDoc['segments'];
  readonly lots: readonly Lot[];
  readonly markingStyle: string;
}

/** A tile grown: its buildings' table (as the page's, `PreparedCityWriter`), each lot and the building it took, and the buildings within `EDGE_REACH` of its border for the tiles round it. */
export interface TileGrown {
  readonly key: number;
  readonly buildings: ArrayBufferLike;
  /** Lot id, building id, in turn. */
  readonly lotBuildings: Float64Array;
  /** The buildings near its border as a table of their own, each row's box in its columns (`encodeRecords`): DO NOT hand them back as objects - some 40% of a city's buildings stand within `EDGE_REACH` of a tile's border, ~20 KB of the page's heap each until the city is joined. */
  readonly edge: ArrayBufferLike;
}

/** A tile's phase: its column's and row's parity, a 2 x 2 checkerboard (two tiles of one phase are a tile apart at least). */
const phaseOf = (key: number): number => {
  const { i, j } = tileOfKey(key);
  return (i & 1) + 2 * (j & 1);
};

/** Whether two tiles touch (sides or corners): a tile reads the edge buildings of those grown before it. */
export const tilesTouch = (a: number, b: number): boolean => {
  const p = tileOfKey(a), q = tileOfKey(b);
  return a !== b && Math.abs(p.i - q.i) <= 1 && Math.abs(p.j - q.j) <= 1;
};

/** @rebuild The city laid out (`layoutCityOf`) cut into what each tile with lots to grow reads: one pass over its lots and one over its roads. */
export function tilePackagesOf(doc: RoadDocType): TileGrowth[] {
  const lotsOf = new Map<number, Lot[]>();
  for (const lot of doc.lotStore.all()) {
    if (!lot.use || lot.building !== undefined) continue;
    const key = OWNER.at(lotCentre(lot));
    const list = lotsOf.get(key);
    if (list) list.push(lot); else lotsOf.set(key, [lot]);
  }
  const keys = [...lotsOf.keys()].sort((a, b) => a - b);
  const wanted = new Set(keys);
  const roadsOf = new Map<number, number[]>();
  for (const segment of doc.segments.values()) {
    const a = doc.node(segment.a), b = doc.node(segment.b);
    if (!a || !b) continue;
    let minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y), maxX = Math.max(a.x, b.x), maxY = Math.max(a.y, b.y);
    if (segment.curve) {
      const c = controlPoint(a, b, segment.curve);
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
    }
    for (let i = Math.floor((minX - ROAD_MARGIN) / TILE); i <= Math.floor((maxX + ROAD_MARGIN) / TILE); i++) {
      for (let j = Math.floor((minY - ROAD_MARGIN) / TILE); j <= Math.floor((maxY + ROAD_MARGIN) / TILE); j++) {
        const key = tileKey(i, j);
        if (!wanted.has(key)) continue;
        const list = roadsOf.get(key);
        if (list) list.push(segment.id); else roadsOf.set(key, [segment.id]);
      }
    }
  }
  return keys.map((key, ordinal) => {
    const ids = (roadsOf.get(key) ?? []).sort((p, q) => p - q);
    const nodes = new Set<NodeId>();
    for (const id of ids) { const s = doc.segment(id as never)!; nodes.add(s.a); nodes.add(s.b); }
    return {
      key, ordinal, phase: phaseOf(key),
      nodes: [...nodes].sort((p, q) => p - q).map((id) => savedNode(doc.node(id)!)),
      segments: ids.map((id) => savedSegment(doc.segment(id as never)!)),
      lots: lotsOf.get(key)!,
      markingStyle: doc.markingStyle,
    };
  });
}

/** Whether a building's box comes within `EDGE_REACH` of tile `key`'s border (read by the tiles round it). */
function nearBorder(b: Building, key: number): boolean {
  const { i, j } = tileOfKey(key);
  const box = buildingBounds(b);
  return box.minX < i * TILE + EDGE_REACH || box.maxX > (i + 1) * TILE - EDGE_REACH || box.minY < j * TILE + EDGE_REACH || box.maxY > (j + 1) * TILE - EDGE_REACH;
}

/** The buildings of the edge tables (`TileGrown.edge`) whose box comes within `EDGE_REACH` of tile `key`'s square, decoded: the rows of the tables' other borders passed over by their box columns. */
function edgeBuildingsNear(key: number, tables: readonly ArrayBufferLike[]): Building[] {
  const { i, j } = tileOfKey(key);
  const minX = i * TILE - EDGE_REACH, minY = j * TILE - EDGE_REACH, maxX = (i + 1) * TILE + EDGE_REACH, maxY = (j + 1) * TILE + EDGE_REACH;
  const out: Building[] = [];
  for (const buffer of tables) {
    const table = new RecordTable(buffer);
    const boxes = table.boxes!;
    const reader = table.reader<Building>();
    for (let row = 0; row < table.rows; row++) {
      if (boxes.minX[row]! > maxX || boxes.maxX[row]! < minX || boxes.minY[row]! > maxY || boxes.maxY[row]! < minY) continue;
      out.push(reader.record(row));
    }
  }
  return out;
}

/** One tile's lots grown (see the file's comment): `neighbours`, the edge tables of the tiles round it grown in earlier phases. */
export function growTile(tile: TileGrowth, neighbourTables: readonly ArrayBufferLike[]): TileGrown {
  const neighbours = edgeBuildingsNear(tile.key, neighbourTables);
  const doc = RoadDoc.fromJSON({
    version: 1, unit: METERS_PER_UNIT, nodes: tile.nodes, segments: tile.segments, terrain: [], poles: [], poleSpans: [],
    lots: tile.lots, markingStyle: tile.markingStyle,
  }, { repair: false });
  // As the city's growth (`buildCityTable`): its records interned where they are read, the older spilled to the tile's table as they grow.
  doc.buildings.internShared = false;
  const shared = new SharedMembers();
  const page = new PreparedCityWriter(shared);
  const items = doc.buildings.spillToTable(shared);
  // The neighbours read, never written out: their ids are other tiles'.
  doc.buildings.placeAll(neighbours);
  const theirs = new Set<number>(neighbours.map((b) => b.id));
  const first = 1 + tile.ordinal * TILE_IDS;
  doc.buildings.restoreNextId(first);
  const net = new Network(doc);
  net.rebuild();
  const edge: Building[] = [];
  const spill = (keep: number): void => {
    page.add(items.spill(keep).filter((b) => !theirs.has(b.id)));
    shared.end();
    items.endBatch();
    page.endBatch();
  };
  growLots(doc, net, (id: BuildingId) => {
    if (id >= first + TILE_IDS) throw new Error(`[city] tile ${tile.key} grew past its ${TILE_IDS} ids`);
    const b = doc.buildings.get(id)!;
    if (nearBorder(b, tile.key)) edge.push(b);
    if (items.heldCount >= SPILL_AT) spill(SPILL_KEEP);
  });
  spill(0);
  const pairs: number[] = [];
  for (const lot of doc.lotStore.all()) if (lot.building !== undefined && !theirs.has(lot.building)) pairs.push(lot.id, lot.building);
  return { key: tile.key, buildings: page.finish(), lotBuildings: Float64Array.from(pairs), edge: encodeRecords(edge, null, buildingBounds).buffer };
}

/** The city's buildings' table joined from its tiles' (their rows copied, no record decoded), and its lots' table with each grown lot naming its building. */
export function assembleCity(layoutLots: ArrayBufferLike | null, grown: readonly TileGrown[]): { readonly buildings: ArrayBufferLike; readonly lots: ArrayBufferLike | null } {
  const writer = new TableWriter<Building>(true, null, (b) => buildingBounds(b), buildingSummaryColumns());
  const building = new Map<number, number>();
  for (const tile of [...grown].sort((a, b) => a.key - b.key)) {
    const table = new RecordTable(tile.buildings);
    writer.copyRows(table, Array.from({ length: table.rows }, (_, row) => row));
    for (let k = 0; k + 1 < tile.lotBuildings.length; k += 2) building.set(tile.lotBuildings[k]!, tile.lotBuildings[k + 1]!);
  }
  const lots = layoutLots ? tableRecords<Lot>(layoutLots).map((lot) => (building.has(lot.id) ? { ...lot, building: building.get(lot.id)! } : lot)) : [];
  return { buildings: writer.finish().buffer, lots: lots.length ? encodeRecords(lots, lotCentre, lotBounds, lotSummaryColumns()).buffer : null };
}
