import { m } from '@world/units';
import type { PartKind } from './chunk';
import { FACADE_PROP_KINDS } from './facadeProps';
import { SHELL_PART_KINDS } from './shellParts';

/**
 * THE KINDS OF A BUILDING'S PARTS AND HOW A CELL DRAWS THEM, apart from the kit that makes their models (`kit.ts`) and the layer that draws the
 * cells (`layerCells.ts`). DO NOT define them there: the cells' jobs read them (`cellWork.ts`), and the jobs' results are kept between sessions
 * under a fingerprint of every file the jobs import (`cook-plugin.ts` `__CELL_WORK_HASH__`). Through the kit and the layer that fingerprint took
 * in the plants' cover, the view's cells and every picture set, and an edit of any of them threw a 10 km city's kept masses, far levels and slices
 * away: the reopened city made them all again, its page writing them back for minutes (one F7 profile, 2026-10-26).
 */

// Frozen tables, not state (`eslint-rules/no-module-state.js`).
export const PART_KINDS: readonly PartKind[] = [
  'glass',
  'frame',
  'concrete',
  'door',
  'shutter',
  'railing',
  'roofRailing',
  'awning',
  'column',
  'glassDark',
  'water',
  'lamp',
  'wash',
  'fin',
  'louvre',
  'glassRail',
  'brise',
  ...FACADE_PROP_KINDS,
  ...SHELL_PART_KINDS,
];

/** The lantern beside a front door: width, height and depth out of the wall; its gap from the door's edge. */
export const PORCH_LAMP = { w: m(0.16), h: m(0.26), d: m(0.12), gap: m(0.4) } as const;

/** The parts drawn with the cell's shells, one batch a cell: window panes (each with its room's light) and pool water, their single level two triangles. */
export const COARSE_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['glass', 'glassDark', 'water']));
/** Every other part, filed by sub-cell and drawn by the error on the screen (`partCells.ts`). */
export const DETAIL_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set(PART_KINDS.filter((kind) => !COARSE_PARTS.has(kind))));
