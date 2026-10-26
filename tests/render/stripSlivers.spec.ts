import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { layCity } from '@editor/cityGenerator';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { RoadDoc } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { m } from '@world/units';
import { farRoadInput } from '@render/networkFarRoads';
import { buildFarRoadCells } from '@render/networkFarRoadsBuild';
import { CELL, pieceOfPart } from '@render/roadSurfaceEntries';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { type PassLook, passDesc, passRaised, passReads, tileBundle } from '@render/roadSurfacePass';
import { passSurfaces } from '@render/roadSurfaceReads';

/**
 * NO SLIVER IN A ROAD'S STRIPS (what `tileShapeFlip.spec.ts` "has few slivers" held the grid mesher to, for the strips that replaced it): a band
 * of a road is a ladder of stations across it (`mesh/stripShape.ts`), each quad as long as the stations are apart. Nothing a road is drawn with is
 * narrower than its kerb (15 cm) across, and no surface asks for stations closer than its least edge along it (`roadSurfaceReads.ts` LEAST_EDGE,
 * 0.5 m; 0.25 m on a dropped kerb): a triangle with an edge under a centimetre on the plan is a needle, two stations that should have been one.
 * The detailed strips of every road (`roads/segmentPiece.ts`, meshed by `roads/pieceMesh.ts`) and the network's far level (`networkFarRoadsBuild.ts`).
 */

/** The shortest edge on the plan a road's triangle may have. */
const LEAST = m(0.01);

const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);
const look: PassLook = { scale: { asphalt: 4, footway: 4, kerb: 4, verge: 4, deck: 4 }, classTint: [], referenceTint: [1, 1, 1], pavingTint: {} };

const DOCS: readonly (readonly [string, () => RoadDoc])[] = [
  ['the grid and bends fixture', () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document)],
  ['a generated city', () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' }))],
];

/** The shortest of a triangle's three edges on the plan (x, -z of three's positions). */
function shortestEdge(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const e = (u: number, v: number): number => Math.hypot(p[v]! - p[u]!, p[v + 2]! - p[u + 2]!);
  return Math.min(e(a, b), e(b, c), e(c, a));
}

describe('the triangles of a road\'s strips', () => {
  for (const [name, make] of DOCS) {
    it(`lay no needle in ${name}: every top face of every road's surfaces has its edges a centimetre or more on the plan`, () => {
      const net = new Network(make());
      net.rebuild();
      const elevation = buildRoadElevation(net, ground);
      const inputs = new SurfaceInputs();
      inputs.refresh(net);
      const reads = passReads(net, elevation, ground);
      let faces = 0;
      const needles: string[] = [];
      for (const pass of inputs.passList()) {
        const keys = inputs.tileKeys(pass.id);
        if (keys.length === 0) continue;
        const specs = passSurfaces(passDesc(net, pass, passRaised(net, pass, elevation, ground), look), reads);
        for (const key of keys) {
          const piece = pieceOfPart(key);
          if (piece.kind !== 'segment' || !inputs.hasTile(pass.id, key)) continue;
          for (const [surface, tile] of tileBundle(inputs.reachOf(pass.id, key).reach, specs)) {
            // The surfaces' top faces (a wall's normal lies flat; the footprint and the paint are not strips of the road's bands).
            if (surface === 'footprint' || surface.startsWith('markings')) continue;
            const p = tile.positions, index = tile.indices, normal = tile.normals;
            for (let t = 0; t + 2 < index.length; t += 3) {
              const a = index[t]! * 3, b = index[t + 1]! * 3, c = index[t + 2]! * 3;
              if (Math.abs(normal[a + 1]!) < 0.5) continue;
              faces++;
              const shortest = shortestEdge(p, a, b, c);
              if (shortest < LEAST) needles.push(`road ${piece.id} ${surface}: ${shortest.toFixed(4)} at (${p[a]!.toFixed(2)}, ${(-p[a + 2]!).toFixed(2)})`);
            }
          }
        }
      }
      // Enough faces looked at: the fixture's roads drawn at all. One quad a band of a road between its mouths on the flat (the owner's road tool's
      // structure, `roads/segmentPiece.ts`) draws fewer of them than the strips stationed apart did (grid and bends 4,718, a city 11,803, 2026-10-24).
      expect(faces).toBeGreaterThan(4_000);
      expect(needles).toEqual([]);
    });
  }
});

describe('the triangles of the network\'s far level', () => {
  for (const [name, make] of DOCS) {
    it(`lay no needle in ${name}: every triangle of every block's layers has its edges a centimetre or more on the plan`, () => {
      const net = new Network(make());
      net.rebuild();
      const cells = buildFarRoadCells(farRoadInput(net, buildRoadElevation(net, ground), ground, CELL, null).input);
      let triangles = 0;
      const needles: string[] = [];
      for (const cell of cells) {
        for (let t = 0; t + 2 < cell.indices.length; t += 3) {
          triangles++;
          const shortest = shortestEdge(cell.positions, cell.indices[t]! * 3, cell.indices[t + 1]! * 3, cell.indices[t + 2]! * 3);
          if (shortest < LEAST) needles.push(`block ${cell.key} layer ${cell.layer}: ${shortest.toFixed(4)}`);
        }
      }
      expect(triangles).toBeGreaterThan(500);
      expect(needles).toEqual([]);
    });
  }
});
