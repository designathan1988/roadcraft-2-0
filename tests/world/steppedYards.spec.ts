import { MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m, METERS_PER_UNIT } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { lotSurfaces } from '@world/buildings/lots';
import { floorHeight } from '@world/buildings/foundation';
import { localToWorld, volumeLift } from '@world/buildings/geometry';
import { localFootprint } from '@world/buildings/footprints';
import { LOT_PLATE, type TownPads, buildingPads, padLevelAt, ringDistance } from '@world/buildings/pads';
import { validateBuilding } from '@world/buildings/validate';
import { elementRect } from '@world/buildings/geometry';
import { emitChunk, withShellParts } from '@render/buildings/buildingMesh';
import { TERRAIN_CELL, TERRAIN_HALF } from '@render/terrain';
import { TERRAIN_SEGMENTS } from '@render/terrainGrid';
import { LOD_PATCH } from '@render/terrainLevels';
import { type SeamGrid, joinSeams, plateSeams, seamHeightAt } from '@render/terrainSeams';
import { RoadFootprints } from '@render/roadFootprints';
import { buildRoadSurfaces } from '@render/roadSurfaces';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import type { SceneMaterials } from '@render/materials';
import { plateOf, plateRegion, platesOver } from '@world/bounds';
import { cellDiagonal, cellHeight } from '@world/groundPatch';
import { buildRoadElevation } from '@world/elevation';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@world/growth/zoning';
import { FOOTWAY_RISE, Level, halfWidth, roadType } from '@world/roadTypes';
import type { ZoneDensity, ZoneUse } from '@world/zones';

/** Shops, blocks of flats, offices and works with a car park or a loading yard behind them follow their hillside */

/** Ground rising to the north (-y) at 18 %. */
const hill = (_x: number, y: number): number => -y * 0.18;
const paved = (x: number, y: number): number =>
  Math.abs(y) <= halfWidth(roadType(1), Level.Sidewalk) && Math.abs(x) <= m(160) ? hill(x, 0) + FOOTWAY_RISE : NaN;

function grow(use: ZoneUse, density: ZoneDensity): { doc: RoadDoc; net: Network; buildings: Building[] } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
  doc.addSegment(a, b, 1);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  zoneLots(doc, doc.lots.map((l) => l.id), { use, density });
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: hill, pavedAt: paved }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return { doc, net, buildings: [...doc.buildings.all()] as Building[] };
}

/** A point a little inside a ring's corner, towards its middle. */
function inside(ring: readonly { x: number; y: number }[], i: number, by: number): { x: number; y: number } {
  const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length, cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
  const p = ring[i]!, d = Math.hypot(cx - p.x, cy - p.y) || 1;
  return { x: p.x + ((cx - p.x) / d) * by, y: p.y + ((cy - p.y) / d) * by };
}

/**
 * The ground as the terrain draws it (`terrain.ts` renderedHeightAt) over the plates `area` reaches: each plate's grid of corners at `corner`'s
 * heights, a cell split along the diagonal it is drawn with (`groundPatch.ts` cellDiagonal, cellHeight), and the cells the surfaces laid on the
 * ground cut along their edges (`terrainSeams.ts`): the roads' footprints (hard) and the paved lots' rings at the ground graded under their
 * plates (soft), as `renderer.ts` hands them to the terrain (`seamSource`, `pavedLotRings`) and `flatAtlas.ts` moves them to a plate's frame
 * (`seamsOf`). A corner is read when the cut or a point asks for it.
 */
function drawnGround(corner: (x: number, y: number) => number, pads: TownPads, footprints: RoadFootprints, area: readonly [number, number, number, number]):
  (x: number, y: number) => number {
  const GRID = TERRAIN_SEGMENTS + 1;
  const plates = new Map<number, (x: number, y: number) => number>();
  for (const key of platesOver(area)) {
    const p = plateRegion(key);
    const heights = new Float64Array(GRID * GRID).fill(Number.NaN);
    // Where a corner stands, as the plate's mesh holds it (`terrain.ts` cornerX, cornerY).
    const cornerAt = (i: number): number => {
      if (Number.isNaN(heights[i]!)) {
        heights[i] = corner(p.cx + Math.fround((i % GRID) * TERRAIN_CELL - TERRAIN_HALF), p.cy - Math.fround(Math.floor(i / GRID) * TERRAIN_CELL - TERRAIN_HALF));
      }
      return heights[i]!;
    };
    const diagonal = (c: number): number => {
      const cx = c % TERRAIN_SEGMENTS, cy = (c - cx) / TERRAIN_SEGMENTS;
      return cellDiagonal(cornerAt(cx + GRID * cy), cornerAt(cx + GRID * (cy + 1)), cornerAt(cx + 1 + GRID * (cy + 1)), cornerAt(cx + 1 + GRID * cy));
    };
    const grid: SeamGrid = { n: GRID, cell: TERRAIN_CELL, half: TERRAIN_HALF, corner: cornerAt, diagonal };
    const reach = TERRAIN_HALF + TERRAIN_CELL;
    const rect = [p.cx - reach, p.cy - reach, p.cx + reach, p.cy + reach] as const;
    const soft: Float64Array[] = [];
    for (const pad of pads.cut([rect]).pads) {
      pad.rings.forEach((ring, k) => {
        const box = pad.boxes[k]!;
        if (!pad.paved[k] || box.maxX < rect[0] || box.minX > rect[2] || box.maxY < rect[1] || box.minY > rect[3]) return;
        soft.push(Float64Array.from(ring.flatMap((q) => [q.x, q.y, padLevelAt(pad.levels[k]!, q.x, q.y)])));
      });
    }
    const local = (list: readonly Float64Array[]): Float64Array[] => list.map((a) => {
      const out = Float64Array.from(a);
      for (let k = 0; k + 1 < out.length; k += 3) { out[k] = out[k]! - p.cx; out[k + 1] = out[k + 1]! - p.cy; }
      return out;
    });
    const seams = plateSeams(grid, { hard: local(footprints.meeting(rect)), soft: local(soft) }, LOD_PATCH);
    const joined = seams.size ? joinSeams(seams, grid) : null;
    plates.set(key, (x, y) => {
      // In a cut cell the terrain drawn there; elsewhere, and under a road, the grid (`terrain.ts` renderedHeightAt, `terrainShaping.ts` sampleCorners).
      const seam = joined ? seamHeightAt(joined, grid, cornerAt, x, y) : undefined;
      if (seam !== undefined) return seam;
      const gx = (x + TERRAIN_HALF) / TERRAIN_CELL, gy = (TERRAIN_HALF - y) / TERRAIN_CELL;
      const ix = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gx)), iy = Math.min(TERRAIN_SEGMENTS - 1, Math.floor(gy));
      return cellHeight(cornerAt(ix + iy * GRID), cornerAt(ix + (iy + 1) * GRID), cornerAt(ix + 1 + (iy + 1) * GRID), cornerAt(ix + 1 + iy * GRID),
        gx - ix, gy - iy, diagonal(ix + iy * TERRAIN_SEGMENTS));
    });
  }
  return (x, y) => {
    const key = plateOf(x, y), p = plateRegion(key);
    return plates.get(key)!(x - p.cx, y - p.cy);
  };
}

/** The points of a paving the drawn ground is read at: a little inside each corner of its ring, and every corner of the terrain's grid inside it.
 *  The drawn ground is flat on each of its triangles, whose corners are the grid's and the outlines' points (`terrainSeams.ts`), and the paving
 *  is flat across: what stands highest over a paving is at one of these, or on its ring, where the ground meets it at its plate's foot. */
function pavingPoints(ring: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const out = ring.map((_, i) => inside(ring, i, m(0.4)));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of ring) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  for (let i = Math.ceil(x0 / TERRAIN_CELL); i * TERRAIN_CELL <= x1; i++) {
    for (let j = Math.ceil(y0 / TERRAIN_CELL); j * TERRAIN_CELL <= y1; j++) {
      const q = { x: i * TERRAIN_CELL, y: j * TERRAIN_CELL };
      if (ringDistance(ring, q.x, q.y) === 0) out.push(q);
    }
  }
  return out;
}

/** A stand-in for the scene's materials: the road surfaces built for their footprints alone. */
const plainMaterials = new Proxy({}, { get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial() }) as unknown as SceneMaterials;

/** The car park or the loading yard behind the building: a wide paved lot surface beyond the building's back. */
const isYard = (b: Building, v: Building['volumes'][number]): boolean => {
  if (v.open !== 'asphalt' && v.open !== 'concrete') return false;
  const back = Math.max(...b.volumes.filter((o) => !o.open && o.base === 0).map((o) => o.y + o.d));
  return v.y >= back - m(0.5) && v.w > m(8);
};

/** Earth moved at the yard and the building, metres: the mean of |natural ground */
function earthworks(b: Building): { now: number; flat: number } {
  const floor = floorHeight(b, hill, paved);
  let now = 0, flat = 0, n = 0;
  for (const s of lotSurfaces(b, floor, paved)) {
    if (!isYard(b, s.volume)) continue;
    for (const p of s.ring) {
      now += Math.abs(s.heightAt(p.x, p.y) - hill(p.x, p.y));
      flat += Math.abs(floor - hill(p.x, p.y));
      n++;
    }
  }
  for (const v of b.volumes) {
    if (v.open || v.base !== 0 || v.mode) continue;
    for (const q of localFootprint(v)) {
      const p = localToWorld(b, q.x, q.y);
      now += Math.abs(floor + volumeLift(v) - hill(p.x, p.y));
      flat += Math.abs(floor - hill(p.x, p.y));
      n++;
    }
  }
  return { now: (now / n) * METERS_PER_UNIT, flat: (flat / n) * METERS_PER_UNIT };
}

/** Each kind, and the least share of its car parks and loading yards stepped */
const KINDS: [string, ZoneUse, ZoneDensity, number][] = [
  ['shops', 'commercial', 'low', 0.8],
  ['offices', 'commercial', 'high', 0.25],
  ['flats', 'residential', 'medium', 0.6],
  ['works', 'industrial', 'low', 0.8],
];

describe('car parks and loading yards stepped on a hillside', () => {
  for (const [name, use, density, share] of KINDS) {
    it(`${name}: the yard and the back step with the slope, a ramp to them, nothing floating or buried`, () => {
      const { doc, net, buildings } = grow(use, density);
      const withYard = buildings.filter((b) => b.volumes.some((v) => isYard(b, v)));
      expect(withYard.length).toBeGreaterThan(10);
      for (const b of withYard) expect(validateBuilding({ doc, net, groundAt: hill }, b, b.id), `building ${b.id}`).toBeNull();
      const stepped = withYard.filter((b) => b.volumes.some((v) => !v.open && volumeLift(v) !== 0));
      let now = 0, flat = 0;
      for (const b of stepped) { const e = earthworks(b); now += e.now; flat += e.flat; }
      console.log(`${name.toUpperCase()}: ${stepped.length}/${withYard.length} stepped; earth in the yard and on the blocks ${(flat / Math.max(1, stepped.length)).toFixed(2)} m -> ${(now / Math.max(1, stepped.length)).toFixed(2)} m`);
      expect(stepped.length).toBeGreaterThan(0);
      expect(now).toBeLessThan(flat * 0.8);
      // The car parks and loading yards themselves (before: none stepped - cars and lorries came in at the street's floor)
      const parks = withYard.filter((b) => b.elements?.some((e) => e.kind === 'parking' && e.y > Math.max(...b.volumes.filter((o) => !o.open).map((o) => o.y + o.d)) - m(0.5)));
      const steppedParks = parks.filter((b) => b.volumes.some((v) => isYard(b, v) && Math.abs(v.ramp ?? v.terrace ?? 0) > 1e-6));
      console.log(`  car parks and loading yards stepped: ${steppedParks.length}/${parks.length}`);
      expect(steppedParks.length / Math.max(1, parks.length)).toBeGreaterThanOrEqual(share);
      for (const b of steppedParks) expect(b.volumes.some((v) => v.open && v.ramp !== undefined && !isYard(b, v)), `drive ramp of building ${b.id}`).toBe(true);
      for (const b of withYard) {
        const floor = floorHeight(b, hill, paved);
        const back = b.volumes.filter((v) => !v.open && v.base === 0).map(volumeLift);
        for (const v of b.volumes) {
          if (!v.open || v.ramp === undefined || isYard(b, v)) continue;
          // A drive's ramp no steeper than its traffic takes, from the street's floor to the back's level.
          const grade = Math.abs((v.terrace ?? 0) - v.ramp) / v.d;
          expect(grade, `ramp of building ${b.id}`).toBeLessThanOrEqual((use === 'industrial' ? 0.1 : 0.125) + 1e-6);
          expect(v.ramp).toBeCloseTo(0, 6);
          expect(back.some((l) => Math.abs(l - (v.terrace ?? 0)) < 1e-6), `ramp of building ${b.id} meets the back`).toBe(true);
        }
        // Nothing buried: the ground drawn under each paving - the terrain's cells, each flat between its corners - never over it.
        const pads = buildingPads([b], hill, paved, TERRAIN_CELL * 1.5);
        const graded = (p: { x: number; y: number }): number => { const s = pads.shapeAt(p.x, p.y, hill(p.x, p.y)); return s.weight ? s.height : hill(p.x, p.y); };
        for (const s of lotSurfaces(b, floor, paved)) {
          if (s.volume.open === 'grass' || s.volume.open === 'water') continue;
          for (let i = 0; i < s.ring.length; i++) {
            const p = inside(s.ring, i, m(0.4));
            const cx = Math.floor((p.x + TERRAIN_HALF) / TERRAIN_CELL), cy = Math.floor((p.y + TERRAIN_HALF) / TERRAIN_CELL);
            for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
              const q = { x: -TERRAIN_HALF + (cx + di) * TERRAIN_CELL, y: -TERRAIN_HALF + (cy + dj) * TERRAIN_CELL };
              expect(graded(q), `ground over surface ${s.volume.id} of building ${b.id}`).toBeLessThanOrEqual(s.heightAt(q.x, q.y) - LOT_PLATE + m(0.02));
            }
          }
        }
        for (const v of b.volumes) {
          if (v.open || v.base !== 0 || v.mode) continue;
          const ring = localFootprint(v).map((q) => localToWorld(b, q.x, q.y));
          for (let i = 0; i < ring.length; i++) {
            // Under the floor (a yard's paving laid level with a back door meets it there).
            expect(graded(inside(ring, i, m(0.4))), `block ${v.id} of building ${b.id}`).toBeLessThanOrEqual(floor + volumeLift(v) + 1e-6);
          }
        }
      }
    });
  }

  it('leaves no earth over the paving of any lot along a street cut into its hill, every building graded together', () => {
    // The ground as the game shapes it: the hill, pulled down to the street beside the road (`world/elevation.ts` `shapeAt`)
    const wrong: string[] = [];
    let surfaces = 0, worst = 0;
    for (const [use, density] of [['industrial', 'low'], ['commercial', 'low'], ['residential', 'medium']] as [ZoneUse, ZoneDensity][]) {
      const doc = new RoadDoc();
      const a = doc.addNode({ x: m(-160), y: 0 }).id, z = doc.addNode({ x: m(160), y: 0 }).id;
      doc.addSegment(a, z, 1);
      const net = new Network(doc);
      net.rebuild();
      const elevation = buildRoadElevation(net, hill);
      const ground = (x: number, y: number): number => { const g = hill(x, y); const s = elevation.shapeAt(x, y, g); return g + (s.height - g) * s.weight; };
      const rt = roadType(1);
      const street = (x: number, y: number): number => Math.abs(y) <= halfWidth(rt, Level.Sidewalk) && Math.abs(x) <= m(160)
        ? elevation.at(x, 0) + (Math.abs(y) > halfWidth(rt, Level.Curb) ? FOOTWAY_RISE : 0) : NaN;
      applyLots(doc, planLots(doc, net));
      zoneLots(doc, doc.lots.map((l) => l.id), { use, density });
      const refused = new Set<number>();
      for (let k = 0; k < doc.lots.length * 3; k++) {
        if (growOnLot({ doc, net, groundAt: ground, pavedAt: street }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
      }
      const all = [...doc.buildings.all()] as Building[];
      const pads = buildingPads(all, ground, street, TERRAIN_CELL * 1.5);
      const graded = (p: { x: number; y: number }): number => { const s = pads.shapeAt(p.x, p.y, ground(p.x, p.y)); return s.weight ? s.height : ground(p.x, p.y); };
      // The road drawn, its footprint the terrain is cut along (`roadFootprints.ts`), and the ground as the terrain draws it round the lots.
      const footprints = new RoadFootprints();
      buildRoadSurfaces(net, elevation, plainMaterials, ground, { tiles: new Map(), dependsOn: () => 0, chunks: new Map(), inputs: new SurfaceInputs(), footprints }).dispose();
      expect(footprints.meeting([m(-160), m(-20), m(160), m(20)]).length).toBeGreaterThan(0);
      const drawn = drawnGround((x, y) => graded({ x, y }), pads, footprints, [m(-400), m(-400), m(400), m(400)]);
      for (const b of all) {
        const floor = floorHeight(b, ground, street);
        for (const s of lotSurfaces(b, floor, street)) {
          if (s.volume.open === 'grass' || s.volume.open === 'water') continue;
          surfaces++;
          // The ground drawn under the paving (the terrain cut along its ring, `terrainSeams.ts`), never over its plate's foot.
          let over = 0;
          for (const q of pavingPoints(s.ring)) over = Math.max(over, drawn(q.x, q.y) - (s.heightAt(q.x, q.y) - LOT_PLATE));
          worst = Math.max(worst, over);
          // Open (AC7)
          const allowed = s.volume.ramp !== undefined ? m(0.5) : m(0.02);
          if (over > allowed) wrong.push(`${use}: ${b.function} ${b.id}, ${s.volume.open} ${s.volume.id}${s.volume.ramp !== undefined ? ' (ramp)' : s.volume.terrace ? ' (step)' : ''}: earth ${(over * METERS_PER_UNIT).toFixed(2)} m over`);
        }
      }
    }
    console.log(`EARTH OVER THE FLOOR: ${wrong.length} of ${surfaces} surfaces, worst ${(worst * METERS_PER_UNIT).toFixed(2)} m\n${wrong.join('\n')}`);
    // Before (27a7cb48): 23 of 290 surfaces, up to 7.46 m
    expect(wrong).toEqual([]);
  });

  it('stands the crates of a raised or lowered service court on its paving, not that far over or under it', () => {
    const { buildings } = grow('commercial', 'low');
    let checked = 0, worst = 0;
    for (const h of buildings) {
      const floor = floorHeight(h, hill, paved);
      const lifted = lotSurfaces(h, floor, paved).filter((s) => s.volume.open !== 'grass' && s.volume.open !== 'water' && (s.volume.ramp ?? s.volume.terrace ?? 0) !== 0);
      if (!lifted.length) continue;
      // The crates are the shell's parts (`shellParts.ts`): laid in the shell again, as they are drawn.
      const wood = withShellParts(emitChunk(h, hill, paved)).shells.wood;
      if (!wood) continue;
      for (const el of h.elements ?? []) {
        if (el.kind !== 'slab' || el.material?.finish !== 'wood') continue;
        const host = lifted.find((s) => el.x >= s.volume.x && el.x <= s.volume.x + s.volume.w && el.y >= s.volume.y && el.y <= s.volume.y + s.volume.d);
        const base = host ? host.volume.ramp ?? host.volume.terrace ?? 0 : 0;
        // The bottom crate of a stack: laid with the court, at its level.
        if (!host || Math.abs(el.z - base) > 1e-6) continue;
        const [x0, y0, x1, y1] = elementRect(el);
        const a = localToWorld(h, x0, y0), b = localToWorld(h, x1, y1), c = localToWorld(h, el.x, el.y);
        // Its top: the paving and its own height (a stack's top crate may stand above it).
        let top = -Infinity;
        for (let i = 0; i < wood.position.length; i += 3) {
          const x = wood.position[i]!, z = wood.position[i + 1]!, y = -wood.position[i + 2]!;
          if (x >= Math.min(a.x, b.x) - 0.01 && x <= Math.max(a.x, b.x) + 0.01 && y >= Math.min(a.y, b.y) - 0.01 && y <= Math.max(a.y, b.y) + 0.01) top = Math.max(top, z);
        }
        if (!Number.isFinite(top)) continue;
        const stack = (h.elements ?? []).filter((o) => o.kind === 'slab' && o.material?.finish === 'wood' && Math.abs(o.x - el.x) < m(0.3) && Math.abs(o.y - el.y) < m(0.3));
        const expected = host.heightAt(c.x, c.y) + Math.max(...stack.map((o) => o.z - base + o.h));
        worst = Math.max(worst, Math.abs(top - expected));
        checked++;
      }
    }
    // Before: 2.2 m in the air on a court a storey up, under the paving on one a storey down.
    console.log(`CRATES: ${checked} in the stepped yard, worst ${worst.toFixed(3)} m from the floor`);
    expect(checked).toBeGreaterThan(0);
    expect(worst).toBeLessThan(m(0.02));
  });
});
