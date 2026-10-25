import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { measureSolids } from '@/lab/catalog/measure';

/** THE CATALOGUE'S HIDDEN TRIANGLES (`lab/catalog/measure.ts` measureSolids): what counts as a solid that hides, and what does not. */

/** Triangles from flat corner lists, unindexed, as one geometry. */
function triangles(...list: (readonly number[])[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(list.flat()), 3));
  return g;
}

/** A box's triangles without those of `drop` (three's face order: +x, -x, +y, -y, +z, -z), unindexed. */
function boxWithout(drop: readonly number[]): BufferGeometry {
  const box = new BoxGeometry(1, 1, 1).toNonIndexed();
  const p = box.getAttribute('position');
  const kept: number[] = [];
  for (let t = 0; t < p.count / 3; t++) if (!drop.includes(Math.floor(t / 2))) for (let k = 0; k < 9; k++) kept.push(p.array[t * 9 + k]!);
  return triangles(kept);
}

/** A small triangle centred at (x, y, z), lying flat (normal +y). */
const small = (x: number, y: number, z: number): number[] => [x - 0.05, y, z - 0.05, x + 0.05, y, z - 0.05, x, y, z + 0.05];

const hiddenOf = (...parts: BufferGeometry[]): number => measureSolids(mergeGeometries(parts) as BufferGeometry)!.hidden;

describe('the catalogue\'s hidden triangles', () => {
  it('counts none behind an open strip arching over them', () => {
    // A leaf: a strip of four steps, up, over and down, open along its edges and its ends.
    const strip: number[] = [];
    const at = (s: number, side: number): number[] => { const t = s / 4; return [t * 1 - 0.5, Math.sin(t * Math.PI) * 0.8, side * 0.2]; };
    for (let s = 0; s < 4; s++) strip.push(...at(s, -1), ...at(s + 1, -1), ...at(s + 1, 1), ...at(s, -1), ...at(s + 1, 1), ...at(s, 1));
    expect(hiddenOf(triangles(strip), triangles(small(0, 0.3, 0)))).toBe(0);
  });

  it('counts a triangle inside a closed box', () => {
    expect(hiddenOf(boxWithout([]), triangles(small(0, 0.1, 0)))).toBe(1);
  });

  it('counts a triangle inside a box open along one plane, its bottom', () => {
    expect(hiddenOf(boxWithout([3]), triangles(small(0, 0.1, 0)))).toBe(1);
  });

  it('does not count a triangle lying on the plane the box is open along', () => {
    expect(hiddenOf(boxWithout([3]), triangles(small(0, -0.5, 0)))).toBe(0);
  });

  it('counts a pair of triangles pressed face to face, as it always did: the second of the two', () => {
    const a = small(3, 0, 0);
    const b = [a[0]!, a[1]!, a[2]!, a[6]!, a[7]!, a[8]!, a[3]!, a[4]!, a[5]!];
    expect(hiddenOf(triangles(a), triangles(b))).toBe(1);
  });
});
