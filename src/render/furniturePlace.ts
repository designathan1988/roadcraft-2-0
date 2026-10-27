import { Color } from 'three';
import { Rng } from '@core/rng';
import { angleOf } from '@core/vec2';
import type { SegmentId } from '@world/ids';
import type { LandscapeItem } from '@world/landscape';
import type { Network } from '@world/network';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { furnitureOf } from '@world/streetFurniture';
import { m } from '@world/units';
import { LAMP_BEAM_RADIUS, LAMP_HEIGHT, LAMP_OUTREACH, LAMP_POOL_RADIUS, POOL_ALONG } from './lampMeasures';
import { BUSH_KINDS, type BushKind, TREE_SPECIES, type TreeSpecies, foliageTint } from './plantKinds';

/** WHERE A PLACED ITEM OF STREET FURNITURE STANDS (`furniturePlace`): the item, its road and the road's heights - on the page (`streetFurnitureLayer.ts`)
 *  or by a job with the roads round it (`furnitureCell.worker.ts`), the same numbers either way. */

/** Street trees are pollarded smaller than a tree in open ground. */
const STREET_TREE_MIN = m(6.5);
const STREET_TREE_RANGE = m(3);

/** The furniture's stores, in the order the scenery's meshes were made. */
export const FURNITURE_MODELS = ['lamp', 'lens', 'pool', 'beam', 'bin', 'bench', 'hydrant', 'postbox', 'phone', 'drain', 'treePit'] as const;
type FurnitureModel = (typeof FURNITURE_MODELS)[number];
const MODEL = Object.fromEntries(FURNITURE_MODELS.map((model, i) => [model, i])) as Record<FurnitureModel, number>;

/** One instance of a placed item: its store, where, how turned and sized, its tint. */
export interface Placed {
  readonly store: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly tint: Color | null;
  /** A plant: its full height, times its growth; `sx`, `sy`, `sz` are then times the height it has. 0: it does not grow. */
  readonly h: number;
}

/** A placed item as it stands: its instances, where it is (its filing), when it was planted. */
export interface FurniturePlace {
  readonly x: number;
  readonly y: number;
  readonly planted: number | undefined;
  readonly placed: readonly Placed[];
}

/** Each street plant's store (`furnitureStores`): the props', then the trees' by species, then the bushes'. */
const treeStore = (species: TreeSpecies): number => FURNITURE_MODELS.length + TREE_SPECIES.indexOf(species);
const bushStore = (kind: BushKind): number => FURNITURE_MODELS.length + TREE_SPECIES.length + BUSH_KINDS.indexOf(kind);

/** Picks a species for a street tree: mostly planes, some flowering ipês. */
export function streetSpecies(roll: number): TreeSpecies {
  if (roll < 0.55) return 'broadleafTall';
  if (roll < 0.78) return 'broadleaf';
  return roll < 0.89 ? 'ipeYellow' : 'ipePink';
}

/** Where a lamp's lens stands on its post (`SceneryKit.lens`). */
export interface LampLens { readonly reach: number; readonly height: number }

/** The items the furniture draws (not the long grass, the signs, the street names). */
export const isFurniture = (item: LandscapeItem): boolean => item.kind !== 'meadow' && item.kind !== 'sign' && item.kind !== 'streetname';

/** The roads' heights a placing reads: a road's own deck under a point (`RoadElevation.onSegment`, `roadField.ts`). */
export interface RoadHeights {
  onSegment(segment: SegmentId, x: number, y: number): number;
}

/** Where a placed item's instances stand, or undefined when it draws nothing. */
export function furniturePlace(net: Network, elevation: RoadHeights, placed: LandscapeItem, lens: LampLens): FurniturePlace | undefined {
  const item = furnitureOf(net, placed);
  if (!item) return undefined;
  const out: Placed[] = [];
  const put = (store: number, p: Omit<Placed, 'store' | 'tint' | 'h'> & { tint?: Color; h?: number }): void => {
    out.push({ store, x: p.x, y: p.y, z: p.z, yaw: p.yaw, sx: p.sx, sy: p.sy, sz: p.sz, tint: p.tint ?? null, h: p.h ?? 0 });
  };
  // On the item's OWN road.
  const base = elevation.onSegment(item.segment, item.x, item.y) + footwayRiseAt(net, item.x, item.y);
  // Local +X of a lamp reaches over the road; local -Z of a bench, a post box or a hydrant turns its back on the road.
  const inward = angleOf({ x: -item.outward.x, y: -item.outward.y });
  const facing = angleOf({ x: item.outward.y, y: -item.outward.x });
  const at = { x: item.x, y: item.y, z: base, sx: 1, sy: 1, sz: 1 };
  switch (item.kind) {
    case 'lamp': {
      put(MODEL.lamp, { ...at, yaw: inward });
      put(MODEL.lens, { ...at, yaw: inward });
      // The light falls over the road and the footway behind the lamp: across, the carriageway's width
      const road = net.ribbons.get(item.segment)?.road;
      const across = Math.max(LAMP_POOL_RADIUS, (road ? road.width : m(7)) * 0.55 + m(2.5));
      const centre = Math.max(LAMP_OUTREACH * 0.85, across - m(3));
      put(MODEL.pool, { x: item.x - item.outward.x * centre, y: item.y - item.outward.y * centre, z: base + m(0.012),
        yaw: inward, sx: across, sy: 1, sz: LAMP_HEIGHT * POOL_ALONG });
      // And the cone it is lit by, from the lens down to the road under it.
      put(MODEL.beam, { x: item.x - item.outward.x * lens.reach, y: item.y - item.outward.y * lens.reach, z: base + lens.height,
        yaw: 0, sx: LAMP_BEAM_RADIUS, sy: lens.height + FOOTWAY_RISE, sz: LAMP_BEAM_RADIUS });
      break;
    }
    case 'bin':
      put(MODEL.bin, { ...at, yaw: item.seed * Math.PI * 2 });
      break;
    case 'bench': {
      // Its seat faces where the layout says somebody sitting looks.
      const faces = item.faces ?? { x: -item.outward.x, y: -item.outward.y };
      put(MODEL.bench, { ...at, yaw: angleOf({ x: -faces.y, y: faces.x }) });
      break;
    }
    case 'postbox':
    case 'hydrant':
    case 'phone':
    case 'drain':
      // Built facing -Z; turned so the phone's shell opens to the footway and the drain's grate lies in the gutter on the road
      put(MODEL[item.kind], { ...at, yaw: facing + Math.PI });
      break;
    case 'streetTree': {
      put(MODEL.treePit, { ...at, yaw: angleOf(item.along) });
      // Planted young, it grows to its full height over a few days.
      const rng = new Rng(Math.floor(item.seed * 0xffffff));
      const species = streetSpecies(rng.float());
      const tree = { x: item.x, y: item.y, z: base + m(0.03), yaw: rng.float() * Math.PI * 2,
        sx: 0.85 + rng.float() * 0.2, sy: 1, sz: 0.85 + rng.float() * 0.2, tint: foliageTint(rng), h: STREET_TREE_MIN + item.seed * STREET_TREE_RANGE };
      put(treeStore(species), tree);
      break;
    }
    case 'shrub': {
      const rng = new Rng(Math.floor(item.seed * 0xffffff));
      const h = m(0.8) + rng.float() * m(0.4);
      const kind: BushKind = rng.float() < 0.4 ? 'bushFlowering' : 'bush';
      const shrub = { x: item.x, y: item.y, z: base - m(0.05), yaw: rng.float() * Math.PI * 2, sx: 1.05, sy: 1, sz: 1.05, tint: foliageTint(rng), h };
      put(bushStore(kind), shrub);
      break;
    }
  }
  return { x: placed.x, y: placed.y, planted: item.planted, placed: out };
}

/** Numbers of a place (`packPlaces`): x, y, planted (NaN: not a planting), its instances' count; of an instance: its store, x, y, z, yaw, sx, sy, sz, its tint (r, g, b; NaN: none), h. */
const PLACE_HEAD = 4, PLACED_STRIDE = 12;

/** Places as numbers, to hand from a job to the page (`unpackPlaces` reads them back as they were). */
export function packPlaces(places: readonly FurniturePlace[]): Float64Array {
  let n = 0;
  for (const p of places) n += PLACE_HEAD + p.placed.length * PLACED_STRIDE;
  const out = new Float64Array(n);
  let at = 0;
  for (const p of places) {
    out[at++] = p.x; out[at++] = p.y; out[at++] = p.planted ?? Number.NaN; out[at++] = p.placed.length;
    for (const q of p.placed) {
      out[at++] = q.store; out[at++] = q.x; out[at++] = q.y; out[at++] = q.z; out[at++] = q.yaw; out[at++] = q.sx; out[at++] = q.sy; out[at++] = q.sz;
      out[at++] = q.tint ? q.tint.r : Number.NaN; out[at++] = q.tint ? q.tint.g : Number.NaN; out[at++] = q.tint ? q.tint.b : Number.NaN;
      out[at++] = q.h;
    }
  }
  return out;
}

/** The places `packPlaces` wrote. */
export function unpackPlaces(data: Float64Array): FurniturePlace[] {
  const out: FurniturePlace[] = [];
  let at = 0;
  while (at < data.length) {
    const x = data[at++]!, y = data[at++]!, planted = data[at++]!, n = data[at++]!;
    const placed: Placed[] = [];
    for (let k = 0; k < n; k++) {
      const store = data[at++]!, px = data[at++]!, py = data[at++]!, pz = data[at++]!, yaw = data[at++]!, sx = data[at++]!, sy = data[at++]!, sz = data[at++]!;
      const r = data[at++]!, g = data[at++]!, b = data[at++]!, h = data[at++]!;
      placed.push({ store, x: px, y: py, z: pz, yaw, sx, sy, sz, tint: Number.isNaN(r) ? null : new Color(r, g, b), h });
    }
    out.push({ x, y, planted: Number.isNaN(planted) ? undefined : planted, placed });
  }
  return out;
}
