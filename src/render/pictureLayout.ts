import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import type { PicturePart } from './pictureParts';

/** A PICTURE SET'S LAYOUT (`plantImpostors.ts` createImpostors, `buildings/partPictures.ts`): each model's sphere, the atlas's blocks and each
 *  model's quad on it. */

export interface Picture {
  readonly centre: Vector3;
  readonly radius: number;
}

/** A model's sphere: round the box of its parts, its leaf cards reaching out from their centres. */
export function pictureOf(model: { readonly parts: readonly PicturePart[] }): Picture {
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const grow = (g: BufferGeometry, reach: number): void => {
    const p = g.getAttribute('position');
    for (let v = 0; v < p.count; v++) {
      min.set(Math.min(min.x, p.getX(v) - reach), Math.min(min.y, p.getY(v) - reach), Math.min(min.z, p.getZ(v) - reach));
      max.set(Math.max(max.x, p.getX(v) + reach), Math.max(max.y, p.getY(v) + reach), Math.max(max.z, p.getZ(v) + reach));
    }
  };
  for (const part of model.parts) {
    let corner = 0;
    if (part.billboard) {
      const c = part.geometry.getAttribute('aCorner');
      for (let v = 0; v < c.count; v++) corner = Math.max(corner, Math.hypot(c.getX(v), c.getY(v)));
    }
    grow(part.geometry, corner);
  }
  // The sphere round the box: every view of the model fits its picture.
  return { centre: min.clone().add(max).multiplyScalar(0.5), radius: max.clone().sub(min).length() / 2 };
}

/** Blocks across and down for `n` models: the fewest texels, no side over 4 blocks (2,048 texels). */
export function layoutOf(n: number): { x: number; y: number } {
  let best = { x: 4, y: Math.ceil(n / 4) };
  for (let x = 4; x >= 1; x--) {
    const y = Math.ceil(n / x);
    if (y <= 4 && x * y < best.x * best.y) best = { x, y };
  }
  return best;
}

/** A model's quad (`createImpostors`, `buildings/partPictures.ts`): four corners, its sphere and its block on an atlas `blocks` across in its
 *  attributes; `measure` (model units across, `PictureModel.measure`): a still set's, its half read by its far batches' band (`vertexMain`). */
export function pictureQuad(picture: Picture, k: number, blocks: { readonly x: number }, measure: number | null): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  const sphere = [picture.centre.x, picture.centre.y, picture.centre.z, picture.radius];
  g.setAttribute('aSphere', new BufferAttribute(new Float32Array([...sphere, ...sphere, ...sphere, ...sphere]), 4));
  const at = [k % blocks.x, Math.floor(k / blocks.x)];
  g.setAttribute('aBlock', new BufferAttribute(new Float32Array([...at, ...at, ...at, ...at]), 2));
  if (measure !== null) g.setAttribute('aMeasure', new BufferAttribute(new Float32Array(4).fill(measure / 2), 1));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  // The model's own sphere: what the instances are culled by.
  g.boundingSphere = new Sphere(picture.centre.clone(), picture.radius);
  return g;
}
