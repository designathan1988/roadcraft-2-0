import { Color } from 'three';
import type { Rng } from '@core/rng';

/** THE PLANTS' KINDS AND THEIR TINT, with nothing of their models: what a job off the page places plants by (`gardenCell.worker.ts`) without the models' modules. */

export type TreeSpecies = 'broadleaf' | 'broadleafTall' | 'conifer' | 'ipeYellow' | 'ipePink';
export const TREE_SPECIES: readonly TreeSpecies[] = ['broadleaf', 'broadleafTall', 'conifer', 'ipeYellow', 'ipePink'];

export type BushKind = 'bush' | 'bushFlowering' | 'hedge';
export const BUSH_KINDS: readonly BushKind[] = ['bush', 'bushFlowering', 'hedge'];

/** A near-white multiplier, so no two plants of one species are identical. */
export function foliageTint(rng: Rng): Color {
  const warm = rng.float();
  return new Color(0.9 + warm * 0.18, 0.93 + rng.float() * 0.12, 0.86 + (1 - warm) * 0.14);
}
