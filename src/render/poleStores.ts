import {
  type BufferAttribute,
  type Camera,
  type InstancedBufferGeometry,
  type InterleavedBuffer,
  InstancedInterleavedBuffer,
  InstancedMesh,
  Mesh,
  type Object3D,
  type OrthographicCamera,
  Sphere,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';

import type { PoleId, SpanId } from '@world/ids';
import { m } from '@world/units';
import type { UtilitySpan } from '@world/utilities';
import { type PartBounds, type PartShape, WIRE_BLOCK, type WireBounds, emptyBox, growPart, growWires, partShape } from './poleBake';
import { castBySize } from './shadowCasters';
import {
  type Placement,
  type PolePartSpec,
  SPAN_WIRES,
  type SpanEnd,
  WIRE_HALF_WIDTH,
  WIRE_STRIDE,
  WIRE_TEMPLATE_COUNT,
  WIRE_WIDTH,
  releaseWireGeometry,
  spanWires,
  wireClampPixels,
  wireGeometry,
  wireLevel,
  wireParts,
  wireScreen,
  wireTemplate,
  wireTemplateOf,
  writePlacement,
} from './utilities';

/**
 * THE POLE LAYER'S STORES (`poleLayer.ts`, `poleCells.ts`): a block's pieces of each part and its spans' wires, EACH DRAWN BY ITS OWN SIZE ON
 * THE SCREEN - a piece under a pixel not sent, a piece's shape and a span's template the coarsest within a pixel at its own distance. DO NOT
 * choose them for a whole block by its nearest pole again: a block is a kilometre, and a pole a kilometre off drew its insulators, caps and
 * wires as the nearest did (the wire sheet's street view, 2026-10-25: insulators 8,160 triangles, wires 11,980 sent of which 2,184 had an
 * area). Each store's whole set of pieces is drawn into the sun's cascades alone (the shadow as it was, chosen by the cascade's texel,
 * `castBySize`); the colour pass draws one mesh a shape, each holding the pieces at that shape.
 */

/** The screen the layers were last drawn on and the sun's shadow map: what a pixel and a shadow texel measure. */
export const screen = {
  /** Half the drawing buffer's height, pixels; until first drawn, a tall screen's (more detail, never less). */
  halfHeight: 1080,
  /** The shadow camera and its map's width, from the shadow pass (`noteShadow`); null until a piece is cast. */
  shadow: null as OrthographicCamera | null,
  shadowWidth: 0,
};
const drawingBuffer = new Vector2();
/** Before three draws one of the layer's meshes: the drawing buffer's height, the screen's own pixels. */
function noteScreen(renderer: WebGLRenderer): void {
  renderer.getDrawingBufferSize(drawingBuffer);
  if (drawingBuffer.y > 0) screen.halfHeight = drawingBuffer.y / 2;
}
/** Before three draws a layer's wires: the screen (`noteScreen`), and the least width a wire is drawn on its target (`wireClampPixels`): by
 *  the samples a pixel of it holds (a canvas asked for antialiasing holds four). */
function noteWireScreen(renderer: WebGLRenderer): void {
  noteScreen(renderer);
  const target = renderer.getRenderTarget();
  wireScreen.uWireClamp.value = wireClampPixels(target ? target.samples : renderer.getContext().getContextAttributes()?.antialias ? 4 : 0);
}
/** Before three casts one of the layer's meshes into a shadow map: the camera of that map (`WebGLShadowMap.renderObject`). */
function noteShadow(renderer: WebGLRenderer, _object: Object3D, _camera: Camera, shadowCamera: Camera): void {
  const map = renderer.getRenderTarget();
  if ((shadowCamera as OrthographicCamera).isOrthographicCamera && map) {
    screen.shadow = shadowCamera as OrthographicCamera;
    screen.shadowWidth = map.width;
  }
}

/** What a world unit measures on the screen where a bounding sphere comes nearest the eye, and a texel of the sun's shadow. */
export class ScreenScale {
  private readonly eye = new Vector3();
  private readonly ahead = new Vector3();
  private pixels = 0;
  private perspective = true;
  /** A shadow texel, world units; 0 while unknown (every piece casts). */
  texel = 0;

  /** The camera three is about to draw with. */
  set(camera: Camera): void {
    const p = camera.projectionMatrix.elements, w = camera.matrixWorld.elements;
    // Pixels a unit spans at depth 1 in perspective, anywhere in the orthographic view.
    this.pixels = screen.halfHeight * p[5]!;
    this.perspective = p[11] !== 0;
    this.eye.set(w[12]!, w[13]!, w[14]!);
    this.ahead.set(-w[8]!, -w[9]!, -w[10]!).normalize();
    const sun = screen.shadow;
    this.texel = sun && screen.shadowWidth > 0 ? (sun.right - sun.left) / sun.zoom / screen.shadowWidth : 0;
  }

  /** Pixels a unit spans at the sphere's nearest depth: Infinity when the eye is level with it or inside it, 0 when all of it is behind the eye. */
  at(sphere: Sphere): number {
    return this.atPoint(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
  }

  /** Pixels a unit spans at a box's nearest corner (three's axes: x0, y0, z0, x1, y1, z1): Infinity when the eye is in it or level with it, 0
   *  when all of it is behind the eye. */
  atBox(box: ArrayLike<number>): number {
    if (!this.perspective) return this.pixels;
    if (!(box[0]! <= box[3]!)) return 0;
    const e = this.eye, a = this.ahead;
    if (e.x >= box[0]! && e.x <= box[3]! && e.y >= box[1]! && e.y <= box[4]! && e.z >= box[2]! && e.z <= box[5]!) return Infinity;
    // Its farthest corner along the view behind the eye: none of it is drawn (`atPoint`).
    const far = ((a.x >= 0 ? box[3]! : box[0]!) - e.x) * a.x + ((a.y >= 0 ? box[4]! : box[1]!) - e.y) * a.y + ((a.z >= 0 ? box[5]! : box[2]!) - e.z) * a.z;
    if (far < 0) return 0;
    // The corner nearest along the view: each axis's end the view's direction comes to first.
    const depth = ((a.x >= 0 ? box[0]! : box[3]!) - e.x) * a.x + ((a.y >= 0 ? box[1]! : box[4]!) - e.y) * a.y + ((a.z >= 0 ? box[2]! : box[5]!) - e.z) * a.z;
    return depth > 1e-3 ? this.pixels / depth : Infinity;
  }

  /** Whether all of a sphere stands deeper than `distance` along the view: in perspective only (a view from above fades nothing). */
  past(x: number, y: number, z: number, radius: number, distance: number): boolean {
    if (!this.perspective) return false;
    const e = this.eye, a = this.ahead;
    return (x - e.x) * a.x + (y - e.y) * a.y + (z - e.z) * a.z - radius > distance;
  }

  atPoint(x: number, y: number, z: number, radius: number): number {
    if (!this.perspective) return this.pixels;
    const e = this.eye, a = this.ahead;
    const along = (x - e.x) * a.x + (y - e.y) * a.y + (z - e.z) * a.z;
    // All of it behind the eye: nothing of it on the screen (0, its block measured by its other poles). DO NOT take it for one the eye stands
    // in: a pole behind the camera made its whole block of a kilometre the nearest there is - every wire of it a tube, every insulator whole,
    // at the district's view (the F7 audit: 97 k triangles of wires in 4 draws, 2026-10-25).
    if (along + radius < 0) return 0;
    const depth = along - radius;
    return depth > 1e-3 ? this.pixels / depth : Infinity;
  }
}

/** A piece's shape when it is not drawn in colour: under a pixel, behind the eye, a light faded out. */
const HIDDEN = 255;
/** The band round a pixel a piece's shape and showing are held by, the props' ladder's (`cellInstances.ts` HYSTERESIS): a piece at the edge
 *  does not flicker from one to the other as the view moves a little. */
const BAND = 0.15;
/** The triangles a shape's own draw must spare to be drawn apart: a draw call costs the CPU more than a few hundred triangles cost the GPU,
 *  so a shape that spares fewer has its pieces drawn with the finest shape drawn anyway (more detail, never less, one draw fewer). */
const DRAW_WORTH = 2048;

/** Which shape each shape's pieces are drawn with (`counts`: the pieces each would hold, finest first; `triangles`: each one's a piece): at
 *  most two draws - the near pieces at the finest shape any needs, the far ones at the finest shape they need - split where it spares the
 *  most, and only when it spares a draw's worth (`DRAW_WORTH`); else every piece at the finest shape any needs (more detail, never less). */
function drawnShapes(counts: readonly number[], triangles: readonly number[]): number[] {
  const into = counts.map((_, k) => k);
  const finest = counts.findIndex((n) => n > 0);
  if (finest < 0) return into;
  let best = 0, split = counts.length;
  for (let s = finest + 1; s < counts.length; s++) {
    const host = counts.findIndex((n, k) => k >= s && n > 0);
    if (host < 0) break;
    let spared = 0;
    for (let k = s; k < counts.length; k++) spared += counts[k]! * (triangles[finest]! - triangles[host]!);
    if (spared > best) { best = spared; split = s; }
  }
  const farHost = best >= DRAW_WORTH ? counts.findIndex((n, k) => k >= split && n > 0) : finest;
  for (let k = finest; k < counts.length; k++) into[k] = k < split || best < DRAW_WORTH ? finest : farHost;
  return into;
}

/** A part's instances over a block of the layer (`BLOCK`): every piece cast into the cascades from one mesh, each drawn in colour at its own shape. */
export class PartStore {
  /** Every piece, drawn into the sun's cascades alone (`castBySize`: none in colour). */
  private mesh: InstancedMesh | null = null;
  /** The colour pass's meshes, one a shape (`PolePartSpec.levels`), each holding the pieces drawn at that shape. */
  private readonly colour: (InstancedMesh | undefined)[] = [];
  private capacity = 0;
  count = 0;
  private readonly owner: PoleId[] = [];
  private readonly written: number[] = [];
  private whole = false;
  private readonly bounds: PartBounds = { box: emptyBox(), scale: 0, cover: 0 };
  private boundsMoved = false;
  private readonly shape: PartShape;
  /** The part's shape's reach from its own origin: a piece's sphere is this times its largest scale. */
  private readonly reach: number;
  /** Per piece: its sphere (three's axes: x, y, z, radius), its cover (its two longest sides multiplied, the most of the screen it covers),
   *  and the shape it is drawn with in colour (`HIDDEN`: none). */
  private spheres = new Float32Array(0);
  private covers = new Float32Array(0);
  private shapeOf = new Uint8Array(0);
  /** Whether `colour` holds the pieces as `shapeOf` says. */
  private sorted = false;
  /** Takes the mesh off the casters chosen by cascade (`castBySize`). */
  private uncast: (() => void) | null = null;
  readonly perInstance: number;

  constructor(private readonly spec: PolePartSpec, private readonly group: Object3D) {
    const index = spec.geometry.index;
    this.perInstance = (index ? index.count : spec.geometry.getAttribute('position').count) / 3;
    this.shape = partShape(spec.geometry);
    // Its bounds computed when its shape was made (`makeUtilityParts`, `createSceneryKit`).
    const sphere = spec.geometry.boundingSphere!;
    this.reach = sphere.center.length() + sphere.radius;
  }

  /** The mesh of every piece, with room for `capacity`: cast into the cascades alone. */
  private meshOf(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(this.spec.levels[0]!.geometry, this.spec.material, capacity);
    mesh.name = `${this.spec.name}-cast`;
    mesh.castShadow = this.spec.castShadow;
    mesh.receiveShadow = false;
    mesh.count = 0;
    mesh.onBeforeShadow = noteShadow;
    // Hidden between the passes, shown for a cascade's pass (`castBySize` shadowOnly): none of it is drawn in colour.
    mesh.visible = false;
    mesh.userData['shadowOnly'] = false;
    // Cast into a cascade where the part's pieces cover a texel (`shadowCasters.ts`), at the shape each cascade's texel asks: the camera's
    // choices never the shadow's. None drawn in colour: `colour` draws them. DO NOT set its casting from the last cascade three drew: with the
    // far cascades drawn every other frame, the casters' signature saw the poles come and go at every frame (`utility-arms` 2,366 changes,
    // `npm run diagnose`, 2026-10-22).
    this.uncast?.();
    this.uncast = castBySize({
      mesh, casts: this.spec.castShadow, radius: () => Math.sqrt(this.bounds.cover), shadowOnly: true,
      counts: { colour: () => 0, shadow: () => this.count },
      levels: { shadow: (texel) => this.spec.levels[this.levelFor(texel)]!.geometry, colour: () => this.spec.levels[0]!.geometry },
    });
    return mesh;
  }

  /** The colour pass's mesh of shape `level`, with room for `needed` pieces. */
  private colourOf(level: number, needed: number): InstancedMesh {
    const was = this.colour[level];
    if (was && was.instanceMatrix.count >= needed) return was;
    const mesh = new InstancedMesh(this.spec.levels[level]!.geometry, this.spec.material, Math.max(needed, (was?.instanceMatrix.count ?? 0) * 2, 16));
    mesh.name = this.spec.name;
    mesh.castShadow = false;
    mesh.receiveShadow = this.spec.receiveShadow;
    mesh.renderOrder = this.spec.renderOrder;
    mesh.onBeforeRender = noteScreen;
    mesh.boundingSphere = this.mesh?.boundingSphere ?? null;
    if (was) {
      this.group.remove(was);
      was.dispose();
    }
    this.group.add(mesh);
    this.colour[level] = mesh;
    return mesh;
  }

  /** The coarsest shape off by under `error` world units (a texel). */
  private levelFor(error: number): number {
    const levels = this.spec.levels;
    for (let i = levels.length - 1; i > 0; i--) if (levels[i]!.error < error) return i;
    return 0;
  }

  /** Room for `needed` instances: a mesh at least twice as large when it is full, the pieces copied over. */
  reserve(needed: number): void {
    if (needed <= this.capacity) return;
    const capacity = Math.max(needed, this.capacity * 2, 16);
    const mesh = this.meshOf(capacity);
    const spheres = new Float32Array(capacity * 4), covers = new Float32Array(capacity), shapes = new Uint8Array(capacity).fill(HIDDEN);
    spheres.set(this.spheres.subarray(0, this.count * 4));
    covers.set(this.covers.subarray(0, this.count));
    shapes.set(this.shapeOf.subarray(0, this.count));
    this.spheres = spheres; this.covers = covers; this.shapeOf = shapes;
    if (this.mesh) {
      (mesh.instanceMatrix.array as Float32Array).set((this.mesh.instanceMatrix.array as Float32Array).subarray(0, this.count * 16));
      mesh.boundingSphere = this.mesh.boundingSphere;
      this.group.remove(this.mesh);
      // Its buffer let go on the GPU (`WebGLObjects` on the mesh's dispose).
      this.mesh.dispose();
    }
    this.group.add(mesh);
    this.mesh = mesh;
    this.capacity = capacity;
    this.whole = true;
    this.sorted = false;
  }

  /** A part placed for a pole: its slot. */
  add(pole: PoleId, placement: Placement): number {
    this.reserve(this.count + 1);
    const slot = this.count++;
    this.owner[slot] = pole;
    this.shapeOf[slot] = HIDDEN;
    this.write(slot, placement);
    return slot;
  }

  private write(slot: number, placement: Placement): void {
    writePlacement(placement, this.mesh!.instanceMatrix.array as Float32Array, slot * 16);
    if (!this.whole) this.written.push(slot);
    if (growPart(this.bounds, placement, this.shape)) this.boundsMoved = true;
    // Its sphere in three's axes, and the most of the screen it covers (its box's two longest sides as placed).
    const sx = Math.abs(placement.sx), sy = Math.abs(placement.sy), sz = Math.abs(placement.sz);
    const o = slot * 4;
    this.spheres[o] = placement.x; this.spheres[o + 1] = placement.z; this.spheres[o + 2] = -placement.y;
    this.spheres[o + 3] = this.reach * Math.max(sx, sy, sz);
    const sides = this.shape ? [this.shape[0] * sx, this.shape[1] * sy, this.shape[2] * sz].sort((p, q) => q - p) : [0, 0];
    this.covers[slot] = sides[0]! * sides[1]!;
    this.sorted = false;
  }

  /** A slot let go: the last part moves into it. Returns the pole whose slot `count` became `slot`, if another moved. */
  remove(slot: number): PoleId | null {
    const last = --this.count;
    this.sorted = false;
    if (slot === last) return null;
    const array = this.mesh!.instanceMatrix.array as Float32Array;
    array.copyWithin(slot * 16, last * 16, last * 16 + 16);
    this.spheres.copyWithin(slot * 4, last * 4, last * 4 + 4);
    this.covers[slot] = this.covers[last]!;
    this.shapeOf[slot] = this.shapeOf[last]!;
    const moved = this.owner[last]!;
    this.owner[slot] = moved;
    if (!this.whole) this.written.push(slot);
    return moved;
  }

  /** The pieces' matrices sent for the cascades. */
  flush(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    // Read by the casters' signature while it holds any piece; drawn into the cascades alone: hidden in colour whether or not a cascade was
    // drawn since (a tier without shadows never puts the casters back, `sunCascades.ts` restore), its pieces for a cascade's pass alone
    // (`castBySize` counts and shadowOnly).
    mesh.userData['shadowOnly'] = this.count > 0;
    mesh.count = 0;
    const matrices = mesh.instanceMatrix;
    if (this.whole || this.written.length * 2 > this.count) {
      matrices.clearUpdateRanges();
      matrices.needsUpdate = true;
    } else if (this.written.length) {
      for (const slot of this.written) if (slot < this.count) matrices.addUpdateRange(slot * 16, 16);
      matrices.needsUpdate = true;
    }
    this.written.length = 0;
    this.whole = false;
    if (this.boundsMoved && this.count > 0) {
      const b = this.bounds.box, part = this.spec.geometry.boundingSphere!;
      const centre = new Vector3((b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2);
      mesh.boundingSphere = new Sphere(centre, Math.hypot(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) / 2 + (part.center.length() + part.radius) * this.bounds.scale);
      for (const drawn of this.colour) if (drawn) drawn.boundingSphere = mesh.boundingSphere;
      this.boundsMoved = false;
    }
  }

  /** Its pieces' box (three's axes): where its block is nearest the eye with no pole of its own to say so (wires only). */
  get box(): ArrayLike<number> {
    return this.bounds.box;
  }

  /**
   * As the camera sees each piece: under a pixel (its cover times its brightness) not drawn; drawn at the coarsest shape off by under a pixel
   * at its own distance; a light (`glows`) at any size, but not where its material fades it out whole (`fadesAt`) nor behind the eye.
   */
  view(scale: ScreenScale): void {
    if (!this.mesh) return;
    const spec = this.spec, levels = spec.levels, bright = spec.brightness(), sp = this.spheres, shapes = this.shapeOf;
    const under = 1 / ((1 + BAND) * (1 + BAND));
    let changed = !this.sorted;
    for (let i = 0; i < this.count; i++) {
      const o = i * 4, was = shapes[i]!;
      const x = sp[o]!, y = sp[o + 1]!, z = sp[o + 2]!, r = sp[o + 3]!;
      const px = scale.atPoint(x, y, z, r);
      let shape = 0;
      if (px === 0) shape = HIDDEN;
      else if (spec.glows) {
        if (spec.fadesAt !== undefined && scale.past(x, y, z, r, spec.fadesAt)) shape = HIDDEN;
      } else {
        const seen = this.covers[i]! * px * px * bright;
        if (seen < (was === HIDDEN ? 1 : under)) shape = HIDDEN;
        else {
          // A coarser shape than the one drawn only once it is off by under a pixel less the band.
          for (let k = levels.length - 1; k > 0; k--) {
            if (levels[k]!.error * px * (k > was || was === HIDDEN ? 1 + BAND : 1) < 1) { shape = k; break; }
          }
        }
      }
      if (shape !== was) { shapes[i] = shape; changed = true; }
    }
    if (changed) this.sort();
  }

  /** The colour meshes filled from the pieces' shapes: each piece's matrix in its shape's mesh. */
  private sort(): void {
    const levels = this.spec.levels, shapes = this.shapeOf, all = this.mesh!.instanceMatrix.array as Float32Array;
    const wanted = levels.map(() => 0);
    for (let i = 0; i < this.count; i++) if (shapes[i] !== HIDDEN) wanted[shapes[i]!]!++;
    // A shape sparing too few triangles for a draw of its own drawn with the finest drawn.
    const into = drawnShapes(wanted, levels.map((level) => (level.geometry.index?.count ?? 0) / 3));
    const counts = levels.map(() => 0);
    for (let k = 0; k < levels.length; k++) counts[into[k]!]! += wanted[k]!;
    for (let k = 0; k < levels.length; k++) {
      const needed = counts[k]!;
      if (needed === 0) {
        const mesh = this.colour[k];
        if (mesh) { mesh.count = 0; mesh.visible = false; }
        continue;
      }
      const mesh = this.colourOf(k, needed), out = mesh.instanceMatrix.array as Float32Array;
      let n = 0;
      for (let i = 0; i < this.count; i++) if (shapes[i] !== HIDDEN && into[shapes[i]!] === k) out.set(all.subarray(i * 16, i * 16 + 16), 16 * n++);
      mesh.count = n;
      mesh.visible = true;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.sorted = true;
  }

  /** The pieces drawn in colour and their triangles. */
  get drawnTriangles(): number {
    let triangles = 0;
    for (const mesh of this.colour) if (mesh?.visible) triangles += mesh.count * ((mesh.geometry.index?.count ?? 0) / 3);
    return triangles;
  }

  /** Its instances made for good (a block of the view's, `PoleCells`): no pole's slot kept. Its matrices stay on the page (the colour pass's
   *  meshes are filled from them). The buffer, none when empty. */
  seal(): BufferAttribute | null {
    this.owner.length = 0;
    this.written.length = 0;
    return this.mesh && this.count > 0 ? this.mesh.instanceMatrix : null;
  }

  /** Its mesh of every piece (the cascades'), none while it holds nothing. */
  get drawn(): InstancedMesh | null {
    return this.mesh;
  }

  /** The matrices' array as made (`seal`): what the GPU is given again after a lost context. */
  get matrices(): Float32Array | null {
    return (this.mesh?.instanceMatrix.array as Float32Array | undefined) ?? null;
  }

  dispose(): void {
    this.uncast?.();
    this.uncast = null;
    for (const mesh of this.colour) if (mesh) { this.group.remove(mesh); mesh.dispose(); }
    this.colour.length = 0;
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
  }
}

/** The template that draws every wire of a set of templates within a pixel: as many chords as any, creased if any is. */
function hostOf(templates: readonly number[]): number {
  let chords = 0, creased = false;
  for (const t of templates) { const a = wireTemplate(t); chords = Math.max(chords, a.chords); creased ||= a.creased; }
  return wireTemplateOf(chords, creased);
}

/** Which template each template's wires are drawn with (`wanted`: the wires each would hold): at most two draws - the near wires with the
 *  template that serves them all, the far ones with the one that serves them - split where it spares the most triangles, and only when it
 *  spares a draw's worth (`DRAW_WORTH`); never a template with fewer chords or no crease where a wire needs them. */
function drawnTemplates(wanted: readonly number[]): number[] {
  const into = wanted.map((_, t) => t);
  const used = wanted.map((n, t) => (n > 0 ? t : -1)).filter((t) => t >= 0).sort((a, b) => wireTemplate(b).triangles - wireTemplate(a).triangles);
  if (used.length === 0) return into;
  const all = hostOf(used), allTriangles = wireTemplate(all).triangles;
  let best = 0, split = used.length, farHost = all;
  for (let s = 1; s < used.length; s++) {
    const far = used.slice(s), host = hostOf(far);
    const spared = far.reduce((sum, t) => sum + wanted[t]! * (allTriangles - wireTemplate(host).triangles), 0);
    if (spared > best) { best = spared; split = s; farHost = host; }
  }
  used.forEach((t, k) => { into[t] = best >= DRAW_WORTH && k >= split ? farHost : all; });
  return into;
}

/** The colour pass's wires drawn with one template (`wireLevel`): their own instances, copied from the block's, one mesh. */
interface WireBucket {
  data: Float32Array;
  readonly buffer: InstancedInterleavedBuffer;
  readonly geometry: InstancedBufferGeometry;
  readonly mesh: Mesh;
}

/** One block's spans' wires: `SPAN_WIRES` instances a span, all cast into the cascades from one mesh, each span drawn in colour with the
 *  template its own distance asks. */
export class WireStore {
  /** Every wire, drawn into the sun's cascades alone. */
  private mesh: Mesh | null = null;
  private data = new Float32Array(0);
  private buffer: InstancedInterleavedBuffer | null = null;
  private capacity = 0;
  count = 0;
  private readonly owner: SpanId[] = [];
  private readonly written: number[] = [];
  private whole = false;
  private readonly bounds: WireBounds = { box: emptyBox(), sag: 0 };
  private boundsMoved = false;
  /** Each template's geometry over every wire (the cascades'), made when first cast so; all share `sphere`. */
  private levels: (InstancedBufferGeometry | undefined)[] = [];
  private level = 0;
  private readonly sphere = new Sphere();
  /** Per span: its sphere (three's axes) and sag, and the template it is drawn with in colour (`HIDDEN`: none). */
  private spheres = new Float32Array(0);
  private templateOf = new Uint8Array(0);
  private sorted = false;
  /** The colour pass's wires, one bucket a template. */
  private readonly buckets: (WireBucket | undefined)[] = [];
  /** Takes the mesh off the casters chosen by cascade (`castBySize`). */
  private uncast: (() => void) | null = null;
  private static readonly BLOCK = WIRE_BLOCK;

  constructor(private readonly group: Object3D) {}

  private reserve(needed: number): void {
    if (needed <= this.capacity) return;
    const capacity = Math.max(needed, this.capacity * 2, 16);
    const data = new Float32Array(capacity * WireStore.BLOCK);
    data.set(this.data.subarray(0, this.count * WireStore.BLOCK));
    const spheres = new Float32Array(capacity * 5), templates = new Uint8Array(capacity).fill(HIDDEN);
    spheres.set(this.spheres.subarray(0, this.count * 5));
    templates.set(this.templateOf.subarray(0, this.count));
    this.spheres = spheres; this.templateOf = templates;
    this.dropLevels();
    this.data = data;
    this.buffer = new InstancedInterleavedBuffer(data, WIRE_STRIDE, 1);
    this.capacity = capacity;
    this.whole = true;
    this.sorted = false;
    if (this.mesh) {
      this.mesh.geometry = this.geometry(this.level);
      return;
    }
    this.makeMesh();
  }

  private makeMesh(): void {
    const { material, depth } = wireParts();
    const mesh = new Mesh(this.geometry(this.level), material);
    // The shadow drawn from the same bent template (three draws a caster's shadow with its depth material).
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.name = 'utility-wires-cast';
    mesh.onBeforeShadow = noteShadow;
    // Hidden between the passes, shown for a cascade's pass (`castBySize` shadowOnly): none of it is drawn in colour.
    mesh.visible = false;
    mesh.userData['shadowOnly'] = false;
    // Cast into a cascade whose texel the wire's width spans (`castBySize`), as the parts; none drawn in colour (`buckets` draw them).
    this.uncast = castBySize({
      mesh, casts: true, radius: () => WIRE_WIDTH, shadowOnly: true, instances: { colour: () => 0, shadow: () => this.count * SPAN_WIRES },
    });
    this.group.add(mesh);
    this.mesh = mesh;
  }

  /** The geometry drawing every wire with template `level`. */
  private geometry(level: number): InstancedBufferGeometry {
    let geometry = this.levels[level];
    if (!geometry) {
      geometry = wireGeometry(level, this.buffer!);
      geometry.boundingSphere = this.sphere;
      geometry.instanceCount = 0;
      this.levels[level] = geometry;
    }
    return geometry;
  }

  private dropLevels(): void {
    for (const geometry of this.levels) if (geometry) releaseWireGeometry(geometry);
    this.levels = [];
  }

  /** A span's wires strung: its block. */
  add(span: UtilitySpan, a: SpanEnd, b: SpanEnd): number {
    this.reserve(this.count + 1);
    const block = this.count++;
    this.owner[block] = span.id;
    const at = block * WireStore.BLOCK;
    spanWires(span, a, b, this.data, at);
    this.templateOf[block] = HIDDEN;
    this.measure(block);
    if (!this.whole) this.written.push(block);
    if (growWires(this.bounds, this.data, at)) this.boundsMoved = true;
    return block;
  }

  /** A span's sphere and sag (its first wire's chord's middle, half the chord and the arms' reach round it, three's axes). */
  private measure(block: number): void {
    const d = this.data, at = block * WireStore.BLOCK, o = block * 5;
    const ax = d[at]!, ay = d[at + 1]!, az = d[at + 2]!, bx = d[at + 3]!, by = d[at + 4]!, bz = d[at + 5]!;
    let sag = 0;
    for (let w = 0; w < SPAN_WIRES; w++) sag = Math.max(sag, d[at + w * WIRE_STRIDE + 6]!);
    this.spheres[o] = (ax + bx) / 2; this.spheres[o + 1] = (ay + by) / 2 - sag; this.spheres[o + 2] = (az + bz) / 2;
    this.spheres[o + 3] = Math.hypot(bx - ax, by - ay, bz - az) / 2 + sag + m(2);
    this.spheres[o + 4] = sag;
    this.sorted = false;
  }

  /** A block let go: the last span's wires move into it. Returns the span whose block `count` became `block`. */
  remove(block: number): SpanId | null {
    const last = --this.count;
    this.sorted = false;
    if (block === last) return null;
    this.data.copyWithin(block * WireStore.BLOCK, last * WireStore.BLOCK, (last + 1) * WireStore.BLOCK);
    this.spheres.copyWithin(block * 5, last * 5, last * 5 + 5);
    this.templateOf[block] = this.templateOf[last]!;
    const moved = this.owner[last]!;
    this.owner[block] = moved;
    if (!this.whole) this.written.push(block);
    return moved;
  }

  /** The wires sent for the cascades; bounds from the wires' ends, their sag and the drawn width (three would read the template's). */
  flush(): void {
    const mesh = this.mesh, buffer = this.buffer;
    if (!mesh || !buffer) return;
    // Read by the casters' signature while it holds any wire; hidden in colour, shown for a cascade's pass (`castBySize` shadowOnly).
    mesh.userData['shadowOnly'] = this.count > 0;
    if (this.whole || this.written.length * 2 > this.count) {
      buffer.clearUpdateRanges();
      buffer.needsUpdate = true;
    } else if (this.written.length) {
      for (const block of this.written) if (block < this.count) buffer.addUpdateRange(block * WireStore.BLOCK, WireStore.BLOCK);
      buffer.needsUpdate = true;
    }
    this.written.length = 0;
    this.whole = false;
    if (this.boundsMoved && this.count > 0) {
      const x = this.bounds.box;
      this.sphere.center.set((x[0]! + x[3]!) / 2, (x[1]! + x[4]!) / 2, (x[2]! + x[5]!) / 2);
      this.sphere.radius = Math.hypot(x[3]! - x[0]!, x[4]! - x[1]!, x[5]! - x[2]!) / 2 + this.bounds.sag + WIRE_HALF_WIDTH;
      this.boundsMoved = false;
    }
  }

  /** Its wires' box (three's axes, before their sag). */
  get box(): ArrayLike<number> {
    return this.bounds.box;
  }

  /**
   * As the camera sees each span: its wires drawn in colour with the template its own nearest point needs (`wireLevel`), none once thinner
   * than the least width drawn; the cascades' with the template the block's nearest pole needs (`nearest`).
   */
  view(scale: ScreenScale, nearest: number): void {
    const mesh = this.mesh;
    if (!mesh || this.count === 0) return;
    const level = wireLevel(nearest, this.bounds.sag);
    if (level >= 0 && level !== this.level) {
      this.level = level;
      mesh.geometry = this.geometry(level);
    }
    const sp = this.spheres, templates = this.templateOf;
    let changed = !this.sorted;
    for (let i = 0; i < this.count; i++) {
      const o = i * 5, was = templates[i]!;
      const px = scale.atPoint(sp[o]!, sp[o + 1]!, sp[o + 2]!, sp[o + 3]!);
      let template = px === 0 ? -1 : wireLevel(px, sp[o + 4]!);
      // Held where it is while the view moves within the band of its edge (`BAND`): no span flickering between two templates.
      if (template !== was && was !== HIDDEN && px > 0) {
        const near = wireLevel(px * (1 + BAND), sp[o + 4]!), far = wireLevel(px / (1 + BAND), sp[o + 4]!);
        if (near === was || far === was) template = was;
      }
      const next = template < 0 ? HIDDEN : template;
      if (next !== was) { templates[i] = next; changed = true; }
    }
    if (changed) this.sort();
  }

  /** The colour buckets filled from the spans' templates: each span's wires (an empty slot left out) in its template's bucket. */
  private sort(): void {
    const templates = this.templateOf, all = this.data;
    const wanted: number[] = Array.from({ length: WIRE_TEMPLATE_COUNT }, () => 0);
    for (let i = 0; i < this.count; i++) {
      const t = templates[i]!;
      if (t === HIDDEN) continue;
      for (let w = 0; w < SPAN_WIRES; w++) if (all[i * WireStore.BLOCK + w * WIRE_STRIDE + 6]! >= 0) wanted[t]!++;
    }
    const into = drawnTemplates(wanted);
    const wires: number[] = wanted.map(() => 0);
    for (let t = 0; t < wanted.length; t++) wires[into[t]!]! += wanted[t]!;
    const most = Math.max(this.buckets.length, wires.length);
    for (let t = 0; t < most; t++) {
      const needed = wires[t] ?? 0;
      const held = this.buckets[t];
      if (needed === 0) {
        if (held) { held.geometry.instanceCount = 0; held.mesh.visible = false; }
        continue;
      }
      const bucket = this.bucketOf(t, needed), out = bucket.data;
      let n = 0;
      for (let i = 0; i < this.count; i++) {
        if (templates[i] === HIDDEN || into[templates[i]!] !== t) continue;
        for (let w = 0; w < SPAN_WIRES; w++) {
          const at = i * WireStore.BLOCK + w * WIRE_STRIDE;
          if (all[at + 6]! < 0) continue;
          out.set(all.subarray(at, at + WIRE_STRIDE), WIRE_STRIDE * n++);
        }
      }
      bucket.geometry.instanceCount = n;
      bucket.mesh.visible = true;
      bucket.buffer.clearUpdateRanges();
      bucket.buffer.addUpdateRange(0, n * WIRE_STRIDE);
      bucket.buffer.needsUpdate = true;
    }
    this.sorted = true;
  }

  /** Template `t`'s bucket with room for `needed` wires. */
  private bucketOf(t: number, needed: number): WireBucket {
    const was = this.buckets[t];
    if (was && was.data.length >= needed * WIRE_STRIDE) return was;
    const data = new Float32Array(Math.max(needed, (was ? was.data.length / WIRE_STRIDE : 0) * 2, 32) * WIRE_STRIDE);
    const buffer = new InstancedInterleavedBuffer(data, WIRE_STRIDE, 1);
    const geometry = wireGeometry(t, buffer);
    geometry.boundingSphere = this.sphere;
    const mesh = new Mesh(geometry, wireParts().material);
    mesh.name = 'utility-wires';
    mesh.castShadow = false;
    mesh.onBeforeRender = noteWireScreen;
    if (was) {
      this.group.remove(was.mesh);
      releaseWireGeometry(was.geometry);
    }
    this.group.add(mesh);
    const bucket = { data, buffer, geometry, mesh };
    this.buckets[t] = bucket;
    return bucket;
  }

  /** The wires drawn in colour (their template's triangles each). */
  get drawnTriangles(): number {
    let triangles = 0;
    for (const bucket of this.buckets) if (bucket?.mesh.visible) triangles += bucket.geometry.instanceCount * ((bucket.geometry.index?.count ?? 0) / 3);
    return triangles;
  }

  /** Its wires made for good (`PoleCells`): no span's block kept. Its instances stay on the page (each span's are copied into its template's
   *  bucket as the view moves). The buffer, none when empty. */
  seal(): InterleavedBuffer | null {
    this.owner.length = 0;
    this.written.length = 0;
    return this.count > 0 ? this.buffer : null;
  }

  /** The wires' array as made. */
  get instances(): Float32Array {
    return this.data;
  }

  /** Its mesh of every wire (the cascades'), none while it holds nothing. */
  get drawn(): Mesh | null {
    return this.mesh;
  }

  dispose(): void {
    this.uncast?.();
    this.uncast = null;
    this.dropLevels();
    for (const bucket of this.buckets) if (bucket) { this.group.remove(bucket.mesh); releaseWireGeometry(bucket.geometry); }
    this.buckets.length = 0;
    if (this.mesh) this.group.remove(this.mesh);
  }
}
