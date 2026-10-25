import { describe, expect, it } from 'vitest';
import type { InstancedBufferGeometry, InterleavedBufferAttribute, Mesh } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { POLE_HEIGHT, type PoleKind, WIRE_SEGMENTS } from '@world/utilities';
import { sampleWire } from '../world/oracle/sampleWire';
import { createSceneryKit } from '@render/scenery';
import { buildUtilities } from '@render/poleLayer';
import { castShadowKey } from '@render/shadowCasters';
import { SPAN_WIRES, WIRE_ABSENT } from '@render/utilities';
import { m } from '@world/units';

/** THE POLE LAYER'S WIRES AS INSTANCES: each wire is eight numbers - its ends in three's axes, its sag and its phase - five a span: the three
 *  primary wires on the cross-arm's insulators, the two secondary ones on an urban pole's rack (an empty slot where a span carries none) */

/** A straight line of `n` poles along x at `y`, 30 m apart, each of the kind given. */
function line(doc: RoadDoc, n: number, y: number, kind: (i: number) => PoleKind): void {
  const ids = Array.from({ length: n }, (_, i) => doc.addPole({ x: i * m(30), y }, i % 2 === 0, kind(i)).id);
  for (let i = 1; i < n; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
}

/** The wires of a layer built from the document: every wire's numbers and their count, as the mesh casting them all holds them (the colour
 *  pass draws each span by its own size, `poleStores.ts`). */
function wiresOf(doc: RoadDoc): { data: Float32Array; count: number; geometry: InstancedBufferGeometry; dispose: () => void } {
  const net = new Network(doc);
  net.rebuild();
  const layer = buildUtilities(net, () => 0, createSceneryKit());
  const wires = layer.group.getObjectByName('utility-wires-cast') as Mesh;
  const geometry = wires.geometry as InstancedBufferGeometry;
  const start = geometry.getAttribute('aStart') as InterleavedBufferAttribute;
  expect(start.data.stride).toBe(8);
  return { data: start.data.array as Float32Array, count: castShadowKey(wires)!.count!, geometry, dispose: () => layer.dispose() };
}

/** The wire's point at t from its instance, as the shader takes it (`wireAt`). */
function wireAt(data: ArrayLike<number>, w: number, t: number): [number, number, number] {
  const o = w * 8, u = t * 2 - 1, drop = data[o + 6]! * (1 - u * u);
  return [data[o]! + (data[o + 3]! - data[o]!) * t, data[o + 1]! + (data[o + 4]! - data[o + 1]!) * t - drop, data[o + 2]! + (data[o + 5]! - data[o + 2]!) * t];
}

/** A wire's ends in world terms (x, y, height), from three's axes. */
const ends = (data: ArrayLike<number>, w: number): number[] =>
  [data[w * 8]!, -data[w * 8 + 2]!, data[w * 8 + 1]!, data[w * 8 + 3]!, -data[w * 8 + 5]!, data[w * 8 + 4]!];

/** The primary wires' height: on an insulator's 20 cm on the arm's top, 15 cm under the crown (Figura 31). */
const PRIMARY_HEIGHT = POLE_HEIGHT - m(0.15) + m(0.2);

describe('the pole layer\'s wires as instances', () => {
  it('strings an urban line\'s three primary wires over the street and two secondary on the rack, as the standard places them', () => {
    const doc = new RoadDoc();
    // Off the streets: its arms reach the world's +y (`poleToward`).
    line(doc, 3, 0, () => 'urban');
    const { data, count, dispose } = wiresOf(doc);
    expect(count).toBe(2 * SPAN_WIRES);
    // Each span: primary at 55, 125 and 185 cm along the arm, the beco structure B1 (CELESC E-313.0002, Figuras 16 and 43); secondary 22 cm
    // out from the mast's axis, 1.3 and 1.5 m under the crown, 20 cm apart (S1, Figura 71).
    const want = [
      [m(0.55), PRIMARY_HEIGHT], [m(1.25), PRIMARY_HEIGHT], [m(1.85), PRIMARY_HEIGHT], [m(0.22), POLE_HEIGHT - m(1.3)], [m(0.22), POLE_HEIGHT - m(1.5)],
    ];
    for (let span = 0; span < 2; span++) {
      want.forEach(([along, height], k) => {
        const w = span * SPAN_WIRES + k, e = ends(data, w);
        expect(e[1]).toBeCloseTo(along!, 4); expect(e[2]).toBeCloseTo(height!, 4);
        expect(e[4]).toBeCloseTo(along!, 4); expect(e[5]).toBeCloseTo(height!, 4);
        expect(Math.abs(e[3]! - e[0]!)).toBeCloseTo(m(30), 4);
        expect(data[w * 8 + 6]).toBeGreaterThan(0);
      });
    }
    dispose();
  });

  it('strings a rural line\'s three primary wires across the crown and no secondary', () => {
    const doc = new RoadDoc();
    line(doc, 2, 0, () => 'rural');
    const { data, count, dispose } = wiresOf(doc);
    expect(count).toBe(SPAN_WIRES);
    // The normal structure N1: -95, 35 and 95 cm along the arm (Figuras 16 and 31).
    [-m(0.95), m(0.35), m(0.95)].forEach((along, w) => {
      const e = ends(data, w);
      expect(e[1]).toBeCloseTo(along, 4); expect(e[4]).toBeCloseTo(along, 4); expect(e[2]).toBeCloseTo(PRIMARY_HEIGHT, 4);
    });
    // Its secondary slots empty: drawn as nothing (`WIRE_GLSL`).
    expect(data[3 * 8 + 6]).toBe(WIRE_ABSENT);
    expect(data[4 * 8 + 6]).toBe(WIRE_ABSENT);
    dispose();
  });

  it('carries no secondary wire between an urban and a rural pole, its primary wires seat to seat', () => {
    const doc = new RoadDoc();
    line(doc, 2, 0, (i) => (i === 0 ? 'urban' : 'rural'));
    const { data, dispose } = wiresOf(doc);
    // The urban end's seats to the rural end's, wire by wire (either end may be the instance's first).
    [[m(0.55), -m(0.95)], [m(1.25), m(0.35)], [m(1.85), m(0.95)]].forEach(([urban, rural], w) => {
      const e = ends(data, w);
      const atUrban = e[0]! < e[3]! ? e[1]! : e[4]!, atRural = e[0]! < e[3]! ? e[4]! : e[1]!;
      expect(atUrban).toBeCloseTo(urban!, 4); expect(atRural).toBeCloseTo(rural!, 4);
    });
    expect(data[3 * 8 + 6]).toBe(WIRE_ABSENT);
    expect(data[4 * 8 + 6]).toBe(WIRE_ABSENT);
    dispose();
  });

  it('lays every wire of a wandering line where sampleWire lays it between its ends, on one side of the line all along it', () => {
    const doc = new RoadDoc();
    // A line wandering 2 m off y = 0 every other pole, and a second one 80 m off.
    const lineY = (x: number): number => (Math.round(x / m(30)) % 2) * m(2);
    const ids = Array.from({ length: 6 }, (_, i) => doc.addPole({ x: i * m(30), y: lineY(i * m(30)) }, i % 2 === 0, 'urban').id);
    for (let i = 1; i < ids.length; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
    line(doc, 4, m(80), () => 'urban');
    const { data, count, geometry, dispose } = wiresOf(doc);
    expect(count).toBe(doc.poleSpans.size * SPAN_WIRES);
    let worst = 0;
    for (let w = 0; w < count; w++) {
      const e = ends(data, w);
      // The wandering line's wires on its +y side at both ends, its poles' arms all reaching +y (`poleToward` by the larger axis): none
      // crosses from one side to the other between two poles (a sign of x alone flipped from pole to pole of this line).
      if (e[1]! < m(40)) {
        expect(e[1]!).toBeGreaterThanOrEqual(lineY(e[0]!) - 1e-4);
        expect(e[4]!).toBeGreaterThanOrEqual(lineY(e[3]!) - 1e-4);
      }
      const points = sampleWire(e[0]!, e[1]!, e[2]!, e[3]!, e[4]!, e[5]!);
      points.forEach((p, i) => {
        const [x, y, z] = wireAt(data, w, i / WIRE_SEGMENTS);
        worst = Math.max(worst, Math.abs(x - p.x), Math.abs(y - p.z), Math.abs(z + p.y));
      });
    }
    // Float32 storage of the same numbers.
    expect(worst).toBeLessThan(1e-4);
    // The bounds hold every wire, sag and all.
    const sphere = geometry.boundingSphere!;
    for (let k = 0; k < count; k++) {
      for (const t of [0, 0.5, 1]) {
        const [x, y, z] = wireAt(data, k, t);
        expect(Math.hypot(x - sphere.center.x, y - sphere.center.y, z - sphere.center.z)).toBeLessThanOrEqual(sphere.radius);
      }
    }
    dispose();
  });
});
