import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { ROAD_TYPES } from '@world/roadTypes';
import type { RoadSection } from '@world/roadSection';
import type { NodeId } from '@world/ids';
import { cellDiagonal } from '@world/groundPatch';
import type { Geom } from '@render/roads/pieceGeom';
import { FOOTPRINT, type MeshedSurface, pieceBundle } from '@render/roads/pieceMesh';
import { type Shape, segmentShapes } from '@render/roads/segmentPiece';
import { junctionShapes } from '@render/roads/junctionPiece';
import { passDesc, passReads } from '@render/roadSurfacePass';
import { passSurfaces } from '@render/roadSurfaceReads';
import type { SurfacePass } from '@render/roadSurfaceEntries';
import { type SeamGrid, TriangleIndex, joinSeams, outlineEdges, plateSeams } from '@render/terrainSeams';

/**
 * THE GROUND LEVEL WITH THE ROAD ROUND A JUNCTION (`terrainSeams.ts`, `roads/pieceMesh.ts` footprintOf): no band of grass beside the footway, no
 * step and no ditch where the ground meets it, at the junction's corners as along its roads, on a slope and on a ridge. Every point of the outline the
 * roads' drawn triangles leave on the ground (their footway's outer edge, the square back of each corner, the roads' free ends) is a vertex of the
 * ground cut along them, at the very height the road's vertex is drawn at; and no shape a ground pass draws reaches past the footway's outer edge.
 */

/** The owner's road tool's cross-section on the urban class (`toolReference.spec.ts`). */
const SECTION: RoadSection = { laneWidth: 3.5, sidewalk: 2.65, median: 0, speedKmh: 50, priority: 1 };
const URBAN = ROAD_TYPES.findIndex((t) => t.id === 'urban');
/** The grounds of the catalogue's junctions off the flat (`lab/catalog/layout.ts` GROUNDS), and the flat. */
const GROUNDS: readonly (readonly [string, (x: number, y: number) => number])[] = [
  ['flat', () => 0],
  ['a slope of 5 % east and 2 % north', (x, y) => 0.05 * x + 0.02 * y],
  ['a ridge on the node, 5 % down every road', (x, y) => -0.05 * Math.max(Math.abs(x), Math.abs(y))],
];
const LAYOUTS: readonly (readonly [string, readonly (readonly [number, number])[]])[] = [
  ['four ways', [[70, 0], [0, 70], [-70, 0], [0, -70]]],
  ['three ways', [[70, 0], [-70, 0], [0, 70]]],
  ['a bend', [[-70, 0], [0, 70]]],
];

/** The plate the junction stands on: 10 m cells (`terrainGrid.ts`), its corners on the ground. */
const seg = 32, n = seg + 1, cell = 10, half = (seg * cell) / 2, patch = 8;
function gridOf(ground: (x: number, y: number) => number): SeamGrid {
  const heights = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[i + j * n] = ground(-half + i * cell, half - j * cell);
  const flip = new Uint8Array(seg * seg);
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) flip[i + j * seg] = cellDiagonal(heights[i + j * n]!, heights[i + (j + 1) * n]!, heights[i + 1 + (j + 1) * n]!, heights[i + 1 + j * n]!);
  return { n, cell, half, corner: (i) => heights[i]!, diagonal: (c) => flip[c]! };
}

const byTile = (shapes: readonly Shape[]): Map<string, Geom[]> => {
  const reach = new Map<string, Geom[]>();
  for (const { slot, geom } of shapes) { const list = reach.get(slot); if (list) list.push(geom); else reach.set(slot, [geom]); }
  return reach;
};

describe('the ground round a junction, level with its road', () => {
  for (const [groundName, ground] of GROUNDS) {
    for (const [layoutName, ends] of LAYOUTS) {
      it(`meets ${layoutName} on ${groundName} on the road's own vertices, at their heights`, () => {
        const doc = new RoadDoc();
        const centre = doc.addNode({ x: 0, y: 0 });
        for (const [x, y] of ends) doc.addSegment(centre.id, doc.addNode({ x, y }).id, URBAN, null, 0, 'both', null, 'ground', SECTION);
        const net = new Network(doc);
        net.rebuild();
        const elevation = buildRoadElevation(net, ground);
        const pass: SurfacePass = { id: 'ground', structure: 'ground' };
        const look = { scale: { asphalt: 4, footway: 2, kerb: 1, verge: 4, deck: 4 }, classTint: [], referenceTint: [1, 1, 1] as const, pavingTint: {} };
        const specs: MeshedSurface[] = passSurfaces(passDesc(net, pass, false, look), passReads(net, elevation, ground));
        // No band past the footway on the ground: the surfaces a ground pass draws are the carriageway, the footway, the kerb and the ramps.
        expect(specs.map((s) => s.options.name).sort()).toEqual(['asphalt', 'curb-ramp', 'footway', 'kerb', 'median-kerb', 'median-paved', 'median-planting'].sort());
        // What the pieces draw over the ground, as the terrain is given it (x, y, height a corner).
        const hard: Float64Array[] = [];
        const pieces = [...[...net.ribbons.values()].map((r) => byTile(segmentShapes(net, r))), ...[...net.junctions.keys()].map((id) => byTile(junctionShapes(net, id as NodeId)))];
        for (const reach of pieces) {
          const print = pieceBundle(reach, specs).get(FOOTPRINT);
          if (!print) continue;
          const soup = new Float64Array(print.positions.length);
          for (let v = 0; v < print.positions.length; v += 3) { soup[v] = print.positions[v]!; soup[v + 1] = -print.positions[v + 2]!; soup[v + 2] = print.positions[v + 1]!; }
          hard.push(soup);
        }
        const outline = { hard, soft: [] as Float64Array[] };
        const edges = outlineEdges(outline, new TriangleIndex(hard, cell));
        const seams = joinSeams(plateSeams(gridOf(ground), outline, patch), { n, cell, half });
        // Every point of the outline a vertex of the ground, at the road's height (the ground's positions are floats: a tenth of a millimetre).
        const p = seams.positions;
        const missing: string[] = [];
        let points = 0;
        for (let e = 0; e + 5 < edges.length; e += 6) {
          for (const k of [0, 3]) {
            const x = edges[e + k]!, y = edges[e + k + 1]!, h = edges[e + k + 2]!;
            if (Math.abs(x) > half - cell || Math.abs(y) > half - cell) continue;
            points++;
            let found = false;
            for (let v = 0; v < p.length / 3 && !found; v++) {
              if (Math.abs(p[v * 3]! - x) < 1e-4 && Math.abs(-p[v * 3 + 2]! - y) < 1e-4) found = Math.abs(p[v * 3 + 1]! - h) < 1e-4;
            }
            if (!found) missing.push(`${x.toFixed(3)}, ${y.toFixed(3)} at ${h.toFixed(4)}`);
          }
        }
        expect(points).toBeGreaterThan(20);
        expect(missing).toEqual([]);
      });
    }
  }
});
