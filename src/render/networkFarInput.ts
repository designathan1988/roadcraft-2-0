import { Color } from 'three';
import type { Polyline } from '@core/polyline';
import type { RoadDoc } from '@world/doc';
import { FLAT_GROUND } from '@world/elevation';
import type { NodeId, SegmentId } from '@world/ids';
import type { AlongPaint } from '@world/markings';
import type { Network } from '@world/network';
import { ROAD_TYPES } from '@world/roadTypes';
import { ROAD_GROUND_CLEARANCE } from '@world/structures';
import { RELIEF_FLAT, TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import { FAR_CARRIAGEWAY, FAR_FAN, FAR_STRIP, type FarRoadCell, type FarRoadInput } from './networkFarRoadsBuild';
import type { Geom } from './roads/pieceGeom';
import { nodeOwner, ownerCell, segmentOwner } from './roads/pieceOwner';
import { deckOf, segmentFarShapes } from './roads/segmentPiece';
import { junctionFarShapes } from './roads/junctionPiece';
import { ASPHALT_REFERENCE, FOOTWAY_TINT, STREET_MEANS } from './roadTones';

/**
 * THE NETWORK'S FAR LEVEL AS WHAT THE WORKER TRIANGULATES (`networkFarRoadsBuild.ts`), READ OFF A NETWORK, ON THE PAGE OR OFF IT: each road's and
 * junction's far shapes (`roads/segmentPiece.ts` segmentFarShapes, `roads/junctionPiece.ts` junctionFarShapes) at the heights given, filed by
 * their owner block. The map's level is made off the page tile by tile (`networkFarTile.ts`), the page's network holding the tiles near the
 * view alone (`world/networkWindow.ts`); an edit's cells are made again from the page's network (`networkFarRoads.ts` refresh). The paint a
 * carriageway's vertices carry is told by piece (`PieceSlots`): the page's table slots, or off the page the piece's own id, resolved on the
 * page when a tile lands (`networkFarRoads.ts` resolveFarPieces).
 */

/** What the outlines' heights are read from: the opening's solve (`RoadElevation`), the roads it left for later, the ground. */
export interface FarRoadHeights {
  onSegment(segment: SegmentId, x: number, y: number): number;
  at(x: number, y: number): number;
  pendingRoads?(): SegmentId[];
}

/** The paint's slot a piece's vertices carry (`FarRoadInput.slots`): a road's, a plate's `-2 - slot` of its node (`roadPaint.ts`). */
export interface PieceSlots {
  road(id: SegmentId): number;
  node(id: NodeId): number;
}

/** Off the page: each piece's own id as its slot, a plate's `-2 - node` (`networkFarRoads.ts` resolveFarPieces resolves them). */
export const PIECE_IDS: PieceSlots = { road: (id) => id, node: (id) => id };

/** The class's tint over the reference the asphalt texture is authored against (`roadSurfaces.ts` CLASS_TINTS), times the texture's mean. */
const ASPHALT_REFERENCE_COLOUR = new Color(ASPHALT_REFERENCE);
const ASPHALT_BY_CLASS: readonly (readonly [number, number, number])[] = ROAD_TYPES.map((type) => {
  const c = new Color(type.color);
  return [STREET_MEANS.asphalt[0] * (c.r / ASPHALT_REFERENCE_COLOUR.r), STREET_MEANS.asphalt[1] * (c.g / ASPHALT_REFERENCE_COLOUR.g), STREET_MEANS.asphalt[2] * (c.b / ASPHALT_REFERENCE_COLOUR.b)];
});
const CASING: readonly [number, number, number] = [STREET_MEANS.footway[0] * FOOTWAY_TINT.pavers[0], STREET_MEANS.footway[1] * FOOTWAY_TINT.pavers[1], STREET_MEANS.footway[2] * FOOTWAY_TINT.pavers[2]];

/** A cell's key on the blocks' grid (`roads/pieceOwner.ts` ownerCell), as the residency and the batches name it. */
export const farCellKey = (i: number, j: number): string => `${i},${j}`;

/** @rebuild The pieces of the network at the far level, their heights read where the network is (`heights`, `groundAt` for the roads the solve left):
 *  what the worker triangulates. `only`: the cells to make (an edit's, `NetworkFarRoads.refresh`): the pieces whose owner block is one of them and
 *  no other; none, every road the network holds (the whole map, off the page). `slots`: the paint's slot a piece's vertices carry. */
export function farRoadInput(net: Network, heights: FarRoadHeights, groundAt: (x: number, y: number) => number, cell: number,
  only: ReadonlySet<string> | null, slots: PieceSlots): { input: FarRoadInput; transfer: ArrayBuffer[] } {
  const owners: number[] = [], layers: number[] = [], colors: number[] = [], kinds: number[] = [], sizes: number[] = [], points: number[] = [];
  const across: number[] = [], slotOf: number[] = [];
  const pending = new Set(heights.pendingRoads?.() ?? []);
  const hit = { s: 0, distance: 0 };
  /** `line`: the road a strip of its carriageway lies on (its points' offsets across it read off it, as the detail's are, `roadField.ts`), none a
   *  plate's; `slot` the paint's slot its vertices carry (`FarRoadInput.slots`). */
  const add = (i: number, j: number, layer: number, colour: readonly [number, number, number], geom: Geom, height: (x: number, y: number) => number,
    slot: number, line?: Polyline): void => {
    const point = (x: number, y: number, s: number): void => {
      points.push(x, y, height(x, y), s);
      if (!line || layer !== FAR_CARRIAGEWAY) { across.push(0); return; }
      line.closestInto(x, y, hit);
      const f = line.sampleAt(hit.s);
      across.push((x - f.p.x) * f.n.x + (y - f.p.y) * f.n.y);
    };
    if (geom.kind === 'strip') {
      for (const c of [geom.a, geom.b]) for (let k = 0; k < c.s.length; k++) point(c.xy[k * 2]!, c.xy[k * 2 + 1]!, c.s[k]!);
      kinds.push(FAR_STRIP); sizes.push(geom.a.s.length, geom.b.s.length);
    } else if (geom.kind === 'fan') {
      point(geom.cx, geom.cy, 0);
      for (let k = 0; k < geom.ring.length; k += 2) point(geom.ring[k]!, geom.ring[k + 1]!, 0);
      kinds.push(FAR_FAN); sizes.push(geom.ring.length / 2, 0);
    } else return;
    owners.push(i, j);
    layers.push(layer);
    colors.push(colour[0], colour[1], colour[2]);
    slotOf.push(layer === FAR_CARRIAGEWAY ? slot : -1);
  };
  // A road the solve left lies where a solved one would on its ground: its clearance over it (`roadField.ts` onSegment), not in the ground's own plane.
  const onGround = (x: number, y: number): number => groundAt(x, y) + ROAD_GROUND_CLEARANCE;
  const roadAt = (x: number, y: number): number => { const h = heights.at(x, y); return Number.isFinite(h) ? h : onGround(x, y); };
  const road = (id: SegmentId, i: number, j: number): void => {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) return;
    const height = pending.has(id) ? onGround : (x: number, y: number): number => heights.onSegment(id, x, y);
    const asphalt = ASPHALT_BY_CLASS[ribbon.typeIndex] ?? STREET_MEANS.asphalt;
    // Its lines along it in the paint's table, as its detail writes them (`roadSurfacePass.ts` lookOf).
    const slot = slots.road(id);
    for (const shape of segmentFarShapes(net, ribbon, deckOf(net, [id]))) add(i, j, shape.layer, shape.layer === 1 ? asphalt : CASING, shape.geom, height, slot, ribbon.full);
  };
  const junction = (id: NodeId, i: number, j: number): void => {
    const node = net.doc.node(id);
    if (!node) return;
    // A junction every road of which the solve left: on the ground, as they are.
    const height = node.incident.length > 0 && node.incident.every((s) => pending.has(s)) ? onGround : roadAt;
    const types = node.incident.map((s) => net.ribbons.get(s)?.typeIndex ?? -1).filter((t) => t >= 0);
    const asphalt = ASPHALT_BY_CLASS[types.length ? Math.max(...types) : 0] ?? STREET_MEANS.asphalt;
    // Its plate's marks: its node's slot as `-2 - slot` (`roadSurfaceReads.ts` asphaltPlate).
    const slot = -2 - slots.node(id);
    for (const shape of junctionFarShapes(net, id, deckOf(net, node.incident))) add(i, j, shape.layer, shape.layer === 1 ? asphalt : CASING, shape.geom, height, slot);
  };
  if (only === null) {
    for (const id of net.ribbons.keys()) {
      const at = segmentOwner(net, id);
      if (!at) continue;
      const [i, j] = ownerCell(at, cell);
      road(id, i, j);
    }
    for (const id of net.junctions.keys()) {
      const at = nodeOwner(net, id);
      if (!at) continue;
      const [i, j] = ownerCell(at, cell);
      junction(id, i, j);
    }
  } else {
    // The pieces owned by the cells asked: those filed over each cell's square whose owner point lies in it (a piece is drawn whole in its owner's block, whatever it reaches into).
    const roads = new Set<SegmentId>(), junctions = new Set<NodeId>();
    for (const key of only) {
      const [i, j] = key.split(',').map(Number) as [number, number];
      const rect: [number, number, number, number] = [i * cell, j * cell, (i + 1) * cell, (j + 1) * cell];
      for (const id of net.segmentCells.idsMeeting(rect)) {
        const at = segmentOwner(net, id);
        if (at && farCellKey(...ownerCell(at, cell)) === key) roads.add(id);
      }
      for (const id of net.junctionCells.idsMeeting(rect)) {
        const at = nodeOwner(net, id);
        if (at && farCellKey(...ownerCell(at, cell)) === key) junctions.add(id);
      }
    }
    for (const id of [...roads].sort((p, q) => p - q)) { const [i, j] = ownerCell(segmentOwner(net, id)!, cell); road(id, i, j); }
    for (const id of [...junctions].sort((p, q) => p - q)) { const [i, j] = ownerCell(nodeOwner(net, id)!, cell); junction(id, i, j); }
  }
  const input: FarRoadInput = {
    cell, owners: new Int32Array(owners), layers: new Uint8Array(layers), colors: new Float32Array(colors),
    kinds: new Uint8Array(kinds), sizes: new Uint32Array(sizes), points: new Float64Array(points), across: new Float32Array(across), slots: new Float64Array(slotOf),
  };
  return {
    input,
    transfer: [input.owners, input.layers, input.colors, input.kinds, input.sizes, input.points, input.across, input.slots].map((a) => a.buffer as ArrayBuffer),
  };
}

/** A road's paint as the carriageway's shader reads it (`roadPaint.ts` set): its lines along it, its half width and its lane width; made off the page for every road of the map, written on the page when the level lands. */
export interface RoadPaintRecord {
  readonly id: SegmentId;
  readonly paint: AlongPaint | null;
  readonly half: number;
  readonly lane: number;
}

/** A TILE'S FAR LEVEL (`networkFarTile.ts`): its cells triangulated, each carriageway vertex carrying its piece's id (`PIECE_IDS`), and the paint of every road it owns. */
export interface FarLevel {
  readonly cell: number;
  readonly cells: readonly FarRoadCell[];
  readonly paints: readonly RoadPaintRecord[];
}

/** Whether a map's land is level: a new map's flat relief with no stamp (every station's ground the same, `FLAT_GROUND`). */
export const isLevelLand = (doc: RoadDoc): boolean => doc.terrainRelief === RELIEF_FLAT && doc.terrainStamps.length === 0;

/** The ground a network's solve reads off the page: level, or the land's stamps on their relief (`world/terrain.ts`). */
export function naturalGroundOf(doc: RoadDoc): (x: number, y: number) => number {
  if (isLevelLand(doc)) return FLAT_GROUND;
  // The index's revision is its caller's bookkeeping (`world/terrain.ts`): none here, the index read once.
  const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
  return (x, y) => sampleTerrainHeight(index, x, y);
}
