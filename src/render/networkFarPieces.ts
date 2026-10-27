import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import type { RoadReads } from '@world/roadField';
import { type RoadStructure, isRaised, roadStructure } from '@world/structures';
import type { Tile } from './mesh/tileMesh';
import { type PassLook, passDesc, passReads } from './roadSurfacePass';
import { passSurfaces, roadCodeOf, type SurfaceRead } from './roadSurfaceReads';
import type { Geom } from './roads/pieceGeom';
import { pieceBundle } from './roads/pieceMesh';
import { nodeOwner, ownerCell, segmentOwner } from './roads/pieceOwner';
import { type FarShape, deckOf, medianShapes, segmentFarShapes } from './roads/segmentPiece';
import { junctionFarShapes } from './roads/junctionPiece';

/**
 * THE NETWORK'S ROOT LEVEL MADE OF THE DETAIL'S OWN PIECES (`networkFarRoads.ts`, `networkFarTile.ts`): each road and junction at the owner's road
 * tool's far level, L2 (`roads/segmentPiece.ts` segmentFarShapes, `roads/junctionPiece.ts` junctionFarShapes: the carriageway and its plate, the
 * kerb and the footway as one band, no kerb face; and a median's own shapes, `medianShapes`), meshed by the detail's own code (`roads/pieceMesh.ts`
 * pieceBundle) AS THE DETAIL'S OWN SURFACES (the carriageway's, the footway's: `roadSurfaceReads.ts` passSurfaces, each vertex's uv, tint and
 * section read as the detail reads them, the kerb stone's top drawn on the footway by its shader), filed by their owner block, every vertex
 * carrying its surface's code: drawn by the road material (`mesh/roadEdges.ts` applyRoadSurface), the road where no block is built the same road
 * its block draws, its texture, its paint, its kerb's top and its median.
 * DO NOT give the root level shapes, attributes or a material of its own: it drew the carriageway alone at its mean colour, no kerb, no
 * median, no texture, and the same street came in three forms at one view as its cells were built or not (the owner's photos, 2026-10-27).
 * Its paint's slots are the pieces' own ids (`lookOf` ids): resolved on the page when a cell lands (`networkFarRoads.ts` resolveFarPieces).
 */

/** One block's surfaces as one mesh's arrays: positions in the scene (x, height, -y), normals, uvs, colours, the section a vertex (`FAR_SECTION`
 *  numbers: across, along, the paint's slot as the piece's id, the surface's code), the triangles. */
export interface FarRoadCell {
  readonly key: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly colors: Float32Array;
  readonly sections: Float32Array;
  readonly indices: Uint32Array;
}

/** Numbers a vertex's section takes (`mesh/surfaceTiles.ts` SECTION_SIZE): across, along, slot, code. */
export const FAR_SECTION = 4;

/** A cell's key on the blocks' grid (`roads/pieceOwner.ts` ownerCell), as the residency and the batches name it. */
export const farCellKey = (i: number, j: number): string => `${i},${j}`;

interface Builder { positions: number[]; normals: number[]; uvs: number[]; colors: number[]; sections: number[]; indices: number[] }

/** A far shape as the detail's surface it stands for (`roadSurfaceReads.ts` slotOf): the carriageway's (1), the footway's band with the kerb's top
 *  on it (0). */
const asSurface = (shape: FarShape): { readonly slot: string; readonly geom: Geom } => ({ slot: shape.layer === 1 ? 'asphalt' : 'footway', geom: shape.geom });

/** The structure a junction's plate is drawn in: its lowest road's that is no tunnel (`roadSurfaceInputs.ts` ownerOf), else its first road's. */
export function plateStructure(net: Network, node: NodeId): RoadStructure | null {
  const record = net.doc.node(node);
  if (!record) return null;
  let lowest = Infinity;
  let owner: RoadStructure | null = null;
  for (const road of record.incident) {
    const structure = net.doc.segment(road)?.structure ?? 'ground';
    if (structure === 'tunnel') continue;
    const clearance = roadStructure(structure).clearance;
    if (clearance < lowest) { lowest = clearance; owner = structure; }
  }
  return owner ?? (record.incident.length ? net.doc.segment(record.incident[0]!)?.structure ?? null : null);
}

/**
 * @rebuild The pieces the network holds, meshed as the detail meshes them (see the file's comment), merged by their owner block. `only`: the cells to
 * make (an edit's, `NetworkFarRoads.refresh`; a tile's, `networkFarTile.ts`); none, every piece. `field`: the solved roads, `terrainAt`: the ground.
 */
export function farPieceCells(net: Network, field: RoadReads, terrainAt: (x: number, y: number) => number, cell: number,
  only: ReadonlySet<string> | null, look: PassLook): FarRoadCell[] {
  const reads = passReads(net, field, terrainAt, true);
  /** Each structure's pass: its surfaces and their codes, made once. */
  const passes = new Map<RoadStructure, { readonly specs: readonly SurfaceRead[]; readonly codes: readonly number[] }>();
  const passOf = (structure: RoadStructure): { readonly specs: readonly SurfaceRead[]; readonly codes: readonly number[] } => {
    let pass = passes.get(structure);
    if (!pass) {
      const raised = isRaised(roadStructure(structure).id);
      const specs = passSurfaces(passDesc(net, { id: structure, structure }, raised, look), reads);
      passes.set(structure, pass = { specs, codes: specs.map((spec) => roadCodeOf(spec.source, raised)) });
    }
    return pass;
  };
  const builders = new Map<string, Builder>();
  const put = (key: string, tile: Tile, code: number): void => {
    let b = builders.get(key);
    if (!b) builders.set(key, b = { positions: [], normals: [], uvs: [], colors: [], sections: [], indices: [] });
    const base = b.positions.length / 3, n = tile.positions.length / 3;
    for (let i = 0; i < tile.positions.length; i++) b.positions.push(tile.positions[i]!);
    for (let i = 0; i < tile.normals.length; i++) b.normals.push(tile.normals[i]!);
    for (let i = 0; i < tile.uvs.length; i++) b.uvs.push(tile.uvs[i]!);
    // A tile with no tint is white, one with no section has none (`mesh/surfaceTiles.ts` tileArrays): what it would have carried.
    for (let v = 0; v < n; v++) {
      if (tile.colors.length) b.colors.push(tile.colors[v * 3]!, tile.colors[v * 3 + 1]!, tile.colors[v * 3 + 2]!); else b.colors.push(1, 1, 1);
      if (tile.sections.length) b.sections.push(tile.sections[v * 3]!, tile.sections[v * 3 + 1]!, tile.sections[v * 3 + 2]!, code);
      else b.sections.push(0, -1, -1, code);
    }
    for (let i = 0; i < tile.indices.length; i++) b.indices.push(tile.indices[i]! + base);
  };
  /** A piece's shapes meshed in its pass, its surfaces into its owner block's arrays. */
  const piece = (key: string, structure: RoadStructure, shapes: readonly { readonly slot: string; readonly geom: Geom }[]): void => {
    const reach = new Map<string, Geom[]>();
    for (const shape of shapes) {
      const list = reach.get(shape.slot);
      if (list) list.push(shape.geom); else reach.set(shape.slot, [shape.geom]);
    }
    const { specs, codes } = passOf(structure);
    const names = new Set(specs.map((spec) => spec.options.name));
    const bundle = pieceBundle(reach, specs, names);
    specs.forEach((spec, k) => {
      const tile = bundle.get(spec.options.name);
      if (tile && tile.indices.length) put(key, tile, codes[k]!);
    });
  };
  const road = (id: SegmentId): void => {
    const ribbon = net.ribbons.get(id), segment = net.doc.segment(id);
    const at = segmentOwner(net, id);
    if (!ribbon || !segment || !at) return;
    piece(farCellKey(...ownerCell(at, cell)), segment.structure, [...segmentFarShapes(net, ribbon, deckOf(net, [id])).map(asSurface), ...medianShapes(net, ribbon)]);
  };
  const junction = (id: NodeId): void => {
    const at = nodeOwner(net, id), structure = plateStructure(net, id);
    const node = net.doc.node(id);
    if (!at || structure === null || !node) return;
    piece(farCellKey(...ownerCell(at, cell)), structure, junctionFarShapes(net, id, deckOf(net, node.incident)).map(asSurface));
  };
  if (only === null) {
    for (const id of [...net.ribbons.keys()].sort((p, q) => p - q)) road(id);
    for (const id of [...net.junctions.keys()].sort((p, q) => p - q)) junction(id);
  } else {
    // The pieces owned by the cells asked: those filed over each cell's square whose owner point lies in it (a piece is drawn whole in its owner's block).
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
    for (const id of [...roads].sort((p, q) => p - q)) road(id);
    for (const id of [...junctions].sort((p, q) => p - q)) junction(id);
  }
  const out: FarRoadCell[] = [];
  for (const [key, b] of builders) {
    out.push({
      key, positions: new Float32Array(b.positions), normals: new Float32Array(b.normals), uvs: new Float32Array(b.uvs), colors: new Float32Array(b.colors),
      sections: new Float32Array(b.sections), indices: new Uint32Array(b.indices),
    });
  }
  return out;
}

/** Every buffer of the cells' arrays, to hand back (MDN, "Transferable objects"). */
export function farCellBuffers(cells: readonly FarRoadCell[]): ArrayBuffer[] {
  return cells.flatMap((c) => [c.positions, c.normals, c.uvs, c.colors, c.sections, c.indices].map((a) => a.buffer as ArrayBuffer));
}
