import { applyPartSway, applyStructureSway } from './wind';
import { castBySize, casterTexel } from './shadowCasters';
import { holdStill } from './stillTree';
import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshStandardMaterial,
  Quaternion,
  RGBADepthPacking,
  Scene,
  Sphere,
  Vector3,
  type Frustum,
  BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARM_HEIGHT, ARM_LENGTH, FACES, HEAD_CENTRE, HEAD_WIDTH, LAMPS, LENS_DEPTH, POST_HEIGHT, VISOR_REACH, signalHeadShapes, type Lamp } from './signalShapes';

import { signalPostPlace } from '@world/signalPosts';
import { JournalCursor } from '@world/derived';
import type { SignalFeed } from '@sim/host/simClient';
import type { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import type { SignalState } from '@sim/signals/query';
import { m } from '@world/units';

/** Physical traffic signal heads. ## Why every head is double-sided A real signal aims its lenses at the traffic it */

/** A level is left for a coarser one once that one's error is under this share of a pixel, and taken back at a whole one (`partCells.ts` COARSEN). */
const COARSEN = 0.85;


/** Where the eye stands (three's world: x, up, z) and the pixels a world unit spans at a unit's distance, or everywhere (`orthoPx`, the view from above). */
export interface SignalView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly pxAtMetre: number;
  readonly orthoPx: number | null;
}

export interface SignalHeads {
  readonly group: Group;
  /** `frustum`: what the camera sees this frame; the lamps of cells out of it wait until they come in. `view`: each cell's heads drawn at the
   *  level their error on the screen allows (none given: every head in full). */
  sync(feed: SignalFeed, net: Network, detailed: boolean, frustum?: Frustum, view?: SignalView): void;
  dispose(): void;
}

/** The heads are batched BY CELL of the ground (`world/cells.ts` CELL) */
const SIGNAL_CELL = m(250);
/** How far a head's parts reach from the foot of its post, with its sway: the cell's sphere grows by it. */
const HEAD_REACH = Math.hypot(ARM_LENGTH + HEAD_WIDTH, POST_HEIGHT) + m(0.1);

interface Head {
  readonly x: number;
  readonly height: number;
  readonly y: number;
  readonly yaw: number;
  readonly groupId: number;
  readonly key: string;
  state: SignalState | null;
}

/** A signalised junction's heads, and the controller's phase they were last drawn at. */
interface Junction {
  readonly node: NodeId;
  readonly heads: Head[];
  /** The stage seen (`SignalFeed.stage`): the heads are asked again only when it moves. */
  stage: string;
}

/** The kinds of a head's parts, each a batch: the frame (post, arm and housing as one geometry, one instance a head), the visors, every lens lit or not, the lit lenses' halos; the lenses and halos of the cells seen from afar at their far level (their face alone). */
type BatchName = 'frame' | 'visors' | 'lenses' | 'halos' | 'lensesFar' | 'halosFar';

interface Cell {
  readonly key: number;
  readonly junctions: Junction[];
  readonly heads: Head[];
  readonly sphere: Sphere;
  /** Its lenses lit now. */
  lit: number;
  /** A head's state changed: its lenses are written again (this cell's only). */
  stale: boolean;
  /** Its lenses and halos drawn at their far level (`LENS_DEPTH` under a pixel), and its visors drawn at all (`VISOR_REACH` over one). */
  far: boolean;
  visors: boolean;
  /** Its visors' matrices, kept to draw them again when they come back. */
  readonly shields: Float32Array;
}


/** Builds and updates the physical signal heads used by the Three.js renderer. */
export function createSignalHeads(
  scene: Scene,
  elevationAt: (x: number, y: number, segment?: SegmentId) => number = () => 0,
): SignalHeads {
  const group = new Group();
  group.name = 'traffic-signals';
  // DO NOT let the frame recompose every cell's batches: they never move (the sway is the shader's), a still tree (`stillTree.ts`).
  holdStill(group);
  scene.add(group);

  const { postGeometry, armGeometry, housingGeometry, lensGeometry, haloGeometry, visorGeometry, lensFarGeometry, haloFarGeometry, POST, ARM, BOX, lens, halos, visors } = signalHeadShapes();

  // A signal post sways a few centimetres at the top in a gust, its arm and heads with it (`applyStructureSway`).
  const SWAY = m(0.05);
  const STEEL = { color: new Color(0x2b302d), roughness: 0.7, metalness: 0.45 };
  const HOUSING = { color: new Color(0x15191a), roughness: 0.78, metalness: 0.1 };
  const housing = new MeshStandardMaterial({ color: HOUSING.color, roughness: HOUSING.roughness, metalness: HOUSING.metalness });
  applyStructureSway(housing, HEAD_CENTRE, POST_HEIGHT, SWAY, 'signal-housing');

  // DO NOT draw the post, the arm and the housing as a mesh each (three draws a cell): one geometry, each part painted and swaying as its own mesh did.
  /** A part of the frame in its head: its colour, roughness and metal, its sway's foot (`applyPartSway`) and its size (`frameDepth`). */
  const framePart = (geometry: BufferGeometry, local: Matrix4, look: typeof STEEL, swayOrigin: number): BufferGeometry => {
    geometry.computeBoundingSphere();
    const part = geometry.clone().applyMatrix4(local);
    const n = part.getAttribute('position').count;
    const colour = new Float32Array(n * 3), surface = new Float32Array(n * 2), sway = new Float32Array(n * 4);
    const reach = new Float32Array(n).fill(geometry.boundingSphere!.radius);
    const e = local.elements;
    for (let i = 0; i < n; i++) {
      colour.set([look.color.r, look.color.g, look.color.b], i * 3);
      surface.set([look.roughness, look.metalness], i * 2);
      sway.set([e[12]!, e[13]!, e[14]!, swayOrigin], i * 4);
    }
    part.setAttribute('color', new BufferAttribute(colour, 3));
    part.setAttribute('aSurface', new BufferAttribute(surface, 2));
    part.setAttribute('aSwayPart', new BufferAttribute(sway, 4));
    part.setAttribute('aCastReach', new BufferAttribute(reach, 1));
    return part;
  };
  const frameParts = [
    framePart(postGeometry, POST, STEEL, POST_HEIGHT / 2),
    framePart(armGeometry, ARM, STEEL, ARM_HEIGHT),
    framePart(housingGeometry, BOX, HOUSING, HEAD_CENTRE),
  ];
  const frameGeometry = mergeGeometries(frameParts)!;
  for (const part of frameParts) part.dispose();
  /** The frame's widest part: what decides whether it casts into a cascade at all (`castBySize`). */
  const frameReach = Math.max(postGeometry.boundingSphere!.radius, armGeometry.boundingSphere!.radius, housingGeometry.boundingSphere!.radius);
  const frame = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 1 });
  frame.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aSurface;
        varying vec2 vSurface;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurface = aSurface;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vSurface;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;');
  };
  applyPartSway(frame, POST_HEIGHT, SWAY, 'signal-frame');
  // Its shadow at rest, as the parts' was; a part narrower than the cascade's texel left out of it, as its own mesh was (`casterTexel`).
  const frameDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false });
  frameDepth.onBeforeCompile = (shader) => {
    shader.uniforms.uCastTexel = casterTexel;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aCastReach;
        uniform float uCastTexel;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        if (aCastReach < uCastTexel) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`);
  };
  frameDepth.customProgramCacheKey = () => 'signal-frame-depth';

  // DO NOT draw the lenses as a mesh a colour and one for the lit: every lens in one mesh, its colours its instance's.
  // Off, but still obviously a coloured filter over a dark can: its colour and glow (`aLensGlow` rgb).
  const DARK: Record<Lamp, { readonly color: Color; readonly glow: Color }> = {
    red: { color: new Color(0x8d221c), glow: new Color(0x2a0705) },
    amber: { color: new Color(0x8a6410), glow: new Color(0x281c04) },
    green: { color: new Color(0x1d6b33), glow: new Color(0x07230f) },
  };
  // Lit lenses keep their hue at full brightness: their colour as it is and untone-mapped, as a basic material draws it (`aLensGlow` a = 1).
  const LIT: Record<Lamp, Color> = {
    red: new Color(0xff4034),
    amber: new Color(0xffb219),
    green: new Color(0x3bf06a),
  };
  /** A lit lens's glow: none, its colour at full brightness and untone-mapped (`aLensGlow` a = 1). */
  const GLOW_ON = new Color(0, 0, 0);
  const lenses = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0 });
  lenses.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aLensGlow;
        varying vec4 vLensGlow;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLensGlow = aLensGlow;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vLensGlow;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance = vLensGlow.rgb;`)
      .replace('#include <opaque_fragment>', `if (vLensGlow.a > 0.5) outgoingLight = diffuseColor.rgb;
        #include <opaque_fragment>`)
      .replace('#include <tonemapping_fragment>', `if (vLensGlow.a < 0.5) {
        #include <tonemapping_fragment>
        }`);
  };
  const halo = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.28 });
  for (const [k, mat] of [['lens', lenses], ['halo', halo]] as const) {
    applyStructureSway(mat, HEAD_CENTRE, POST_HEIGHT, SWAY, `signal-${k}`);
  }
  const HALO: Record<Lamp, Color> = {
    red: new Color(0xff5145),
    amber: new Color(0xffc850),
    green: new Color(0x59ff86),
  };

  const solid = { cast: true, receive: true };
  const shading = { cast: true, receive: false };
  const glow = { cast: false, receive: false };
  /** Each kind of part: its geometry, material, instances a head, shadows, and whether it takes a colour per instance. */
  const KINDS: Record<BatchName, readonly [BufferGeometry, Material, number, { cast: boolean; receive: boolean }, boolean]> = {
    frame: [frameGeometry, frame, 1, solid, false],
    visors: [visorGeometry, housing, LAMPS.length * FACES.length, shading, false],
    lenses: [lensGeometry, lenses, LAMPS.length * FACES.length, glow, true],
    halos: [haloGeometry, halo, FACES.length, glow, true],
    lensesFar: [lensFarGeometry, lenses, LAMPS.length * FACES.length, glow, true],
    halosFar: [haloFarGeometry, halo, FACES.length, glow, true],
  };
  const FIXED: readonly BatchName[] = ['frame', 'visors'];
  const LENSES: readonly BatchName[] = ['lenses', 'halos', 'lensesFar', 'halosFar'];
  /** The kinds whose instances carry a glow each (`aLensGlow`): the lenses, near and far. */
  const glowing = (name: BatchName): boolean => name === 'lenses' || name === 'lensesFar';
  /** A geometry holding `shape`'s attributes and index themselves (three uploads an attribute once, whatever holds it). */
  const sharing = (shape: BufferGeometry): BufferGeometry => {
    const geometry = new BufferGeometry();
    geometry.setIndex(shape.index);
    for (const [key, attribute] of Object.entries(shape.attributes)) geometry.setAttribute(key, attribute);
    return geometry;
  };
  /** Each casting batch taken off the casters chosen by cascade when it goes (`castBySize`). */
  const uncast = new Map<InstancedMesh, () => void>();

  /** One kind's instances over a block of cells (`BLOCK`): a master array, one InstancedMesh, a run a cell (`buildCell`).
   *  DO NOT draw a mesh a cell: a city's thirty cells were a hundred and twenty draws (the lab's frame, 2026-10-20). */
  class SignalBatch {
    private mesh: InstancedMesh | null = null;
    private geometry: BufferGeometry;
    private data = new Float32Array(0);
    private colours: Float32Array | null = null;
    private glows: Float32Array | null = null;
    private capacity = 0;
    private count = 0;
    private readonly runs = new Map<number, { start: number; count: number; sphere: Sphere }>();
    private readonly sphere = new Sphere(new Vector3(), 0);
    private dirty = false;

    constructor(private readonly name: BatchName) {
      const [shape] = KINDS[name];
      this.geometry = glowing(name) ? sharing(shape) : shape;
      this.reserve(16);
    }

    /** A cell's instances appended: its run, and the sphere they stand in. */
    add(key: number, matrices: Float32Array, colours: Float32Array | null, glows: Float32Array | null, sphere: Sphere): void {
      // The same instances the cell's run holds: nothing to send. DO NOT write them again: the simulation tells a junction's layout again with nothing changed, the cell was built again, and the frames' and visors' matrices sent anew moved the casters' signature - every sun cascade drawn whole two or three times a second in a still view (the frames over 25 ms at the close view, 2026-10-21).
      if (this.holds(key, matrices, colours, glows)) return;
      this.remove(key);
      const n = matrices.length / 16;
      if (!n) return;
      this.reserve(this.count + n);
      this.data.set(matrices, this.count * 16);
      if (this.colours && colours) this.colours.set(colours, this.count * 3);
      if (this.glows && glows) this.glows.set(glows, this.count * 4);
      this.runs.set(key, { start: this.count, count: n, sphere });
      this.count += n;
      this.dirty = true;
    }

    /** Whether the cell's run holds these very instances (matrices, colours and glows alike). */
    private holds(key: number, matrices: Float32Array, colours: Float32Array | null, glows: Float32Array | null): boolean {
      const run = this.runs.get(key);
      if (!run || run.count * 16 !== matrices.length) return false;
      const same = (store: Float32Array | null, given: Float32Array | null, size: number): boolean => {
        if (!store || !given) return !given;
        const from = run.start * size;
        for (let i = 0; i < given.length; i++) if (store[from + i] !== given[i]) return false;
        return true;
      };
      return same(this.data, matrices, 16) && same(this.colours, colours, 3) && same(this.glows, glows, 4);
    }

    /** A cell's instances let go: the runs after its own move down. */
    remove(key: number): void {
      const gone = this.runs.get(key);
      if (!gone) return;
      this.data.copyWithin(gone.start * 16, (gone.start + gone.count) * 16, this.count * 16);
      if (this.colours) this.colours.copyWithin(gone.start * 3, (gone.start + gone.count) * 3, this.count * 3);
      if (this.glows) this.glows.copyWithin(gone.start * 4, (gone.start + gone.count) * 4, this.count * 4);
      this.runs.delete(key);
      for (const run of this.runs.values()) if (run.start > gone.start) run.start -= gone.count;
      this.count -= gone.count;
      this.dirty = true;
    }

    private reserve(needed: number): void {
      if (needed <= this.capacity) return;
      const capacity = Math.max(needed, this.capacity * 2, 16);
      const data = new Float32Array(capacity * 16);
      data.set(this.data.subarray(0, this.count * 16));
      this.data = data;
      const [, , , , coloured] = KINDS[this.name];
      if (coloured) {
        const colours = new Float32Array(capacity * 3).fill(1);
        if (this.colours) colours.set(this.colours.subarray(0, this.count * 3));
        this.colours = colours;
      }
      if (glowing(this.name)) {
        const shape = KINDS[this.name][0];
        const glows = new Float32Array(capacity * 4);
        if (this.glows) glows.set(this.glows.subarray(0, this.count * 4));
        this.glows = glows;
        // The glows are the instances': a geometry of the batch's own over the shape's arrays (never copied, one buffer on the GPU).
        const previous = this.geometry;
        this.geometry = sharing(shape);
        const attribute = new InstancedBufferAttribute(glows, 4);
        attribute.setUsage(DynamicDrawUsage);
        this.geometry.setAttribute('aLensGlow', attribute);
        if (previous !== shape) {
          previous.setIndex(null);
          for (const key of Object.keys(shape.attributes)) previous.deleteAttribute(key);
          previous.dispose();
        }
      }
      this.capacity = capacity;
      this.makeMesh();
    }

    private makeMesh(): void {
      const [, material, , shadows] = KINDS[this.name];
      if (this.mesh) {
        uncast.get(this.mesh)?.();
        uncast.delete(this.mesh);
        group.remove(this.mesh);
        this.mesh.dispose();
      }
      const mesh = new InstancedMesh(this.geometry, material, 0);
      mesh.name = `signal-${this.name}`;
      mesh.count = 0;
      mesh.castShadow = shadows.cast;
      mesh.receiveShadow = shadows.receive;
      if (this.name === 'frame') mesh.customDepthMaterial = frameDepth;
      mesh.instanceMatrix = new InstancedBufferAttribute(this.data, 16);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      if (this.colours) {
        mesh.instanceColor = new InstancedBufferAttribute(this.colours, 3);
        mesh.instanceColor.setUsage(DynamicDrawUsage);
      }
      if (shadows.cast) {
        // Cast into a cascade only with heads, and where the part reaches a texel (a visor's hood is a few centimetres): `shadowCasters.ts`.
        if (!this.geometry.boundingSphere) this.geometry.computeBoundingSphere();
        const reach = this.name === 'frame' ? frameReach : this.geometry.boundingSphere?.radius ?? 0;
        uncast.set(mesh, castBySize({ mesh, casts: true, radius: () => reach }));
      }
      mesh.boundingSphere = this.sphere;
      group.add(mesh);
      this.mesh = mesh;
      this.dirty = true;
    }

    /** The drawn count and the masters sent; bounds round every cell's heads. */
    flush(): void {
      const mesh = this.mesh;
      if (!mesh) return;
      mesh.count = this.count;
      mesh.visible = this.count > 0;
      if (!this.dirty) return;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.needsUpdate = true;
      }
      const glows = this.geometry.getAttribute('aLensGlow') as InstancedBufferAttribute | undefined;
      if (glows) {
        glows.clearUpdateRanges();
        glows.needsUpdate = true;
      }
      if (this.count > 0) {
        let cx = 0, cy = 0, cz = 0, n = 0;
        for (const run of this.runs.values()) { const c = run.sphere.center; cx += c.x; cy += c.y; cz += c.z; n++; }
        cx /= n; cy /= n; cz /= n;
        this.sphere.center.set(cx, cy, cz);
        let r = 0;
        for (const run of this.runs.values()) r = Math.max(r, run.sphere.center.distanceTo(this.sphere.center) + run.sphere.radius);
        this.sphere.radius = r;
      }
      this.dirty = false;
    }

    dispose(): void {
      if (!this.mesh) return;
      uncast.get(this.mesh)?.();
      uncast.delete(this.mesh);
      group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
      const shape = KINDS[this.name][0];
      if (this.geometry !== shape) {
        // The lenses' own geometry over the shape's arrays: those let go first, or its dispose would free them on the GPU
        // for every other use too (three r186 `WebGLGeometries` onGeometryDispose removes each attribute the geometry holds).
        this.geometry.setIndex(null);
        for (const key of Object.keys(shape.attributes)) this.geometry.deleteAttribute(key);
        this.geometry.dispose();
      }
    }
  }
  /** THE HEADS IN BLOCKS OF THE PLANE: each kind's batch a block, its bounds the block's heads, culled by three out of the view. DO NOT keep one batch a kind for the town: its bounds were the city's, never culled, and every head of a large city drawn at every frame (7,638 lenses, 20,196 visors, 1 M triangles at a close view and as many cast, 2026-10-20). */
  // A world tile (`world/tiles.ts` TILE): four world cells a side.
  const BLOCK = m(1_000);
  /** A block's batches, each made at its first instances: a block whose heads are all near has no far batch. */
  type Block = Partial<Record<BatchName, SignalBatch>>;
  const blocks = new Map<string, Block>();
  /** A block's batch of a kind, made now if it has none. */
  const batchOf = (batches: Block, name: BatchName): SignalBatch => (batches[name] ??= new SignalBatch(name));
  /** Each cell's block, taken at its first heads and kept: its runs never split between two. */
  const cellBlock = new Map<number, Block>();
  const batchesOf = (key: number, sphere: Sphere): Block => {
    let batches = cellBlock.get(key);
    if (batches) return batches;
    const at = `${Math.floor(sphere.center.x / BLOCK)},${Math.floor(-sphere.center.z / BLOCK)}`;
    batches = blocks.get(at);
    if (!batches) blocks.set(at, batches = {});
    cellBlock.set(key, batches);
    return batches;
  };

  const root = new Matrix4();
  const place = new Matrix4();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const foot = new Vector3();
  const one = new Vector3(1, 1, 1);
  const HEAD = new Matrix4();
  /** A part's matrix in its head, written into `out` at `at`: the head's place and the part's own. */
  const put = (out: Float32Array, at: number, local: Matrix4): void => {
    place.multiplyMatrices(root, local);
    place.toArray(out, at);
  };
  const rootOf = (head: Head): void => {
    root.compose(foot.set(head.x, head.height, -head.y), turn.setFromAxisAngle(up, head.yaw), one);
  };

  /** What each head shows, by `node:segment`, for the verification harness. */
  const shown = new Map<string, SignalState>();
  group.userData.heads = shown;
  /** The cells by key (`SIGNAL_CELL` of each junction's first head), and each junction's cell. */
  const cells = new Map<number, Cell>();
  const junctionCell = new Map<NodeId, number>();
  /** The network the heads stand on, the junctions' log as last read (`signalChangesSince`), and the land's changes. */
  let placedNetwork: Network | null = null;
  let signalSerial = -1;
  const landRead = new JournalCursor(['terrain', 'elevation']);

  const dropCell = (cell: Cell): void => {
    const batches = cellBlock.get(cell.key);
    if (!batches) return;
    for (const batch of Object.values(batches)) batch.remove(cell.key);
    for (const batch of Object.values(batches)) batch.flush();
    cellBlock.delete(cell.key);
  };
  const dropCells = (): void => {
    for (const cell of cells.values()) dropCell(cell);
    cells.clear();
    junctionCell.clear();
  };

  /** A cell's lenses written again from its heads' states: that cell's run alone. */
  const writeLenses = (cell: Cell): void => {
    const heads = cell.heads;
    const per = LAMPS.length * FACES.length;
    const matrices = new Float32Array(heads.length * per * 16);
    const colours = new Float32Array(heads.length * per * 3);
    const glows = new Float32Array(heads.length * per * 4);
    const haloMatrices: number[] = [];
    const haloColours: number[] = [];
    cell.lit = 0;
    let at = 0;
    for (const head of heads) {
      rootOf(head);
      for (const name of LAMPS) {
        const on = head.state === name;
        for (let face = 0; face < FACES.length; face++) {
          const glow = on ? GLOW_ON : DARK[name].glow;
          const colour = on ? LIT[name] : DARK[name].color;
          glows[at * 4] = glow.r; glows[at * 4 + 1] = glow.g; glows[at * 4 + 2] = glow.b; glows[at * 4 + 3] = on ? 1 : 0;
          colours[at * 3] = colour.r; colours[at * 3 + 1] = colour.g; colours[at * 3 + 2] = colour.b;
          put(matrices, at * 16, lens[name][face] as Matrix4);
          if (on) {
            cell.lit++;
            place.multiplyMatrices(root, halos[name][face] as Matrix4);
            const e = place.elements;
            for (let k = 0; k < 16; k++) haloMatrices.push(e[k]!);
            haloColours.push(HALO[name].r, HALO[name].g, HALO[name].b);
          }
          at++;
        }
      }
    }
    const batches = batchesOf(cell.key, cell.sphere);
    // At the cell's level; out of the other level's batches.
    batches[cell.far ? 'lenses' : 'lensesFar']?.remove(cell.key);
    batches[cell.far ? 'halos' : 'halosFar']?.remove(cell.key);
    batchOf(batches, cell.far ? 'lensesFar' : 'lenses').add(cell.key, matrices, colours, glows, cell.sphere);
    batchOf(batches, cell.far ? 'halosFar' : 'halos').add(cell.key, Float32Array.from(haloMatrices), Float32Array.from(haloColours), null, cell.sphere);
    for (const name of LENSES) batches[name]?.flush();
    cell.stale = false;
  };

  /** A signalised junction's heads, one on each approach of a signal group, where the world stands its post. */
  const junctionOf = (feed: SignalFeed, net: Network, node: NodeId): Junction | null => {
    const layout = feed.layout(node);
    if (!layout?.groups.length) return null;
    const nodeRecord = net.doc.node(node);
    if (!nodeRecord) return null;
    const heads: Head[] = [];
    for (const segmentId of nodeRecord.incident) {
      const segment = net.doc.segment(segmentId);
      if (!segment) continue;
      const signalGroup = layout.groups.find((candidate) => candidate.segments.includes(segmentId));
      if (!signalGroup) continue;
      // Where the post stands is the world's (`world/signalPosts.ts`): the pedestrians walk round the same post.
      const post = signalPostPlace(net, node, segmentId);
      if (!post) continue;
      heads.push({
        x: post.x,
        height: elevationAt(post.x, post.y, segmentId),
        y: post.y,
        // Local +X carries the arm inward over the road.
        yaw: post.yaw,
        groupId: signalGroup.id,
        key: `${node}:${segmentId}`,
        state: null,
      });
    }
    return heads.length ? { node, heads, stage: '' } : null;
  };
  const cellKeyOf = (j: Junction): number => Math.floor(j.heads[0]!.x / SIGNAL_CELL) * 100_003 + Math.floor(j.heads[0]!.y / SIGNAL_CELL);
  /** A cell's batches made again from its junctions: that cell's alone. */
  const buildCell = (key: number, junctions: Junction[]): void => {
    const was = cells.get(key);
    if (was) { dropCell(was); cells.delete(key); }
    if (!junctions.length) return;
    const heads = junctions.flatMap((j) => j.heads);
    let cx = 0, cy = 0, cz = 0;
    for (const h of heads) { cx += h.x; cy += h.height; cz -= h.y; }
    cx /= heads.length; cy /= heads.length; cz /= heads.length;
    let r = 0;
    for (const h of heads) r = Math.max(r, Math.hypot(h.x - cx, h.height - cy, -h.y - cz));
    const sphere = new Sphere(new Vector3(cx, cy, cz), r + HEAD_REACH);
    const frames = new Float32Array(heads.length * 16);
    const shields = new Float32Array(heads.length * visors.length * 16);
    // The level it had, kept: a junction changed does not draw its neighbours' heads in full for a frame.
    const cell: Cell = { key, junctions, heads, sphere, lit: 0, stale: true, far: was?.far ?? false, visors: was?.visors ?? true, shields };
    let f = 0, v = 0;
    for (const head of heads) {
      rootOf(head);
      put(frames, f, HEAD);
      f += 16;
      for (const visor of visors) { put(shields, v, visor); v += 16; }
    }
    const batches = batchesOf(key, sphere);
    batchOf(batches, 'frame').add(key, frames, null, null, sphere);
    if (cell.visors) batchOf(batches, 'visors').add(key, shields, null, null, sphere);
    for (const name of FIXED) batches[name]?.flush();
    for (const name of LENSES) batches[name]?.remove(key);
    for (const name of LENSES) batches[name]?.flush();
    cells.set(key, cell);
  };
  const countLamps = (): void => {
    let lamps = 0;
    for (const cell of cells.values()) lamps += cell.heads.length * LAMPS.length * FACES.length;
    group.userData.lamps = lamps;
  };

  /** @rebuild Every head of the map placed again, cell by cell. */
  const placeAll = (feed: SignalFeed, net: Network): void => {
    dropCells();
    shown.clear();
    const byCell = new Map<number, Junction[]>();
    for (const node of feed.nodes()) {
      const entry = junctionOf(feed, net, node);
      if (!entry) continue;
      const key = cellKeyOf(entry);
      junctionCell.set(node, key);
      const list = byCell.get(key);
      if (list) list.push(entry); else byCell.set(key, [entry]);
    }
    for (const [key, junctions] of byCell) buildCell(key, junctions);
    countLamps();
  };

  /** These junctions placed again, and the cells they left or came into made again. */
  const placeSome = (feed: SignalFeed, net: Network, nodes: Iterable<NodeId>): void => {
    const touched = new Map<number, Junction[]>();
    const cellJunctions = (key: number): Junction[] => {
      let list = touched.get(key);
      if (!list) touched.set(key, list = [...(cells.get(key)?.junctions ?? [])]);
      return list;
    };
    for (const node of new Set(nodes)) {
      const was = junctionCell.get(node);
      if (was !== undefined) {
        const list = cellJunctions(was);
        const at = list.findIndex((j) => j.node === node);
        if (at >= 0) for (const head of list[at]!.heads) shown.delete(head.key);
        if (at >= 0) list.splice(at, 1);
        junctionCell.delete(node);
      }
      const entry = junctionOf(feed, net, node);
      if (!entry) continue;
      const key = cellKeyOf(entry);
      junctionCell.set(node, key);
      cellJunctions(key).push(entry);
    }
    for (const [key, junctions] of touched) buildCell(key, junctions);
    countLamps();
  };

  const eye = new Vector3();
  /** A cell's lenses' and visors' levels for the pixels a world unit spans at its nearest point: the lenses written again at a change (`writeLenses`,
   *  the cell made stale), the visors drawn or let go at once. */
  const levelOf = (cell: Cell, view: SignalView): void => {
    const perUnit = view.orthoPx ?? view.pxAtMetre / Math.max(cell.sphere.distanceToPoint(eye.set(view.x, view.y, view.z)), 1);
    const far = LENS_DEPTH * perUnit < (cell.far ? 1 : COARSEN);
    if (far !== cell.far) { cell.far = far; cell.stale = true; }
    const visorsOn = VISOR_REACH * perUnit >= (cell.visors ? COARSEN : 1);
    if (visorsOn === cell.visors) return;
    cell.visors = visorsOn;
    const batches = batchesOf(cell.key, cell.sphere);
    if (visorsOn) batchOf(batches, 'visors').add(cell.key, cell.shields, null, null, cell.sphere);
    else batches.visors?.remove(cell.key);
    batches.visors?.flush();
  };

  return {
    group,
    sync(feed, net, detailed, frustum, view) {
      if (!detailed) {
        group.visible = false;
        return;
      }
      group.visible = true;
      // DO NOT place every head of the map again on a revision of the network, the traffic, the land or the topology
      const log = feed.changesSince(signalSerial);
      const land = landRead.read(net.doc.changes);
      if (placedNetwork !== net || log.nodes === null || land === null || land.some((e) => e.rects === null)) {
        placedNetwork = net;
        placeAll(feed, net);
      } else {
        const nodes = new Set<NodeId>(log.nodes);
        for (const entry of land) {
          for (const rect of entry.rects!) {
            for (const id of net.segmentCells.idsMeeting(rect)) {
              const segment = net.doc.segment(id);
              if (segment) { nodes.add(segment.a); nodes.add(segment.b); }
            }
          }
        }
        if (nodes.size) placeSome(feed, net, nodes);
      }
      signalSerial = log.serial;
      // DO NOT ask every head of the map each frame, nor write every lens of the map at a change of one.
      let litLenses = 0;
      for (const cell of cells.values()) {
        if (frustum && !frustum.intersectsSphere(cell.sphere)) continue;
        if (view) levelOf(cell, view);
        for (const junction of cell.junctions) {
          const stage = feed.stage(junction.node);
          if (junction.stage === stage && junction.heads[0]!.state !== null) continue;
          junction.stage = stage;
          for (const head of junction.heads) {
            const state = feed.state(junction.node, head.groupId);
            if (head.state === state) continue;
            head.state = state;
            shown.set(head.key, state);
            cell.stale = true;
          }
        }
        if (cell.stale) writeLenses(cell);
        litLenses += cell.lit;
      }
      group.userData.litLamps = litLenses;
    },
    dispose() {
      scene.remove(group);
      dropCells();
      for (const batches of blocks.values()) for (const batch of Object.values(batches)) batch.dispose();
      blocks.clear();
      group.clear();
      shown.clear();
      for (const geometry of [
        postGeometry,
        armGeometry,
        housingGeometry,
        frameGeometry,
        lensGeometry,
        haloGeometry,
        visorGeometry,
        lensFarGeometry,
        haloFarGeometry,
      ]) {
        geometry.dispose();
      }
      const materials: Material[] = [frame, frameDepth, housing, lenses, halo];
      for (const material of materials) material.dispose();
    },
  };
}
