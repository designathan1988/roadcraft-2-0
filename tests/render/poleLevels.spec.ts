import { describe, expect, it } from 'vitest';
import { type BufferAttribute, type InstancedBufferGeometry, type InstancedMesh, type InterleavedBufferAttribute, type Mesh, type Object3D, PerspectiveCamera } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { createSceneryKit } from '@render/scenery';
import { buildUtilities } from '@render/poleLayer';
import { ScreenScale } from '@render/poleStores';
import { WIRE_MIN_PIXELS, WIRE_WIDTH, wireChords, wireLevel } from '@render/utilities';
import { m } from '@world/units';

/** THE POLE LAYER AS THE CAMERA SEES IT: one mesh a part a block of the plane casts every piece; the colour pass draws EACH PIECE AND EACH
 *  SPAN BY ITS OWN SIZE ON THE SCREEN - under a pixel not drawn, its shape and its wires' template the coarsest within a pixel at its own
 *  distance, not its block's nearest pole's (a block is a kilometre). */

/** Two lines of poles in cells a kilometre apart. */
function twoLines(): RoadDoc {
  const doc = new RoadDoc();
  for (const y of [0, m(1000)]) {
    const ids = Array.from({ length: 5 }, (_, i) => doc.addPole({ x: m(20) + i * m(30), y }, i % 2 === 0).id);
    for (let i = 1; i < ids.length; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
  }
  return doc;
}

/** A camera at (x, back) `height` up looking at (x, 0) on the near line (three's axes: z is world -y). */
function camera(height: number, x = m(80), back = m(40), lookX = x): PerspectiveCamera {
  const c = new PerspectiveCamera(35, 16 / 9, 0.1, 20_000);
  c.position.set(x, height, back);
  c.lookAt(lookX, 0, 0);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

/** The meshes of a name in the near line's block (world y under 500 m) or the far one's. */
function named(root: Object3D, name: string, line: 'near' | 'far' = 'near'): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o.name !== name) return;
    const y = -((o as InstancedMesh).boundingSphere ?? (o as Mesh).geometry.boundingSphere)!.center.z;
    if ((y < m(500)) === (line === 'near')) out.push(o as Mesh);
  });
  return out;
}

/** The pieces (or wires) of a name the colour pass draws in a line's block. */
const drawnCount = (root: Object3D, name: string, line: 'near' | 'far' = 'near'): number => named(root, name, line).reduce((sum, mesh) => {
  if (!mesh.visible) return sum;
  return sum + ((mesh as InstancedMesh).isInstancedMesh ? (mesh as InstancedMesh).count : (mesh.geometry as InstancedBufferGeometry).instanceCount);
}, 0);

/** The triangles of the finest shape a name is drawn with in the near line's block (0: none drawn). */
const finest = (root: Object3D, name: string): number => Math.max(0, ...named(root, name).filter((mesh) => mesh.visible && (mesh as InstancedMesh).count > 0)
  .map((mesh) => mesh.geometry.index!.count / 3));

/** Each wire the colour pass draws in a line's block: its template's chords and crease, and its span's sphere (as the store measures it). */
function drawnWires(root: Object3D, line: 'near' | 'far'): { chords: number; creased: boolean; x: number; y: number; z: number; r: number; sag: number }[] {
  const out: { chords: number; creased: boolean; x: number; y: number; z: number; r: number; sag: number }[] = [];
  for (const mesh of named(root, 'utility-wires', line)) {
    const g = mesh.geometry as InstancedBufferGeometry;
    if (!mesh.visible || g.instanceCount === 0) continue;
    // The template's own record of itself (`utilities.ts` stripTemplate: normal.x its chords, normal.y 1 when creased).
    const normal = g.getAttribute('normal') as BufferAttribute;
    const chords = normal.getX(0), creased = normal.getY(0) > 0.5;
    const data = (g.getAttribute('aStart') as InterleavedBufferAttribute).data.array as Float32Array;
    for (let i = 0; i < g.instanceCount; i++) {
      const o = i * 8, sag = data[o + 6]!;
      const ax = data[o]!, ay = data[o + 1]!, az = data[o + 2]!, bx = data[o + 3]!, by = data[o + 4]!, bz = data[o + 5]!;
      out.push({ chords, creased, x: (ax + bx) / 2, y: (ay + by) / 2 - sag, z: (az + bz) / 2, r: Math.hypot(bx - ax, by - ay, bz - az) / 2 + sag + m(2), sag });
    }
  }
  return out;
}

describe('the pole layer as the camera sees it', () => {
  it('draws each piece and each span by its own size: every piece near, the small ones gone and the wires faded far away', () => {
    const doc = twoLines();
    const net = new Network(doc);
    net.rebuild();
    const kit = createSceneryKit();
    const layer = buildUtilities(net, () => 0, kit);
    // A mesh a part a block of the plane casts every piece: the two lines a kilometre apart stand in two.
    expect([...named(layer.group, 'utility-insulators-cast'), ...named(layer.group, 'utility-insulators-cast', 'far')]).toHaveLength(2);
    expect([...named(layer.group, 'utility-wires-cast'), ...named(layer.group, 'utility-wires-cast', 'far')]).toHaveLength(2);

    const near = camera(m(20));
    layer.group.update(near);
    // The near line's cones of light drawn (within 140 m), the far line's not (a kilometre off).
    expect(drawnCount(layer.group, 'utility-lamp-beams')).toBeGreaterThan(0);
    expect(drawnCount(layer.group, 'utility-lamp-beams', 'far')).toBe(0);
    // Every insulator of the near line drawn (3 a pole), none of the line a kilometre off (under a pixel).
    expect(drawnCount(layer.group, 'utility-insulators')).toBeGreaterThan(5 * 3);
    expect(drawnCount(layer.group, 'utility-insulators', 'far')).toBe(0);
    // Every wire of the near line drawn (4 spans, 5 wires each: urban poles), each with the template its own span's distance asks: its chords
    // the fewest within a pixel of its sag, creased from 1.5 px wide (`wireLevel`), whatever the block's nearest pole is.
    const scale = new ScreenScale();
    scale.set(near);
    const wires = drawnWires(layer.group, 'near');
    expect(wires).toHaveLength(5 * 4);
    for (const w of wires) {
      const px = scale.atPoint(w.x, w.y, w.z, w.r);
      expect(w.chords).toBe(wireChords(px, w.sag));
      expect(w.creased).toBe(WIRE_WIDTH * px >= 1.5);
    }
    // The far line's: a kilometre off, under a pixel wide: plain strips of few chords.
    for (const w of drawnWires(layer.group, 'far')) {
      expect(w.creased).toBe(false);
      expect(w.chords).toBeLessThanOrEqual(2);
    }
    // Near, the masts drawn.
    expect(drawnCount(layer.group, 'utility-poles')).toBe(5);

    // From far up, everything small gone, the wires faded out, the light the lamps throw still there.
    layer.group.update(camera(m(12_000)));
    for (const name of ['utility-insulators', 'utility-caps', 'utility-wires', 'utility-lamp-lenses']) {
      expect(drawnCount(layer.group, name) + drawnCount(layer.group, name, 'far')).toBe(0);
    }
    expect(drawnCount(layer.group, 'utility-lamp-pools')).toBeGreaterThan(0);
    // Their cones of light faded out whole past 140 m (`scenery.ts` BEAM_FADE): none drawn from up there.
    expect(drawnCount(layer.group, 'utility-lamp-beams') + drawnCount(layer.group, 'utility-lamp-beams', 'far')).toBe(0);
    // A lens lit at night is seen smaller than an unlit one: by its coverage times its brightness.
    layer.group.update(camera(m(1400)));
    const byDay = drawnCount(layer.group, 'utility-lamp-lenses');
    kit.setNight(1);
    layer.group.update(camera(m(1400)));
    const atNight = drawnCount(layer.group, 'utility-lamp-lenses');
    expect(byDay).toBe(0);
    expect(atNight).toBeGreaterThan(0);
    kit.setNight(0);
    // Back close: drawn again.
    layer.group.update(camera(m(20)));
    expect(drawnCount(layer.group, 'utility-insulators')).toBeGreaterThan(0);
    layer.dispose();
  });

  it('draws a line of a kilometre in one block piece by piece: its near poles whole, its far ones coarser, the farthest pieces none', () => {
    const doc = new RoadDoc();
    // 31 poles 30 m apart along x, one block.
    const ids = Array.from({ length: 31 }, (_, i) => doc.addPole({ x: m(30) * i + m(5), y: m(10) }, true).id);
    for (let i = 1; i < ids.length; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
    const net = new Network(doc);
    net.rebuild();
    const layer = buildUtilities(net, () => 0, createSceneryKit());
    // From the street at the line's start, looking down it.
    layer.group.update(camera(m(1.7), -m(5), m(4), m(900)));
    // Far fewer insulators drawn than the line's: the far ones under a pixel (DO NOT draw a kilometre of insulators at the nearest pole's
    // shape), the near ones drawn whole (one draw: their coarser shapes spare too few triangles for one of their own, `DRAW_WORTH`).
    const insulators = drawnCount(layer.group, 'utility-insulators');
    expect(insulators).toBeGreaterThan(0);
    expect(insulators).toBeLessThan(31 * 3);
    // None of the poles 800 m and more down the line: each piece measured where it stands, under a pixel there.
    for (const mesh of named(layer.group, 'utility-insulators')) {
      const a = (mesh as InstancedMesh).instanceMatrix.array;
      for (let i = 0; i < (mesh as InstancedMesh).count; i++) expect(a[i * 16 + 12]!).toBeLessThan(m(800));
    }
    // Its wires: the near spans with more chords than the far ones, each by its own distance; and far fewer triangles than every span's
    // wires at the nearest span's template.
    const wires = drawnWires(layer.group, 'near');
    const chords = wires.map((w) => w.chords);
    expect(Math.max(...chords)).toBeGreaterThan(Math.min(...chords));
    const sent = wires.reduce((sum, w) => sum + w.chords * (w.creased ? 4 : 2), 0);
    expect(sent).toBeLessThan(30 * 5 * Math.max(...chords) * 4 / 2);
    layer.dispose();
  });

  it('measures each piece in front of the eye: a line with every pole behind it draws nothing in colour', () => {
    const doc = twoLines();
    const net = new Network(doc);
    net.rebuild();
    const layer = buildUtilities(net, () => 0, createSceneryKit());
    // 30 m past the near line's last pole (x 140 m), looking on along it: every pole of the line behind the eye.
    const c = new PerspectiveCamera(35, 16 / 9, 0.1, 20_000);
    c.position.set(m(170), m(10), 0);
    c.lookAt(m(600), 0, 0);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    layer.group.update(c);
    // DO NOT take a pole behind the eye for one the eye stands in: its wires were drawn as tubes and its pieces whole.
    for (const name of ['utility-insulators', 'utility-caps', 'utility-wires']) expect(drawnCount(layer.group, name)).toBe(0);
    layer.dispose();
  });

  it('draws the round pieces with fewer sides where their roundness is under a pixel, and whole close up', () => {
    const doc = twoLines();
    const net = new Network(doc);
    net.rebuild();
    const layer = buildUtilities(net, () => 0, createSceneryKit());
    /** The triangles of the finest shape each round piece of the near line is drawn with, from a camera `height` up, `back` behind x 80 m. */
    const seen = (height: number, back: number): number[] => {
      layer.group.update(camera(height, m(80), back));
      return ['utility-caps', 'utility-insulators', 'utility-transformers'].map((name) => finest(layer.group, name));
    };
    // A few metres from a pole: its pieces at their own shape (a cap of 10 sides and both ends, an insulator of 10 and its top, a can of 14 and
    // both ends).
    expect(seen(m(8), m(2))).toEqual([40, 30, 56]);
    // 120 m up: a cap of 4 sides, an insulator of 4, a can of 8, still drawn.
    expect(seen(m(120), m(40))).toEqual([16, 12, 32]);
    layer.dispose();
  });

  it('picks the wires\' template by their sag on the screen, none under the least width drawn', () => {
    // Close, a big sag: the finest strip (8 chords, as many as the tube had segments; its sag 100 px).
    expect(wireLevel(100 / m(1), m(1))).toBe(0);
    // Thinner than the least width drawn: none.
    expect(wireLevel((WIRE_MIN_PIXELS * 0.9) / WIRE_WIDTH, m(1))).toBe(-1);
    // From 1.5 px wide the strip creased between the tube's two faces seen; thinner, plain (half the triangles).
    expect(wireLevel(1.5 / WIRE_WIDTH, m(0.01))).toBe(3);
    expect(wireLevel(1.4 / WIRE_WIDTH, m(0.01))).toBe(7);
    // Thin: as few chords as keep the sag's error under a pixel; a wire under a pixel wide is still drawn (a pixel wide, covering its share).
    const thin = 0.5 / WIRE_WIDTH;
    const level = wireLevel(thin, m(1));
    expect(level).toBeGreaterThan(0);
    expect(wireLevel(thin, m(0.01))).toBeGreaterThanOrEqual(level);
    // The fewest chords: within a pixel of the parabola (a chord of 1/n strays by sag / n^2), and half as many would not be, but at the finest.
    for (const pixels of [0.05, 0.5, 2, 7, 30, 63, 64, 65, 250, 400]) {
      const sag = m(1), n = wireChords(pixels / m(1), sag), error = pixels / (n * n);
      expect(error < 1 || n === 8).toBe(true);
      if (n > 1 && n < 8) expect(pixels / ((n / 2) * (n / 2))).toBeGreaterThanOrEqual(1);
    }
  });
});
