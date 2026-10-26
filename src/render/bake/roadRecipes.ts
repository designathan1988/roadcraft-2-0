import { m } from '@world/units';
import { type SurfaceRecipe, fbm, makeNoise } from '../mesh/textureBaker';

/** The street surfaces' texture recipes (`materials.ts`), baked at build time (`scripts/vite/surface-bake-plugin.ts`) */

export const ASPHALT_TILE = m(10.4);
/** Texels a side of each street surface's maps. */
const ASPHALT_SIZE = 512;
const FOOTWAY_SIZE = 1024;
const KERB_SIZE = 256;
const VERGE_SIZE = 512;
const DECK_SIZE = 512;
const ASPHALT_BASE = 0.215;
const RAISED_ASPHALT_BASE = 0.245;
export const FOOTWAY_TILE = m(7.2);
export const KERB_TILE = m(3.2);
export const VERGE_TILE = m(8.8);
export const DECK_TILE = m(8);

/** A small integer hash, for per-slab variation that is stable and tiles. */
function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/** 0 under `a`, 1 over `b`, the Hermite curve between (GLSL's smoothstep). */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The asphalt; `raised` its paler tone for raised crossings, whose colour alone is baked (it shares the road's normal and roughness). */
function asphaltRecipe(raised: boolean): SurfaceRecipe {
  const grain = makeNoise(0x51ed);
  const macro = makeNoise(0x9a17);
  const patch = makeNoise(0x2b64);
  const oil = makeNoise(0x6d05);
  const size = ASPHALT_SIZE;
  return {
    size,
    worldSize: ASPHALT_TILE,
    relief: 1.2,
    shade: (x, y, out) => {
      const u = x / size;
      const v = y / size;
      // Aggregate at the macro scale: kept LOW in contrast, because it is what gets magnified at close zoom.
      const chips = fbm(grain, u * 128, v * 128, 128, 3);
      // Wear and repair patches: slow, wide, low contrast.
      const wear = fbm(macro, u * 6, v * 6, 6, 4);
      const repair = fbm(patch, u * 3 + 11, v * 3 + 7, 3, 2);
      // Drip stains down the middle of a lane, where engines stand.
      const stain = fbm(oil, u * 14, v * 3, 14, 3);
      const drip = stain > 0.66 ? (stain - 0.66) * 0.12 : 0;
      // Exposed stones: light flecks of aggregate in the dark binder.
      const stone = fbm(grain, u * 420 + 3, v * 420 + 9, 420, 1);
      const flecks = stone > 0.74 ? (stone - 0.74) * 0.5 : stone < 0.2 ? -0.02 : 0;
      // The repairs fade in over a band of the noise. DO NOT cut them at one value, nor lay trench rectangles in the tile: the texture repeats
      // every `ASPHALT_TILE` on every street, and their hard edges drew a lattice of dark squares and pale blots over the city, diamonds on a
      // road at 45 degrees (the owner: the roads' texture looked strange, 2026-10-26).
      const repaired = smoothstep(0.66, 0.84, repair);
      const tone = raised
        ? RAISED_ASPHALT_BASE +
          (chips - 0.5) * 0.03 +
          (wear - 0.5) * 0.032 +
          repaired * 0.018 -
          drip
        : ASPHALT_BASE +
          (chips - 0.5) * 0.055 +
          flecks +
          (wear - 0.5) * 0.04 +
          repaired * 0.022 -
          drip;
      out.r = tone;
      out.g = tone * 1.01;
      out.b = tone * 1.05;
      // Only the aggregate is relief.
      out.h = chips;
      // Polished wheel tracks are smoother than the rest of the lane, over a band of the wear as the repairs.
      out.rough = 0.9 - smoothstep(0.56, 0.7, wear) * 0.09 - chips * 0.05 - drip * 2;
    },
  };
}

/** The footway: interlocking concrete pavers in basketweave (it was large precast slabs; the player found them ugly). */
function footwayRecipe(): SurfaceRecipe {
  const grain = makeNoise(0x77c1);
  const stain = makeNoise(0x1d3f);
  const blot = makeNoise(0x5e2d);
  const size = FOOTWAY_SIZE;
  /** Twelve courses per tile: 7.2 m / 12 = 0.6 m slabs. */
  /** A paver's short side in texels: 16, about 11 cm, dividing the tile exactly so it repeats seamlessly. */
  const PAVER = 16;
  /** Chamfer width in texels. */
  const bevel = 2;
  return {
    size,
    worldSize: FOOTWAY_TILE,
    // Low relief: a joint is drawn by the grime settled in it, the same on both sides.
    relief: 1.4,
    shade: (x, y, out) => {
      // Grey interlocking concrete pavers in running bond, as most new Brazilian pavements are laid
      const u = x / size;
      const v = y / size;
      const w = PAVER;
      const row = Math.floor(y / w);
      const shift = row % 2 === 0 ? 0 : w;
      const sx = (x + shift) % size;
      const col = Math.floor(sx / (2 * w));
      const ex = Math.min(sx % (2 * w), 2 * w - (sx % (2 * w)));
      const ey = Math.min(y % w, w - (y % w));
      const edge = Math.min(ex, ey);
      const face = Math.min(1, Math.max(0, (edge - 0.6) / bevel));
      const chamfer = face * face * (3 - 2 * face);
      const id = cellHash(col, row, 0x5a1b);
      const blockTone = (id - 0.5) * 0.07;
      const speck = fbm(grain, u * 260, v * 260, 260, 3);
      const dirt = fbm(stain, u * 3, v * 3, 3, 4);
      const spot = fbm(blot, u * 30, v * 30, 30, 2);
      const mark = spot > 0.7 ? (spot - 0.7) * 1.2 : 0;
      const worn = Math.max(0, 1 - Math.abs(v - 0.5) * 2.6) * 0.04;
      const tone = 0.54 + blockTone + (speck - 0.5) * 0.08 - (dirt - 0.5) * 0.14 - mark * 0.22 + worn;
      const moss = Math.max(0, dirt - 0.55) * 0.5;
      const jr = 0.28 - moss * 0.05, jg = 0.28 + moss * 0.04, jb = 0.25 - moss * 0.05;
      const sand = 1 - chamfer;
      out.r = tone * 1.0 * chamfer + jr * sand;
      out.g = tone * 0.995 * chamfer + jg * sand;
      out.b = tone * 0.975 * chamfer + jb * sand;
      out.h = 0.15 + chamfer * (0.7 + speck * 0.12);
      out.rough = 0.92 - speck * 0.05 + sand * 0.05;
    },
  };
}

/** The kerb: precast concrete, smooth, a shade lighter and cooler than the footway so the kerb line reads as its own edge */
function kerbRecipe(): SurfaceRecipe {
  const grain = makeNoise(0x4aa9);
  const cloud = makeNoise(0x9131);
  const size = KERB_SIZE;
  const unit = size / 3;
  return {
    size,
    worldSize: KERB_TILE,
    relief: 0.9,
    shade: (x, y, out) => {
      const u = x / size;
      const v = y / size;
      const fine = fbm(grain, u * 60, v * 60, 60, 2);
      const mottle = fbm(cloud, u * 6, v * 6, 6, 3);
      // A joint between units: a soft narrow groove, darker, never paler.
      const j = Math.min(x % unit, unit - (x % unit));
      const joint = j < 1.6 ? 1 - j / 1.6 : 0;
      const unitTone = cellHash(Math.floor(x / unit), 0, 0x77aa);
      // Precast concrete kerb (a guia): paler than the pavers, smooth, with a dark band of road grime where it meets the gutter
      const across = y / size;
      const grime = Math.max(0, 1 - across * 2.2) * 0.22 * (0.7 + mottle * 0.6);
      const scuff = fbm(cloud, u * 2, v * 40, 2, 2) > 0.7 ? 0.06 : 0;
      const tone = 0.68 + (unitTone - 0.5) * 0.06 + (fine - 0.5) * 0.05 + (mottle - 0.5) * 0.08 - grime - scuff - joint * 0.25;
      out.r = tone * 1.0;
      out.g = tone * 0.99;
      out.b = tone * 0.97;
      out.h = 0.6 + fine * 0.1 - joint * 0.3;
      out.rough = 0.86 - fine * 0.04;
    },
  };
}

function vergeRecipe(): SurfaceRecipe {
  const blades = makeNoise(0x6b21);
  const clumps = makeNoise(0xa30d);
  const size = VERGE_SIZE;
  return {
    size,
    worldSize: VERGE_TILE,
    relief: 1.2,
    shade: (x, y, out) => {
      const u = x / size;
      const v = y / size;
      const fine = fbm(blades, u * 150, v * 150, 150, 2);
      const clump = fbm(clumps, u * 9, v * 9, 9, 4);
      const dry = clump > 0.62 ? (clump - 0.62) * 2.4 : 0;
      // The fine term is kept gentle for the same reason as the asphalt's: the blades are the detail layer's.
      out.r = 0.13 + fine * 0.06 + dry * 0.28 + clump * 0.04;
      out.g = 0.205 + fine * 0.08 + clump * 0.09 + dry * 0.18;
      out.b = 0.078 + fine * 0.04 + dry * 0.08;
      out.h = fine * 0.5 + clump * 0.5;
      out.rough = 0.98;
    },
  };
}

function deckRecipe(): SurfaceRecipe {
  const grain = makeNoise(0xcc41);
  const streak = makeNoise(0x3e90);
  const size = DECK_SIZE;
  return {
    size,
    worldSize: DECK_TILE,
    relief: 2.4,
    shade: (x, y, out) => {
      const u = x / size;
      const v = y / size;
      const speck = fbm(grain, u * 80, v * 80, 80, 3);
      // Vertical weathering runs, the signature of an exposed concrete face.
      const run = fbm(streak, u * 30, v * 2.5, 30, 3);
      const form = y % (size / 4) < 2 ? 1 : 0;
      const tone = 0.66 + (speck - 0.5) * 0.08 - Math.max(0, run - 0.58) * 0.28 - form * 0.09;
      out.r = tone;
      out.g = tone * 0.995;
      out.b = tone * 0.97;
      out.h = form ? 0.2 : 0.5 + speck * 0.5;
      out.rough = 0.9;
    },
  };
}

/** Every street surface by its key (`asphalt-raised` its colour only read: it shares the road's normal and roughness, ROAD_RELIEF_LAYERS). */
export function roadRecipes(): readonly { readonly key: string; readonly recipe: SurfaceRecipe }[] {
  return [
    { key: 'asphalt', recipe: asphaltRecipe(false) },
    { key: 'asphalt-raised', recipe: asphaltRecipe(true) },
    { key: 'footway', recipe: footwayRecipe() },
    { key: 'kerb', recipe: kerbRecipe() },
    { key: 'verge', recipe: vergeRecipe() },
    { key: 'deck', recipe: deckRecipe() },
  ];
}

/**
 * The street surfaces as one material draws them all (`mesh/roadEdges.ts` applyRoadSurface: one draw a block where a surface took one each): their
 * colours in one texture array, a layer a surface (the raised crossings' asphalt beside the road's), their normals and their roughness in another
 * (every surface's normal, then every surface's roughness), each smaller surface repeated in its layer (`bake/catalogue.ts` tiledTexels: its uv shrunk
 * by as much reads the same texels, at the same mip level, as its own texture did); the footway, twice their size, in textures of its own (its
 * colour, and its normal and roughness as two layers). Three samplers where a surface's own maps took three each.
 */
export const ROAD_COLOUR_LAYERS = ['asphalt', 'asphalt-raised', 'kerb', 'verge', 'deck'] as const;
export const ROAD_RELIEF_LAYERS = ['asphalt', 'kerb', 'verge', 'deck'] as const;
/** The close-zoom layer's families the street surfaces read, in one array: their colours, then their normals (`bake/detailRecipes.ts`). */
export const ROAD_DETAIL_LAYERS = ['asphalt', 'concrete', 'grass'] as const;
/** Texels a side of each street surface's maps (the recipes' own), and of the arrays' layers: the largest of the surfaces they hold. */
export const ROAD_SURFACE_SIZE: Readonly<Record<'asphalt' | 'asphalt-raised' | 'footway' | 'kerb' | 'verge' | 'deck', number>> = {
  asphalt: ASPHALT_SIZE, 'asphalt-raised': ASPHALT_SIZE, footway: FOOTWAY_SIZE, kerb: KERB_SIZE, verge: VERGE_SIZE, deck: DECK_SIZE,
};
export const ROAD_LAYER_SIZE = Math.max(...ROAD_COLOUR_LAYERS.map((key) => ROAD_SURFACE_SIZE[key]));
