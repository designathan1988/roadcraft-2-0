import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { hiddenTriangles, withoutHidden } from '@render/vehicleHidden';
import { buildCarModel } from '@render/carBody';
import { buildBusModel } from '@render/vehicleModels';
import { archetypeById } from '@sim/vehicles/archetypes';

/** Boxes merged into one part, as the vehicle models merge theirs (indexed, normals per face). */
const boxes = (...list: BufferGeometry[]): BufferGeometry => mergeGeometries(list, false)!;
const box = (sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): BufferGeometry => new BoxGeometry(sx, sy, sz).translate(x, y, z);
const count = (marks: Uint8Array, kind: number): number => marks.reduce((n, m) => n + (m === kind ? 1 : 0), 0);
const triangles = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** THE TRIANGLES NO ONE SEES, PROVEN WITHIN A PART (`vehicleHidden.ts`). */
describe('hidden triangles of a vehicle part', () => {
  it('takes out a box wholly inside another, and nothing of the one around it', () => {
    const marks = hiddenTriangles(boxes(box(1, 1, 1), box(0.2, 0.2, 0.2)), true);
    // The outer box first (12 triangles), the inner one after.
    expect([...marks.subarray(0, 12)].every((m) => m === 0)).toBe(true);
    expect([...marks.subarray(12)].every((m) => m === 2)).toBe(true);
  });

  it('of a box that leaves the other keeps all but its face inside; of one within a millimetre of a face, all but its far face', () => {
    // From x 0.35 to 0.55 through the outer box's face at 0.5: only its face at x 0.35 (two triangles, the box's -x face) lies inside.
    const leaving = hiddenTriangles(boxes(box(1, 1, 1), box(0.2, 0.2, 0.2, 0.45)), true);
    expect(count(leaving, 2)).toBe(2);
    expect([...leaving.subarray(12)].map((m, i) => (m === 2 ? Math.floor(i / 2) : -1)).filter((f) => f >= 0)).toEqual([1, 1]);
    // Its top 0.5 mm under the outer box's top: every face reaching up there kept (MARGIN), the bottom face (-y, the fourth) buried.
    const near = hiddenTriangles(boxes(box(1, 1, 1), box(0.2, 0.2, 0.2, 0, 0.3995)), true);
    expect([...near.subarray(12)].map((m, i) => (m === 2 ? Math.floor(i / 2) : -1)).filter((f) => f >= 0)).toEqual([3, 3]);
  });

  it('takes out a face pressed on a face of a solid and facing into it; keeps one facing the same way', () => {
    // A box sitting on top of another: its bottom face lies on the lower box's top face, facing down into it.
    const marks = hiddenTriangles(boxes(box(1, 1, 1), box(0.4, 0.4, 0.4, 0, 0.7)), true);
    expect(count(marks, 3)).toBe(2);
    // A quad on the lower box's top face, facing up as that face does: drawn over it, kept.
    const quad = new BufferGeometry();
    quad.setAttribute('position', new Float32BufferAttribute([-0.1, 0.5, -0.1, -0.1, 0.5, 0.1, 0.1, 0.5, 0.1, -0.1, 0.5, -0.1, 0.1, 0.5, 0.1, 0.1, 0.5, -0.1], 3));
    quad.computeVertexNormals();
    const solid = box(1, 1, 1).toNonIndexed();
    solid.deleteAttribute('uv');
    expect(hiddenTriangles(mergeGeometries([solid, quad], false)!, true).every((m) => m === 0)).toBe(true);
  });

  it('hides nothing behind an open or an inward-wound solid', () => {
    // Open: the outer box without its top face.
    const open = box(1, 1, 1);
    const index = [...open.getIndex()!.array];
    open.setIndex(index.filter((_, i) => Math.floor(i / 6) !== 2));
    expect(hiddenTriangles(boxes(open, box(0.2, 0.2, 0.2)), true).every((m) => m === 0)).toBe(true);
    // Inward-wound: the outer box turned inside out.
    const inward = box(1, 1, 1);
    const flipped = [...inward.getIndex()!.array];
    for (let i = 0; i < flipped.length; i += 3) [flipped[i + 1], flipped[i + 2]] = [flipped[i + 2]!, flipped[i + 1]!];
    inward.setIndex(flipped);
    expect(hiddenTriangles(boxes(inward, box(0.2, 0.2, 0.2)), true).every((m) => m === 0)).toBe(true);
  });

  it('of glass takes out only the triangles without area', () => {
    const g = boxes(box(1, 1, 1), box(0.2, 0.2, 0.2));
    expect(hiddenTriangles(g, false).every((m) => m === 0)).toBe(true);
    const flat = new BufferGeometry();
    flat.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    expect([...hiddenTriangles(flat, false)]).toEqual([1, 0]);
  });

  it('keeps every vertex and only shortens the index', () => {
    const g = boxes(box(1, 1, 1), box(0.2, 0.2, 0.2));
    const { geometry, hidden } = withoutHidden(g, true);
    expect(hidden.buried).toBe(12);
    expect(geometry.getAttribute('position')).toBe(g.getAttribute('position'));
    expect((geometry.getIndex() as BufferAttribute).count).toBe(36);
    // Nothing hidden: the part itself.
    const alone = box(1, 1, 1);
    expect(withoutHidden(alone, true).geometry).toBe(alone);
  });

  it('on the game models: a car body loses its triangles without area, the bus shell what lies buried in its boxes', () => {
    const shell = buildCarModel(archetypeById('hatch'), 'hatch').shell;
    const marks = hiddenTriangles(shell, true);
    expect(count(marks, 1)).toBeGreaterThan(0);
    const bus = withoutHidden(buildBusModel(archetypeById('bus')).shell, true);
    expect(bus.hidden.buried).toBeGreaterThan(0);
    expect(triangles(bus.geometry)).toBeLessThan(2196);
  });
});
