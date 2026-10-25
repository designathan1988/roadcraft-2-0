import { BoxGeometry, BufferAttribute, BufferGeometry, Color, Matrix4 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cylinderWith } from './mesh/cylinder';
import { m } from '@world/units';

/** A TRAFFIC SIGNAL HEAD'S SHAPES (`signals.ts` draws them): its sizes, its parts and where each sits, near and far. */

/** Signal heads at life size, like everything else in the scene */
const SIGNAL_SCALE = 1;
const u = (metres: number): number => m(metres) * SIGNAL_SCALE;

export const POST_HEIGHT = u(6.2);
const POST_RADIUS = u(0.09);
export const ARM_LENGTH = u(3.5);
const ARM_RADIUS = u(0.06);
const HEAD_HEIGHT = u(1.05);
export const HEAD_WIDTH = u(0.42);
const HEAD_DEPTH = u(0.3);
const LAMP_RADIUS = u(0.15);
const VISOR_DEPTH = u(0.18);
export const HEAD_CENTRE = u(5.5);
/** Where the arm meets the post. */
export const ARM_HEIGHT = POST_HEIGHT - u(0.3);
/** Vertical spacing between lens centres. */
const LAMP_PITCH = HEAD_HEIGHT * 0.3;
/** A lens's depth: the rim its far level (the disc's face alone) leaves out; the halo's rim is thinner. */
export const LENS_DEPTH = u(0.06);
const VISOR_WIDTH = LAMP_RADIUS * 2.5;
const VISOR_HEIGHT = u(0.06);
/** A visor's diagonal: under a pixel across, it leaves the drawing (`partCells.ts` `levelAt`, the parts' rule). */
export const VISOR_REACH = Math.hypot(VISOR_WIDTH, VISOR_HEIGHT, VISOR_DEPTH);

export type Lamp = 'red' | 'amber' | 'green';
export const LAMPS: readonly Lamp[] = ['red', 'amber', 'green'];
/** Which way each lens cluster looks, along the housing's local Z. */
export const FACES = [1, -1] as const;

/** A head's shapes and where each sits in it, relative to the foot of its post: the post, the arm and the housing (the frame), the lenses,
 *  the lit lenses' halos and the visors; each lens's, halo's and visor's place by lamp and face. What `createSignalHeads` draws, and what a
 *  sheet of the head draws (`signalHeadModel`). */
export function signalHeadShapes(): {
  readonly postGeometry: BufferGeometry; readonly armGeometry: BufferGeometry; readonly housingGeometry: BufferGeometry;
  readonly lensGeometry: BufferGeometry; readonly haloGeometry: BufferGeometry; readonly visorGeometry: BufferGeometry;
  readonly lensFarGeometry: BufferGeometry; readonly haloFarGeometry: BufferGeometry;
  readonly POST: Matrix4; readonly ARM: Matrix4; readonly BOX: Matrix4;
  readonly lens: Record<Lamp, Matrix4[]>; readonly halos: Record<Lamp, Matrix4[]>; readonly visors: Matrix4[];
} {
  // The post's foot stands on the footway (its cap faces the ground); the arm's ends lie inside the post (wider) and inside the housing.
  const postGeometry = cylinderWith(POST_RADIUS, POST_RADIUS, POST_HEIGHT, 8, { top: true, bottom: false });
  const armGeometry = cylinderWith(ARM_RADIUS, ARM_RADIUS, ARM_LENGTH, 8, { top: false, bottom: false });
  const housingGeometry = new BoxGeometry(HEAD_WIDTH, HEAD_HEIGHT, HEAD_DEPTH);
  // A flat disc rather than a sphere; its back against the housing's face never shows (the face -1 lenses are turned half round, `lens`).
  const lensGeometry = cylinderWith(LAMP_RADIUS, LAMP_RADIUS, LENS_DEPTH, 12, { top: true, bottom: false }).rotateX(
    Math.PI / 2,
  );
  // The far levels: the face alone, the very triangles of the near one's (12 of 36 for a lens, 12 of 48 for a halo), drawn once the rim spans under a pixel.
  const lensFarGeometry = cylinderWith(LAMP_RADIUS, LAMP_RADIUS, LENS_DEPTH, 12, { top: true, bottom: false, side: false }).rotateX(Math.PI / 2);
  // DO NOT make it wider than the housing's face: a disc past its sides hung off the head, a lens out of its can (look 21-street-zoom, 2026-10-18).
  const HALO_RADIUS = Math.min(LAMP_RADIUS * 1.8, HEAD_WIDTH / 2 - u(0.015));
  // Closed at its back too: it stands 1.3 cm off the housing's face (`halos`, z * 0.96), and seen along the face through that gap an open
  // back showed the sky through the halo (the face audit, `src/lab/propHoleSheet.ts` "signal housing", 2026-10-25).
  const haloGeometry = cylinderWith(HALO_RADIUS, HALO_RADIUS, u(0.02), 12, { top: true, bottom: true })
    .rotateX(Math.PI / 2);
  const haloFarGeometry = cylinderWith(HALO_RADIUS, HALO_RADIUS, u(0.02), 12, { top: true, bottom: false, side: false }).rotateX(Math.PI / 2);
  const visorGeometry = new BoxGeometry(VISOR_WIDTH, VISOR_HEIGHT, VISOR_DEPTH);

  // Where each part sits in its head, relative to the foot of the post.
  const at = (x: number, y: number, z: number, rotateZ = 0): Matrix4 =>
    new Matrix4().makeRotationZ(rotateZ).setPosition(x, y, z);
  const POST = at(0, POST_HEIGHT / 2, 0);
  const ARM = at(ARM_LENGTH / 2, ARM_HEIGHT, 0, -Math.PI / 2);
  const BOX = at(ARM_LENGTH, HEAD_CENTRE, 0);
  const lens: Record<Lamp, Matrix4[]> = { red: [], amber: [], green: [] };
  const halos: Record<Lamp, Matrix4[]> = { red: [], amber: [], green: [] };
  const visors: Matrix4[] = [];
  /** A lens or a halo, its open back towards the housing: the face -1 ones turned half round (the disc is the same turned). */
  const facing = (y: number, z: number, face: number): Matrix4 =>
    face < 0 ? new Matrix4().makeRotationY(Math.PI).setPosition(ARM_LENGTH, y, z) : at(ARM_LENGTH, y, z);
  LAMPS.forEach((name, index) => {
    const y = HEAD_CENTRE + LAMP_PITCH * (1 - index);
    for (const face of FACES) {
      const z = (HEAD_DEPTH / 2 + u(0.03)) * face;
      halos[name].push(facing(y, z * 0.96, face));
      lens[name].push(facing(y, z, face));
      // A hood over each lens.
      visors.push(at(ARM_LENGTH, y + LAMP_RADIUS * 1.15, z + (VISOR_DEPTH / 2) * face));
    }
  });

  return { postGeometry, armGeometry, housingGeometry, lensGeometry, haloGeometry, visorGeometry, lensFarGeometry, haloFarGeometry, POST, ARM, BOX, lens, halos, visors };
}

/** One head at the origin as one geometry, its parts placed as `createSignalHeads` places them (`signalHeadShapes`), the lamp `lit` with its
 *  halos: what a sheet of the head looks at (its faces, `src/lab/propHoleSheet.ts`). Vertex colours: the frame's, the visors', each lens's. */
export function signalHeadModel(lit: Lamp | null): BufferGeometry {
  const shapes = signalHeadShapes();
  const parts: BufferGeometry[] = [];
  const put = (shape: BufferGeometry, at: Matrix4, colour: number): void => {
    const g = (shape.index ? shape.toNonIndexed() : shape.clone()).applyMatrix4(at);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const c = new Color(colour), n = g.getAttribute('position').count;
    g.setAttribute('color', new BufferAttribute(new Float32Array(n * 3).map((_, i) => (i % 3 === 0 ? c.r : i % 3 === 1 ? c.g : c.b)), 3));
    parts.push(g);
  };
  put(shapes.postGeometry, shapes.POST, 0x2b302d);
  put(shapes.armGeometry, shapes.ARM, 0x2b302d);
  put(shapes.housingGeometry, shapes.BOX, 0x15191a);
  for (const visor of shapes.visors) put(shapes.visorGeometry, visor, 0x15191a);
  const lensColour: Record<Lamp, number> = { red: 0x8d221c, amber: 0x8a6410, green: 0x1d6b33 };
  const litColour: Record<Lamp, number> = { red: 0xff4034, amber: 0xffb219, green: 0x3bf06a };
  for (const name of LAMPS) {
    for (const at of shapes.lens[name]) put(shapes.lensGeometry, at, name === lit ? litColour[name] : lensColour[name]);
    if (name === lit) for (const at of shapes.halos[name]) put(shapes.haloGeometry, at, litColour[name]);
  }
  const merged = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}
