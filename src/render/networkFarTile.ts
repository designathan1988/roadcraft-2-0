import { controlPoint } from '@core/bezier';
import { RoadDoc, type SerializedDoc, savedNode, savedSegment } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import type { NodeId, SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { laneWidth } from '@world/roadTypes';
import { TILE, tileKey, tileOfKey } from '@world/tiles';
import { METERS_PER_UNIT } from '@world/units';
import { type FarLevel, type FarRoadHeights, PIECE_IDS, type RoadPaintRecord, farCellKey, farRoadInput, naturalGroundOf } from './networkFarInput';
import { buildFarRoadCells } from './networkFarRoadsBuild';
import { roadAlongPaint } from './roadMarks';
import { ownerCell, segmentOwner } from './roads/pieceOwner';

/**
 * THE MAP'S FAR LEVEL MADE TILE BY TILE, OFF THE PAGE (`networkFarTile.worker.ts`, asked by `networkFarRoads.ts` requestWhole): each 1 km tile's
 * roads and junctions at the far level, from a document of the roads its pieces read alone, solved there and triangulated. A piece belongs to
 * the tile its owner block lies in (`roads/pieceOwner.ts`); the ask holds every road whose piece may be owned there (the tile's own, those of
 * its nodes, the neighbours' whose box meets it), every road at their ends (a junction has all its legs) and every structure's chain whole (a
 * bridge's or a ramp's heights are solved along the chain to the ground). DO NOT solve a map's whole network for its far level, on the page or
 * in one job: a 10 km city's opening waited on that one job, and nothing drew its roads past the view (2026-10-26). The tiles go to as many
 * job threads as the machine has, nearest the view first.
 */

/** A tile's far level asked off the page: the records its solve reads, the roads its network holds (`Network.scope`), the tile and the blocks' side. */
export interface FarTileAsk {
  readonly tile: number;
  readonly cell: number;
  readonly data: SerializedDoc;
  readonly scope: readonly SegmentId[];
}

/** A segment's box: its ends and, for a curve, its control point. */
function segmentBox(doc: RoadDoc, id: SegmentId): [number, number, number, number] | null {
  const s = doc.segment(id);
  const a = s && doc.node(s.a), b = s && doc.node(s.b);
  if (!s || !a || !b) return null;
  let minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y), maxX = Math.max(a.x, b.x), maxY = Math.max(a.y, b.y);
  if (s.curve) {
    const c = controlPoint(a, b, s.curve);
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
  }
  return [minX, minY, maxX, maxY];
}

/** What tile `tile`'s far level reads (see the file's comment); null for a tile with no road. Read from the document's tile index, never the map. */
export function farTileAsk(doc: RoadDoc, tile: number, cell: number): FarTileAsk | null {
  const { i, j } = tileOfKey(tile);
  const x0 = i * TILE, y0 = j * TILE, x1 = x0 + TILE, y1 = y0 + TILE;
  const own = doc.tileRoads(tile);
  const roads = new Set<SegmentId>();
  for (const id of own.segments) roads.add(id as SegmentId);
  for (const id of own.nodes) for (const s of doc.node(id as NodeId)?.incident ?? []) roads.add(s);
  // The neighbours' roads reaching into the tile: a piece's owner is its centreline's middle, which may lie here.
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    if (!di && !dj) continue;
    for (const id of doc.tileRoads(tileKey(i + di, j + dj)).segments) {
      const box = segmentBox(doc, id as SegmentId);
      if (box && box[0] <= x1 && box[2] >= x0 && box[1] <= y1 && box[3] >= y0) roads.add(id as SegmentId);
    }
  }
  if (!roads.size) return null;
  // Every structure's chain whole, to the ground at both ends.
  const chain = [...roads].filter((id) => doc.segment(id)?.structure !== 'ground');
  while (chain.length) {
    const seg = doc.segment(chain.pop()!)!;
    for (const node of [seg.a, seg.b]) for (const other of doc.node(node)?.incident ?? []) {
      if (roads.has(other)) continue;
      roads.add(other);
      if (doc.segment(other)?.structure !== 'ground') chain.push(other);
    }
  }
  // Every road at their ends: each node of theirs has all its legs.
  const scope = new Set(roads);
  for (const id of roads) { const seg = doc.segment(id)!; for (const node of [seg.a, seg.b]) for (const other of doc.node(node)?.incident ?? []) scope.add(other); }
  const nodes = new Set<NodeId>();
  for (const id of scope) { const seg = doc.segment(id)!; nodes.add(seg.a); nodes.add(seg.b); }
  return {
    tile, cell,
    data: {
      version: 1, unit: METERS_PER_UNIT,
      nodes: [...nodes].sort((p, q) => p - q).map((id) => savedNode(doc.node(id)!)),
      segments: [...scope].sort((p, q) => p - q).map((id) => savedSegment(doc.segment(id)!)),
      terrain: [], ...doc.worldPart('terrain'), ...doc.worldPart('markingStyle'), poles: [], poleSpans: [],
    },
    // Held with the roads at their ends (`Network.scope`): a junction is built only where every leg is held. A road of that ring is owned by
    // another tile (its box would meet this one were its middle here), its far end no junction here.
    scope: [...scope].sort((p, q) => p - q),
  };
}

/** The blocks of a tile (the far level's cells, `cell` of side). */
function tileCells(tile: number, cell: number): Set<string> {
  const { i, j } = tileOfKey(tile);
  const out = new Set<string>();
  for (let ci = Math.floor((i * TILE) / cell); ci < Math.ceil(((i + 1) * TILE) / cell); ci++) {
    for (let cj = Math.floor((j * TILE) / cell); cj < Math.ceil(((j + 1) * TILE) / cell); cj++) out.add(farCellKey(ci, cj));
  }
  return out;
}

/** @rebuild A tile's far level from its ask (see the file's comment): its blocks' cells triangulated, each carriageway vertex carrying its piece's id (`PIECE_IDS`), and the paint of the roads it owns. */
export function farTileOf(ask: FarTileAsk): { level: FarLevel; transfer: ArrayBuffer[] } {
  const doc = RoadDoc.fromJSON(ask.data, { repair: false });
  const net = new Network(doc);
  net.scope = new Set(ask.scope);
  net.rebuild({ full: true });
  const ground = naturalGroundOf(doc);
  const elevation = buildRoadElevation(net, ground);
  const heights: FarRoadHeights = { onSegment: (s, x, y) => elevation.onSegment(s, x, y), at: (x, y) => elevation.at(x, y) };
  const only = tileCells(ask.tile, ask.cell);
  const { input } = farRoadInput(net, heights, ground, ask.cell, only, PIECE_IDS);
  const cells = buildFarRoadCells(input);
  const paints: RoadPaintRecord[] = [];
  for (const id of [...net.ribbons.keys()].sort((p, q) => p - q)) {
    const at = segmentOwner(net, id);
    if (!at || !only.has(farCellKey(...ownerCell(at, ask.cell)))) continue;
    const ribbon = net.ribbons.get(id)!;
    paints.push({ id, paint: roadAlongPaint(net, ribbon), half: ribbon.road.width / 2, lane: laneWidth(ribbon.road) });
  }
  const transfer: ArrayBuffer[] = [];
  for (const c of cells) transfer.push(c.positions.buffer as ArrayBuffer, c.colors.buffer as ArrayBuffer, c.sections.buffer as ArrayBuffer, c.indices.buffer as ArrayBuffer, c.pieces.buffer as ArrayBuffer);
  return { level: { cell: ask.cell, cells, paints }, transfer };
}

/** The keys of the blocks of a tile, as the far level files its cells (`NetworkFarRoads.replaceCells`). */
export const farTileCellKeys = tileCells;
