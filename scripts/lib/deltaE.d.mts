// Types of `deltaE.mjs` for the specs that import it.
export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];
export function labOf(rgb: Rgb): [number, number, number];
export function deltaE2000Lab(p: Lab, q: Lab): number;
export function deltaE2000(p: Rgb, q: Rgb): number;
