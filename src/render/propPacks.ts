import { CELL } from '@world/cells';
import type { Pack } from './cellInstances';
import { YAW_POSE } from './instanceRuns';

/** The prop layers' packs of things (`propCells.ts`): a placement cut to the cells a near cell or a far block holds, and the bytes it holds. */

/** A rectangle's things kept to those whose pose stands in the cells `cx0..cx1`, `cy0..cy1` (the world's grid, `propCells.ts` PROP_CELL);
 *  `code` gives each one's eighth float (none: as placed). */
export function within(packs: ReadonlyMap<number, Pack>, cx0: number, cy0: number, cx1: number, cy1: number,
  code?: (cx: number, cy: number) => number): Map<number, Pack> {
  const stride = YAW_POSE.stride, out = new Map<number, Pack>();
  for (const [kind, pack] of packs) {
    const keep: number[] = [];
    const codes: number[] = [];
    for (let i = 0; i < pack.count; i++) {
      // Its cell from the pose's own floats (float32): the near cells and the far blocks file a thing by the same numbers, and the GPU reads them.
      const cx = Math.floor(pack.data[i * stride]! / CELL), cy = Math.floor(-pack.data[i * stride + 2]! / CELL);
      if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
      keep.push(i);
      if (code) codes.push(code(cx, cy));
    }
    if (keep.length === 0) continue;
    if (keep.length === pack.count && !code) { out.set(kind, pack); continue; }
    const data = new Float32Array(keep.length * stride), scales = new Float32Array(keep.length);
    const colours = pack.colours ? new Float32Array(keep.length * 3) : null;
    keep.forEach((i, j) => {
      data.set(pack.data.subarray(i * stride, (i + 1) * stride), j * stride);
      if (code) data[j * stride + 7] = codes[j]!;
      scales[j] = pack.scales[i]!;
      if (colours) colours.set(pack.colours!.subarray(i * 3, i * 3 + 3), j * 3);
    });
    out.set(kind, { data, colours, scales, count: keep.length });
  }
  return out;
}

/** The bytes a cell's packs hold on the CPU. */
export const packBytes = (packs: ReadonlyMap<number, Pack>): number => {
  let n = 0;
  for (const p of packs.values()) n += p.data.byteLength + p.scales.byteLength + (p.colours?.byteLength ?? 0) + 64;
  return n;
};
