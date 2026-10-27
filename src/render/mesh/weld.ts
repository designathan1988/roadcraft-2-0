import { type BufferAttribute, type BufferGeometry, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/** Three's `mergeVertices` (BufferGeometryUtils, r186): the same keys, the same vertex order, the same result, hashed on numbers in a table instead of a string a vertex (most of a vehicle's levels, 2026-10-18). */
export function weldGeometry(geometry: BufferGeometry, tolerance = 1e-4): BufferGeometry {
  const names = Object.keys(geometry.attributes);
  const attrs = names.map((name) => geometry.getAttribute(name) as BufferAttribute);
  // Morph targets and interleaved attributes: three's own, as they were.
  if (Object.keys(geometry.morphAttributes).length > 0 || attrs.some((a) => (a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute)) {
    return mergeVertices(geometry, tolerance);
  }
  tolerance = Math.max(tolerance, Number.EPSILON);
  // Three's truncation: decimal places from the tolerance, half of it added.
  const multiplier = Math.pow(10, Math.log10(1 / tolerance));
  const additive = tolerance * 0.5 * multiplier;
  const index = geometry.getIndex();
  const count = index ? index.count : geometry.getAttribute('position').count;
  let width = 0;
  for (const a of attrs) width += a.itemSize;
  const key = new Float64Array(width);
  // The keys of the vertices kept, `width` a vertex, in the order they were kept.
  const keys = new Float64Array(count * width);
  let size = 16;
  while (size < count * 2) size *= 2;
  const table = new Int32Array(size).fill(-1);
  const outs = attrs.map((a) => {
    const Typed = a.array.constructor as new (n: number) => BufferAttribute['array'];
    const Attr = a.constructor as new (array: BufferAttribute['array'], itemSize: number, normalized: boolean) => BufferAttribute;
    return new Attr(new Typed(a.count * a.itemSize), a.itemSize, a.normalized);
  });
  const remap = new Uint32Array(count);
  let next = 0;
  for (let i = 0; i < count; i++) {
    const v = index ? index.getX(i) : i;
    let h = 0, c = 0;
    for (const a of attrs) {
      for (let k = 0; k < a.itemSize; k++) {
        const q = Math.trunc(a.getComponent(v, k) * multiplier + additive);
        key[c++] = q;
        h = Math.imul(h ^ (q | 0), 0x9e3779b1) ^ Math.imul((q / 4294967296) | 0, 0x85ebca6b);
      }
    }
    h ^= h >>> 15;
    let slot = h & (size - 1), found = -1;
    for (;;) {
      const e = table[slot]!;
      if (e < 0) break;
      if (sameKey(keys, e * width, key, width)) { found = e; break; }
      slot = (slot + 1) & (size - 1);
    }
    if (found < 0) {
      found = next++;
      table[slot] = found;
      keys.set(key, found * width);
      for (let j = 0; j < attrs.length; j++) {
        const a = attrs[j]!, out = outs[j]!;
        for (let k = 0; k < a.itemSize; k++) out.setComponent(found, k, a.getComponent(v, k));
      }
    }
    remap[i] = found;
  }
  const result = geometry.clone();
  for (let j = 0; j < names.length; j++) {
    const out = outs[j]!;
    const Attr = out.constructor as new (array: BufferAttribute['array'], itemSize: number, normalized: boolean) => BufferAttribute;
    result.setAttribute(names[j]!, new Attr(out.array.slice(0, next * out.itemSize), out.itemSize, out.normalized));
  }
  // The triangles the weld closed up (two corners one vertex, every attribute the same) left out: they draw no pixel and cost their
  // corners' work at every instance. DO NOT keep them: the cars' shells carried a tenth of their triangles so (1,192 of the sedan's
  // 11,352, the model audit, 2026-10-27). DO NOT leave out a triangle for its area alone: a card drawn by its shader (its corners at one
  // point, told apart by another attribute) has none. Each group keeps the triangles it had less those it lost.
  const kept = count % 3 === 0 ? openTriangles(remap, result) : remap;
  result.setIndex(next - 1 >= 65535 ? new Uint32BufferAttribute(kept, 1) : new Uint16BufferAttribute(kept, 1));
  return result;
}

/** The index without its closed triangles (`weldGeometry`); `geometry`'s groups moved to the triangles they keep. */
function openTriangles(index: Uint32Array, geometry: BufferGeometry): Uint32Array {
  const out = new Uint32Array(index.length);
  /** How many index entries were kept before each triangle: the groups' new starts and counts. */
  const before = new Uint32Array(index.length / 3 + 1);
  let n = 0;
  for (let t = 0; t < index.length; t += 3) {
    before[t / 3] = n;
    const a = index[t]!, b = index[t + 1]!, c = index[t + 2]!;
    if (a === b || b === c || a === c) continue;
    out[n++] = a; out[n++] = b; out[n++] = c;
  }
  before[index.length / 3] = n;
  const groups = geometry.groups.map((g) => {
    const from = Math.min(index.length, g.start), to = Math.min(index.length, g.start + g.count);
    const start = before[Math.floor(from / 3)]!, end = before[Math.ceil(to / 3)]!;
    return { start, count: end - start, materialIndex: g.materialIndex ?? 0 };
  });
  geometry.clearGroups();
  for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  return out.slice(0, n);
}

/** Whether two keys are the same; NaN equal to NaN, as three's strings are. */
function sameKey(keys: Float64Array, at: number, key: Float64Array, width: number): boolean {
  for (let c = 0; c < width; c++) {
    const a = keys[at + c]!, b = key[c]!;
    if (a !== b && !(a !== a && b !== b)) return false;
  }
  return true;
}

