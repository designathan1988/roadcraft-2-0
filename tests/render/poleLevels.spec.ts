import { describe, expect, it } from 'vitest';
import { type InstancedBufferGeometry, type InstancedMesh, type Mesh, type Object3D, PerspectiveCamera } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { createSceneryKit } from '@render/scenery';
import { buildUtilities } from '@render/poleLayer';
import { WIRE_MIN_PIXELS, WIRE_WIDTH, wireChords, wireLevel } from '@render/utilities';
import { m } from '@world/units';

/** THE POLE LAYER AS THE CAMERA SEES IT: one mesh a part a block of the plane (not a world cell, not the whole layer), each block by its own nearest pole: pieces under a pixel not drawn, wires coarser and gone far away */

/** Two lines of poles in cells a kilometre apart. */
function twoLines(): RoadDoc {
  const doc = new RoadDoc();
  for (const y of [0, m(1000)]) {
    const ids = Array.from({ length: 5 }, (_, i) => doc.addPole({ x: m(20) + i * m(30), y }, i % 2 === 0).id);
    for (let i = 1; i < ids.length; i++) doc.addPoleSpan(ids[i - 1]!, ids[i]!);
  }
  return doc;
}

/** A camera at (x, y) in world terms, `height` up, looking at the near line; three's z is world -y. */
function camera(height: number): PerspectiveCamera {
  const c = new PerspectiveCamera(35, 16 / 9, 0.1, 20_000);
  c.position.set(m(80), height, m(40));
  c.lookAt(m(80), 0, 0);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

/** The meshes of a name, nearest line first (by their bounds' world y). */
function named(root: Object3D, name: string): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => { if (o.name === name) out.push(o as Mesh); });
  const y = (o: Mesh): number => -((o as InstancedMesh).boundingSphere ?? o.geometry.boundingSphere)!.center.z;
  return out.sort((a, b) => y(a) - y(b));
}

/** Whether the colour pass draws a mesh: shown, and an instanced part with instances to draw (a part under a pixel keeps its instances for the sun's cascades and draws none in colour, `poleLayer.ts` PartStore). */
const drawn = (mesh: Mesh): boolean => mesh.visible && (!(mesh as InstancedMesh).isInstancedMesh || (mesh as InstancedMesh).count > 0);

describe('the pole layer as the camera sees it', () => {
  it('draws each block by its own nearest pole: every piece near, the small ones gone and the wires faded far away', () => {
    const doc = twoLines();
    const net = new Network(doc);
    net.rebuild();
    const kit = createSceneryKit();
    const layer = buildUtilities(net, () => 0, kit);
    // A mesh a part a block of the plane: the two lines a kilometre apart stand in two (one mesh a part for the whole layer was never culled, and drew every wire of a city at its nearest pole's detail, 2026-10-20).
    expect(named(layer.group, 'utility-insulators')).toHaveLength(2);
    expect(named(layer.group, 'utility-wires')).toHaveLength(2);

    layer.group.update(camera(m(20)));
    const [nearInsulators, farInsulators] = named(layer.group, 'utility-insulators');
    // The near line's cones of light drawn (within 140 m), the far line's not (a kilometre off).
    expect(named(layer.group, 'utility-lamp-beams').map(drawn)).toEqual([true, false]);
    expect(drawn(nearInsulators!)).toBe(true);
    // The line a kilometre off, by its own nearest pole: its insulators under a pixel, not drawn.
    expect(drawn(farInsulators!)).toBe(false);
    const [wires, farWires] = named(layer.group, 'utility-wires');
    // Near, a strip facing the eye over every span of the near line, of the chords its nearest wire needs: 40 m off, ~86 px a unit (half the
    // screen 1080 px over tan 17.5 deg), a 30 m span's 0.54 m of sag 46 px, within a pixel at 8 chords (46 / 64), not at 4: 4 triangles a
    // chord, creased between the tube's two faces seen (the tube drew 8 * 24). The far line's wires by a coarser template, their own.
    expect(drawn(wires!)).toBe(true);
    expect((wires!.geometry as InstancedBufferGeometry).index!.count).toBe(8 * 12);
    expect((wires!.geometry as InstancedBufferGeometry).instanceCount).toBe(9 * 4);
    expect((farWires!.geometry as InstancedBufferGeometry).index!.count).toBeLessThan(8 * 12);
    // Near, the finest mast.
    const masts = named(layer.group, 'utility-poles')[0]!;
    expect(drawn(masts)).toBe(true);
    expect(masts.geometry.index!.count).toBeGreaterThan(0);

    // From far up, everything small gone, the wires faded out, the light the lamps throw still there.
    layer.group.update(camera(m(12_000)));
    for (const name of ['utility-insulators', 'utility-caps', 'utility-wires', 'utility-lamp-lenses']) {
      for (const mesh of named(layer.group, name)) expect(drawn(mesh)).toBe(false);
    }
    for (const mesh of named(layer.group, 'utility-lamp-pools')) expect(drawn(mesh)).toBe(true);
    // Their cones of light faded out whole past 140 m (`scenery.ts` BEAM_FADE): none drawn from up there.
    for (const mesh of named(layer.group, 'utility-lamp-beams')) expect(drawn(mesh)).toBe(false);
    // A lens lit at night is seen smaller than an unlit one: by its coverage times its brightness.
    layer.group.update(camera(m(1400)));
    const byDay = named(layer.group, 'utility-lamp-lenses').map(drawn);
    kit.setNight(1);
    layer.group.update(camera(m(1400)));
    const atNight = named(layer.group, 'utility-lamp-lenses').map(drawn);
    // The near line's lenses.
    expect(byDay[0]).toBe(false);
    expect(atNight[0]).toBe(true);
    kit.setNight(0);
    // Back close: drawn again.
    layer.group.update(camera(m(20)));
    expect(drawn(named(layer.group, 'utility-insulators')[0]!)).toBe(true);
    layer.dispose();
  });

  it('measures a block by its poles in front of the eye: one with every pole behind it draws nothing in colour', () => {
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
    // DO NOT take a pole behind the eye for one the eye stands in: its block's wires were drawn as tubes and its pieces whole.
    for (const name of ['utility-insulators', 'utility-caps', 'utility-wires']) expect(drawn(named(layer.group, name)[0]!)).toBe(false);
    layer.dispose();
  });

  it('draws the round pieces with fewer sides where their roundness is under a pixel, and whole close up', () => {
    const doc = twoLines();
    const net = new Network(doc);
    net.rebuild();
    const layer = buildUtilities(net, () => 0, createSceneryKit());
    /** The triangles each round piece of the near line is drawn with, from a camera `height` up and `back` behind the pole at x 80 m. */
    const seen = (height: number, back: number): number[] => {
      const c = new PerspectiveCamera(35, 16 / 9, 0.1, 20_000);
      c.position.set(m(80), height, back);
      c.lookAt(m(80), 0, 0);
      c.updateMatrixWorld();
      c.updateProjectionMatrix();
      layer.group.update(c);
      return ['utility-caps', 'utility-insulators', 'utility-transformers'].map((name) => {
        const mesh = named(layer.group, name)[0]!;
        return drawn(mesh) ? mesh.geometry.index!.count / 3 : 0;
      });
    };
    // A few metres from a pole: each at its own shape (a cap of 10 sides and both ends, an insulator of 10 and its top, a can of 14 and both ends).
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
