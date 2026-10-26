import { beforeAll, describe, expect, it } from 'vitest';
import { MeshoptSimplifier } from 'meshoptimizer';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { Level, ROAD_TYPES } from '@world/roadTypes';
import type { NodeId } from '@world/ids';
import type { RoadSection } from '@world/roadSection';
import { type MeshedSurface, pieceBundle } from '@render/roads/pieceMesh';
import { segmentShapes } from '@render/roads/segmentPiece';
import { junctionShapes } from '@render/roads/junctionPiece';
import { passDesc, passReads } from '@render/roadSurfacePass';
import { passSurfaces } from '@render/roadSurfaceReads';
import type { SurfacePass } from '@render/roadSurfaceEntries';

/** THE LARGE CITY'S T OF TWO 18 M ROADS AND A LOCAL STREET (`roads/junctionPiece.ts`, `roadSurfaceReads.ts`): every corner paved, every carriageway
 *  vertex carrying its road's paint. */

beforeAll(async () => { await MeshoptSimplifier.ready; });

/** The large city's sections (`world/cityGen`): an 18 m road of two 4 m lanes a way round a 2 m median, a 6 m local street, a 3 m footway each. */
const WIDE: RoadSection = { laneWidth: 4, sidewalk: 3, median: 2, speedKmh: 50, priority: 2 };
const LOCAL: RoadSection = { laneWidth: 3, sidewalk: 3, median: 0, speedKmh: 30, priority: 0 };

/** The T: a boulevard through the node (east and west), a local street off it (south). */
function tee(): { net: Network; specs: MeshedSurface[]; reads: ReturnType<typeof passReads> } {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: 0, y: 0 });
  const boulevard = ROAD_TYPES.findIndex((t) => t.id === 'boulevard'), local = ROAD_TYPES.findIndex((t) => t.id === 'local');
  doc.addSegment(doc.addNode({ x: -120, y: 0 }).id, centre.id, boulevard, null, 0, 'both', null, 'ground', WIDE);
  doc.addSegment(centre.id, doc.addNode({ x: 120, y: 0 }).id, boulevard, null, 0, 'both', null, 'ground', WIDE);
  doc.addSegment(centre.id, doc.addNode({ x: 0, y: -120 }).id, local, null, 0, 'both', null, 'ground', LOCAL);
  const net = new Network(doc);
  net.rebuild();
  const reads = passReads(net, buildRoadElevation(net, () => 0), () => 0);
  const pass: SurfacePass = { id: 'ground', structure: 'ground' };
  const look = { scale: { asphalt: 4, footway: 2, kerb: 1, verge: 4, deck: 4 }, classTint: [], referenceTint: [1, 1, 1] as const, pavingTint: {} };
  return { net, specs: passSurfaces(passDesc(net, pass, false, look), reads), reads };
}

describe('the T of two 18 m roads and a local street', () => {
  it('paves each corner a kerb returns round, its back closed on one point where the return is as tight as the footway is wide', () => {
    const { net, specs } = tee();
    const node = [...net.junctions.keys()][0]! as NodeId;
    const shapes = junctionShapes(net, node);
    // The returns into the local street as tight as its footway is wide: 3 m (the city's own, its back a point).
    for (const j of net.junctions.get(node)!.values()) for (const c of j.corners) if (c.fillet && j.level === Level.Asphalt) expect(c.fillet.r).toBeCloseTo(3, 6);
    const faces = shapes.filter((s) => s.slot === 'kerb').length, footways = shapes.filter((s) => s.slot === 'footway');
    // Three corners: the straight side and the two returns into the local street, each with its kerb's face and its footway.
    expect(faces).toBe(3);
    expect(footways).toHaveLength(3);
    const spec = specs.find((s) => s.source.kind === 'band' && s.source.band === 'footway')!;
    for (const { geom } of footways) {
      const tile = pieceBundle(new Map([['footway', [geom]]]), [spec]).get(spec.options.name)!;
      expect(tile.indices.length / 3).toBeGreaterThan(0);
      // At the footway's height, as its roads' footways (no hole down to the terrain).
      for (let i = 1; i < tile.positions.length; i += 3) expect(tile.positions[i]).toBeCloseTo(0.27, 6);
    }
  });

  it('gives every vertex of a road\'s carriageway its road\'s paint, past its mouth too', () => {
    const { net, specs, reads } = tee();
    const spec = specs.find((s) => s.source.kind === 'band' && s.source.band === 'asphalt')!;
    for (const ribbon of net.ribbons.values()) {
      const paint = reads.look(ribbon.id)!.paint;
      for (const { slot, geom } of segmentShapes(net, ribbon)) {
        if (slot !== 'asphalt') continue;
        const tile = pieceBundle(new Map([['asphalt', [geom]]]), [spec]).get(spec.options.name)!;
        // Every corner of every triangle: the shader reads a triangle's slot from its last corner (`flat`).
        const stride = tile.sections.length / (tile.positions.length / 3);
        for (const v of tile.indices) expect(tile.sections[v * stride + 2], `road ${ribbon.id} vertex ${v}`).toBe(paint);
      }
    }
  });
});
