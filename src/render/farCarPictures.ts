import { Color, FrontSide, Vector2, Vector4, type BufferGeometry } from 'three';
import { TRAFFIC, type Archetype } from '@sim/vehicles/archetypes';
import { carStyleOf, carStylesFor } from './carBody';
import { SET_MODELS, createImpostors, type PictureModel, type PlantImpostors } from './plantImpostors';

/**
 * THE FAR TRAFFIC'S CARS AS THE TRAFFIC'S OWN MODELS (`densityCars.ts`): each body the traffic drives (`TRAFFIC`: the cars of every style
 * a class is drawn as, the lorries) taken from 8 x 8 directions over the upper hemi-octahedron as the near props are (`createImpostors`),
 * from its far model (`VehicleModel.far`: its body, dark glass and wheels, the one the near traffic draws a car of a few pixels with), at
 * full resolution; a car drawn as its picture, painted as the near traffic paints it (its class's palette times the model's own colours).
 * DO NOT draw a far car as a box: the far traffic was two boxes in seven colours (2026-10-26), a town of toy blocks past the micro window.
 */

/** Device pixels long under which a car is not drawn, near (`agents.ts`) or far (`densityCars.ts`): the owner's ladder, an object's picture
 *  from 1.5 px and nothing under it. */
export const LEAST_CAR_PX = 1.5;

/** A body the near traffic draws (`agents.ts` carParts): its key (`bodyKey`), its class, and its far model. */
export interface FarCarBody {
  readonly key: string;
  readonly archetype: Archetype;
  readonly far: BufferGeometry;
}

/** The far cars' pictures, which one a car is, and its paint. */
export interface FarCarPictures {
  readonly set: PlantImpostors;
  /** Each model's sphere (its centre in the model's frame, its radius) and its block on the atlas, as the far cars' shader reads them by index. */
  readonly spheres: readonly Vector4[];
  readonly blocks: readonly Vector2[];
  /** Each model's length, model units: what its size on the screen is measured by. */
  readonly lengths: readonly number[];
  /** The model a car of this seed is (an index of `spheres`), or -1 for a kind with no picture (a two-wheeler: its rider is not in it). */
  modelOf(seed: number): number;
  /** The paint of a car of this seed, of model `model`, in the working colour space (three's linear): `out`. */
  paintOf(seed: number, model: number, out: Color): Color;
  dispose(): void;
}

/** A car's two independent draws (0..1) from its seed: the model, then the paint (a 32-bit mix, the same on any machine). */
export function seedDraw(seed: number, salt: number): number {
  let h = Math.imul((seed | 0) ^ salt, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4_294_967_296;
}
const MODEL_SALT = 0x9e3779b9;
const PAINT_SALT = 0x27d4eb2f;

/** A body's key as the near traffic files it (`agents.ts` bodyKey): a car by its class and style, a lorry or a bus by its class. */
const keyOf = (a: Archetype, style: string | null): string => (style === null ? `${a.id}:${a.shape}` : `${a.id}:${style}`);

/** The share of a class's cars drawn as each of its styles (`carStyleOf` over a whole number of its variants: one in three sedans an estate, one in four SUVs a pick-up). */
function styleShares(a: Archetype): Map<string, number> {
  const shares = new Map<string, number>();
  const turns = 12;
  for (let v = 0; v < turns; v++) {
    const style = carStyleOf(a, v);
    shares.set(style, (shares.get(style) ?? 0) + 1 / turns);
  }
  return shares;
}

/**
 * The pictures of `bodies` (the near traffic's, `AgentMeshes.farBodies`), taken at the next `takeWaitingPictures`; null with none (the specs).
 * Their look the near paint's (`agents.ts` paint: roughness, metalness, the sky's share).
 */
export function createFarCarPictures(bodies: readonly FarCarBody[]): FarCarPictures | null {
  const byKey = new Map(bodies.map((body) => [body.key, body] as const));
  /** The kinds the traffic drives, each with its share of it and its model (-1: none pictured). */
  const kinds: { readonly share: number; readonly model: number; readonly palette: readonly Color[] }[] = [];
  const models: PictureModel[] = [];
  const lengths: number[] = [];
  const modelKeys: string[] = [];
  const modelFor = (body: FarCarBody | undefined): number => {
    if (!body) return -1;
    const at = modelKeys.indexOf(body.key);
    if (at >= 0) return at;
    if (models.length >= SET_MODELS) throw new Error(`farCarPictures: more than ${SET_MODELS} bodies in the traffic (a set per group)`);
    models.push({ parts: [{ geometry: body.far, normals: 'vertex', side: FrontSide, casts: false }] });
    modelKeys.push(body.key);
    if (!body.far.boundingBox) body.far.computeBoundingBox();
    const box = body.far.boundingBox!;
    lengths.push(box.max.x - box.min.x);
    return models.length - 1;
  };
  for (const [a, weight] of TRAFFIC) {
    const palette = a.palette.map((hex) => new Color(hex));
    if (a.shape === 'car') {
      const shares = styleShares(a);
      for (const style of carStylesFor(a)) kinds.push({ share: weight * (shares.get(style) ?? 0), model: modelFor(byKey.get(keyOf(a, style))), palette });
    } else if (a.shape === 'truck' || a.shape === 'bus') {
      kinds.push({ share: weight, model: modelFor(byKey.get(keyOf(a, null))), palette });
    } else {
      // A two-wheeler: its rider is no part of its far model, and a bike riding by itself is not drawn.
      kinds.push({ share: weight, model: -1, palette });
    }
  }
  if (!models.length) return null;
  const total = kinds.reduce((sum, kind) => sum + kind.share, 0);
  const upTo: number[] = [];
  let sum = 0;
  for (const kind of kinds) { sum += kind.share / total; upTo.push(sum); }
  const set = createImpostors(models, { roughness: 0.38, metalness: 0.28, envMapIntensity: 1.35, wind: null, thin: false }, 'far-cars');
  const paletteOf = new Map<number, readonly Color[]>();
  for (const kind of kinds) if (kind.model >= 0 && !paletteOf.has(kind.model)) paletteOf.set(kind.model, kind.palette);
  const kindOf = (seed: number): number => {
    const pick = seedDraw(seed, MODEL_SALT);
    for (let k = 0; k < upTo.length; k++) if (pick < upTo[k]!) return k;
    return upTo.length - 1;
  };
  return {
    set,
    spheres: set.spheres.map((s) => new Vector4(s.centre.x, s.centre.y, s.centre.z, s.radius)),
    blocks: models.map((_, k) => new Vector2(k % set.blocks.x, Math.floor(k / set.blocks.x))),
    lengths,
    modelOf: (seed) => kinds[kindOf(seed)]!.model,
    paintOf(seed, model, out) {
      const palette = paletteOf.get(model);
      if (!palette?.length) return out.setRGB(1, 1, 1);
      return out.copy(palette[Math.min(palette.length - 1, Math.floor(seedDraw(seed, PAINT_SALT) * palette.length))]!);
    },
    dispose() {
      set.dispose();
    },
  };
}
