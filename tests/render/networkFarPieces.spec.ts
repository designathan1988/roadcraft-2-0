import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { ROAD_TYPES, Level, sideHalfWidth } from '@world/roadTypes';
import { layCity } from '@editor/cityGenerator';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { buildRoadElevation, FLAT_GROUND } from '@world/elevation';
import { FAR_SECTION, farPieceCells } from '@render/networkFarPieces';
import { ROAD_PASS_LOOK } from '@render/roadPassLook';
import { ROAD_CODE } from '@render/mesh/roadEdges';
import { nodeOwner, ownerCell, segmentOwner } from '@render/roads/pieceOwner';

/**
 * THE NETWORK'S ROOT LEVEL, MADE OF THE DETAIL'S OWN PIECES (`networkFarPieces.ts` farPieceCells): every surface the detail draws (the carriageway,
 * the footway, the kerb, a median's planting), each vertex's section as the detail's carries it (across, along, the piece's id as its paint's slot,
 * the surface's code), every piece in its owner's block, and the cells asked alone holding their own pieces and no other.
 */

/** Each vertex's section of the cells, four numbers. */
const sectionsOf = (cells: ReturnType<typeof farPieceCells>): number[][] => cells.flatMap((c) => {
  const out: number[][] = [];
  for (let at = 0; at < c.sections.length; at += FAR_SECTION) out.push([...c.sections.subarray(at, at + FAR_SECTION)]);
  return out;
});

describe("the network's root level", () => {
  it("draws a junction's roads with every surface of the detail, its carriageway's vertices carrying each road's id and its offsets across, its plate its node's", () => {
    const doc = new RoadDoc();
    const urban = ROAD_TYPES.findIndex((t) => t.id === 'urban');
    const centre = doc.addNode({ x: 0, y: 0 });
    const legs = [[70, 0], [0, 70], [-70, 0], [0, -70]].map(([x, y]) => doc.addSegment(centre.id, doc.addNode({ x: x!, y: y! }).id, urban));
    const net = new Network(doc);
    net.rebuild();
    const cells = farPieceCells(net, buildRoadElevation(net, FLAT_GROUND), FLAT_GROUND, 1000, null, ROAD_PASS_LOOK);
    const sections = sectionsOf(cells);
    const codes = new Set(sections.map((s) => s[3]));
    // The detail's surfaces, not the carriageway alone.
    expect(codes.has(ROAD_CODE.carriageway)).toBe(true);
    expect(codes.has(ROAD_CODE.footway)).toBe(true);
    const ids = new Set(legs.map((s) => s!.id as number));
    const half = sideHalfWidth(ROAD_TYPES[urban]!, Level.Asphalt, 'left');
    let onRoads = 0, onPlate = 0;
    for (const [across, along, slot, code] of sections) {
      if (code !== ROAD_CODE.carriageway) continue;
      if (slot! >= 0) {
        onRoads++;
        expect(ids.has(slot!)).toBe(true);
        expect(Math.abs(across!)).toBeLessThanOrEqual(half + 1e-6);
        expect(along).toBeGreaterThanOrEqual(0);
      } else if (slot! <= -2) { onPlate++; expect(-2 - slot!).toBe(centre.id); }
    }
    expect(onRoads).toBeGreaterThan(0);
    expect(onPlate).toBeGreaterThan(0);
  });

  it("files every piece in its owner's block, and the cells asked alone hold their own pieces and no other", () => {
    const net = new Network(layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' })));
    net.rebuild();
    const elevation = buildRoadElevation(net, FLAT_GROUND);
    const cell = 200;
    const whole = farPieceCells(net, elevation, FLAT_GROUND, cell, null, ROAD_PASS_LOOK);
    const owners = new Set<string>();
    for (const id of net.ribbons.keys()) { const at = segmentOwner(net, id); if (at) owners.add(ownerCell(at, cell).join(',')); }
    for (const id of net.junctions.keys()) { const at = nodeOwner(net, id); if (at) owners.add(ownerCell(at, cell).join(',')); }
    expect(whole.length).toBeGreaterThan(1);
    for (const c of whole) expect(owners.has(c.key)).toBe(true);
    // The block holding the most triangles, asked alone (an edit's cell made again): the same arrays the whole level made there.
    const busiest = [...whole].sort((p, q) => q.indices.length - p.indices.length)[0]!;
    const only = farPieceCells(net, elevation, FLAT_GROUND, cell, new Set([busiest.key]), ROAD_PASS_LOOK);
    expect(only.map((c) => c.key)).toEqual([busiest.key]);
    expect(only[0]!.positions).toEqual(busiest.positions);
    expect(only[0]!.indices).toEqual(busiest.indices);
    expect(only[0]!.sections).toEqual(busiest.sections);
  });
});
