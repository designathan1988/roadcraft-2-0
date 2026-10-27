import type { Color } from 'three';
import { Rng } from '@core/rng';
import { followPieces } from '@world/buildings/elements';
import { localToWorld } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import type { Pack } from './cellInstances';
import { BUSH_KINDS, TREE_SPECIES, type TreeSpecies, foliageTint } from './plantKinds';
import { NEVER_NEAR, YAW_STRIDE } from './poseCodes';

/** WHERE THE BUILDINGS' GARDENS' PLANTS STAND, by kind, from the buildings and the ground alone: placed on the page (`gardens.ts`) or by a job off it (`gardenCell.worker.ts`), the same numbers either way. */

/** A plant of a building's garden, in the world: a tree, a shrub, a run of hedge or a flower bed. */
export interface GardenPlant {
  readonly kind: 'tree' | 'shrub' | 'hedge' | 'flowers';
  readonly x: number;
  readonly y: number;
  /** Ground height under it. */
  readonly z: number;
  /** Size, world units: along (w), across (d) and height (h); `yaw` the way `w` runs. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly yaw: number;
  readonly seed: number;
  /** A tree's species, when it is not a garden's mix (a painted forest's). */
  readonly species?: TreeSpecies;
  /** A shrub that never flowers (a wood's understorey). */
  readonly plain?: boolean;
}

/** How far past a building's bounds its garden's placings may stand: a hedge's clipped piece, a flower bed's clump (both within its element, rounded). */
export const GARDEN_SLACK = m(2);

/** The plants of every building's garden, in the world, on the ground they stand on. */
export function gardenPlants(all: Iterable<Building>, groundAt: (x: number, y: number) => number): GardenPlant[] {
  const out: GardenPlant[] = [];
  for (const b of all) {
    for (const el of b.elements ?? []) {
      if (el.kind !== 'tree' && el.kind !== 'shrub' && el.kind !== 'hedge' && el.kind !== 'flowers') continue;
      // `w` runs across the way the element faces.
      const yaw = (b.rotation ?? 0) + (el.facing === 1 || el.facing === 3 ? Math.PI / 2 : 0) + (el.angle ?? 0);
      // A long hedge in steps, each on the ground under it, not one box at its middle's height.
      const kind = el.kind;
      followPieces(el).forEach((piece, k) => {
        const at = localToWorld(b, piece.x, piece.y);
        out.push({ kind, x: at.x, y: at.y, z: groundAt(at.x, at.y), w: piece.w, d: piece.d, h: piece.h, yaw,
          seed: ((b.id * 7919 + el.id * 104729 + k * 31) % 100003) / 100003 });
      });
    }
  }
  return out;
}

interface Placement { x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number; tint?: Color }

/** A garden tree's species: mostly broadleaf, some conifers, now and then a flowering ipê. */
function gardenSpecies(roll: number): TreeSpecies {
  if (roll < 0.42) return 'broadleaf';
  if (roll < 0.62) return 'broadleafTall';
  if (roll < 0.8) return 'conifer';
  return roll < 0.9 ? 'ipeYellow' : 'ipePink';
}

/** A kind of plant's number, in the order of the gardens' kinds: the trees by species, then the bushes. */
const treeKind = (species: TreeSpecies): number => TREE_SPECIES.indexOf(species);
const bushKind = (kind: string): number => TREE_SPECIES.length + BUSH_KINDS.indexOf(kind as (typeof BUSH_KINDS)[number]);

/** One garden's plants placed, by plant kind (`KIND_KEYS`): each one's pose (DO NOT keep 16-float matrices of every plant of the town), tint and largest scale. */
export function gardenPack(list: readonly GardenPlant[]): ReadonlyMap<number, Pack> {
  const trees = new Map<TreeSpecies, Placement[]>(TREE_SPECIES.map((s) => [s, []]));
  const bushes = new Map<string, Placement[]>(BUSH_KINDS.map((k) => [k, []]));
  for (const p of list) {
    const rng = new Rng(Math.floor(p.seed * 0xffffff) ^ 0x5eed);
    switch (p.kind) {
      case 'tree': {
        const spread = 0.82 + rng.float() * 0.3;
        const roll = rng.float();
        (trees.get(p.species ?? gardenSpecies(roll)) as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: p.h * spread, sy: p.h, sz: p.h * spread * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'shrub': {
        // The geometry is about 1.5 across for 1 tall, kept in the bush's own proportions
        const across = (Math.min(p.w, p.d) / 1.5) * 0.8;
        const tall = Math.min(p.h, across * 1.3);
        const wide = Math.max(across, tall / 1.3);
        (bushes.get(!p.plain && rng.float() < 0.25 ? 'bushFlowering' : 'bush') as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: wide, sy: tall, sz: wide * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'hedge': {
        // Clipped pieces along its run, overlapping so it reads as one.
        const n = Math.max(1, Math.round(p.w / Math.max(m(2.2), p.h * 1.5)));
        const step = p.w / n;
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        const tint = foliageTint(rng);
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) * step - p.w / 2;
          (bushes.get('hedge') as Placement[]).push({
            x: p.x + cx * t, y: p.y + cy * t, z: p.z - m(0.05), yaw: p.yaw,
            sx: (step / 1.9) * 1.25, sy: p.h, sz: p.d / 0.9, tint,
          });
        }
        break;
      }
      case 'flowers': {
        // A bed of low flowering clumps.
        const n = Math.max(2, Math.round((p.w * p.d) / (m(0.7) * m(0.7))));
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        for (let i = 0; i < Math.min(n, 24); i++) {
          const u = (rng.float() - 0.5) * p.w * 0.85, v = (rng.float() - 0.5) * p.d * 0.85;
          const h = m(0.35) + rng.float() * m(0.25);
          (bushes.get('bushFlowering') as Placement[]).push({
            x: p.x + cx * u - cy * v, y: p.y + cy * u + cx * v, z: p.z + m(0.12), yaw: rng.float() * Math.PI * 2,
            sx: h * 1.1, sy: h, sz: h * 1.1,
          });
        }
        break;
      }
    }
  }
  const out = new Map<number, Pack>();
  const pack = (kind: number, placed: readonly Placement[]): void => {
    if (!placed.length) return;
    const poses = new Float32Array(placed.length * YAW_STRIDE);
    const scales = new Float32Array(placed.length);
    let colours: Float32Array | null = null;
    placed.forEach((placement, index) => {
      const at = index * YAW_STRIDE;
      poses[at] = placement.x; poses[at + 1] = placement.z; poses[at + 2] = -placement.y; poses[at + 3] = placement.yaw;
      poses[at + 4] = placement.sx; poses[at + 5] = placement.sy; poses[at + 6] = placement.sz;
      poses[at + 7] = NEVER_NEAR;
      scales[index] = Math.max(placement.sx, placement.sy, placement.sz);
      if (placement.tint) {
        colours ??= new Float32Array(placed.length * 3).fill(1);
        placement.tint.toArray(colours, index * 3);
      }
    });
    out.set(kind, { data: poses, colours, scales, count: placed.length });
  };
  for (const [species, placed] of trees) pack(treeKind(species), placed);
  for (const [kind, placed] of bushes) pack(bushKind(kind), placed);
  return out;
}

/** The plants of the gardens of `buildings` (those standing about a rectangle, `GARDEN_SLACK` round it), placed on the ground they stand on. */
export function gardenPacksOf(buildings: Iterable<Building>, groundAt: (x: number, y: number) => number): ReadonlyMap<number, Pack> {
  const list: GardenPlant[] = [];
  for (const b of buildings) for (const plant of gardenPlants([b], groundAt)) list.push(plant);
  return gardenPack(list);
}
