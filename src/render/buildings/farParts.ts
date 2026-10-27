import { Box3, type BufferGeometry, Group, InstancedBufferAttribute, InstancedInterleavedBuffer, InstancedMesh, type Material, Sphere, Vector3 } from 'three';

import { CELL } from '@world/cells';

import { HYSTERESIS } from '../cellInstances';
import { PICTURE_PX } from '../plantImpostors';
import { ERROR_PIXELS } from '../propLevels';
import { COLOURED_PARTS } from './cellArrays';
import { partLook } from './fade';
import type { BuildingKit, PartKind, PartLevel } from './kit';
import { PART_KINDS } from './partKinds';
import { BAR_PIXELS, type PartCell, widestBar } from './partCells';
import { PICTURE_ORDER } from './partPictures';
import type { PartFiling } from './partFiling';
import { POSE_FLOATS, letGoPosed, partPoseDepth, posedCopy } from './partPose';
import { SHELL_PARTS } from './shellParts';

/** THE FACADE LEVEL'S DETAIL PARTS, ONE DRAW A KIND FOR THE WHOLE TOWN */
// A cell at its facade level (L1, `emitChunk` far) drew every part kind from its own filing: one draw a kind a cell, and twenty
// a cell over the view (the player's lab, 2026-10-20: 257 draws and 5.7 ms of the scene at a small city). The kinds the facade
// shader does not draw (frames, sills, fins, railings, awnings, props) are collected here instead: one InstancedMesh a kind over
// every facade cell, drawn at the kind's coarsest level of the kit's own (a frame's card, a sill's top face: the level that far view
// is made for), its instances added and taken out as cells come and go. A small prop's simplified levels (`kit.ts` SIMPLIFIED) are
// drawn only where their measured error spans under `ERROR_PIXELS` at every instance (`choose`): DO NOT draw a prop at its coarsest
// level whatever the distance, a balcony's plants lost their leaves and its pots were crumpled 3.8 px off at 300 m (the far batch's
// sheets, 2026-10-24). The shell's own parts (lot boxes, rails, slabs) stay per cell: their coarse level is a top face, and a
// yard's wall at a facade cell is still tens of pixels tall. A prop with a picture (`partPictures.ts`) is drawn as it where the nearest cell's
// instances span under `PICTURE_PX`, as the near cells draw it; its shadow is still its model's level's, cast by a caster of its own.

/** A cell's instances of one kind in the batch: a contiguous run of the kind's buffers. */
interface Run {
  readonly cell: string;
  /** The cell's column and row on the world grid (`CELL`), read from its key once (DO NOT split the key for every run of every kind each frame: `view` runs every frame over every run of the town's facade cells). */
  readonly i: number;
  readonly j: number;
  start: number;
  count: number;
  /** A kind made of bars (`PartScreen.pieces`): its instances' widest bar in this cell, m; NaN for a solid kind. */
  readonly bar: number;
  /** Its instances' largest scale along any of the model's axes in this cell (`FiledBand.scale`, the cell's): what a level's error is scaled by. */
  readonly scale: number;
}

/** One kind over every facade cell: its master buffers, its mesh, and each cell's run. */
interface KindBatch {
  readonly kind: PartKind;
  /** The level it is drawn at unless a measured one is within the bound (`choose`): the kit's own coarsest (a card, a top face; a small prop's finest). */
  readonly base: PartLevel;
  /** The level drawn now: its model or its picture, and its triangles an instance for the view's budget. */
  level: PartLevel;
  /** Its model's level now (`level` unless that is its picture): what it casts. */
  model: PartLevel;
  /** Its model's level cast while its picture is drawn (a picture casts nothing): drawn into the near cascades alone (`castShadow`); null until first needed. */
  caster: InstancedMesh | null;
  /** Each level's copy posed by `poses` made so far, by its model: the one drawn is the mesh's geometry, the others kept for the eye's way back. */
  readonly copies: Map<BufferGeometry, BufferGeometry>;
  readonly material: Material;
  readonly mesh: InstancedMesh;
  poses: InstancedInterleavedBuffer;
  colours: InstancedBufferAttribute | null;
  capacity: number;
  used: number;
  readonly runs: Run[];
}

/** A kind's coarsest level of the kit's own: the last with no measured error (the simplified levels of a small prop are measured, `kit.ts`), not its picture. */
function baseLevel(levels: readonly PartLevel[]): PartLevel {
  let base = levels[0]!;
  for (const level of levels) if (level.measured === undefined && !level.picture) base = level;
  return base;
}

/** A posed copy let go with nothing of its own freed: its model's attributes and the batch's poses, shared with the other copies, taken off
 *  first (three frees every attribute a disposed geometry holds, r186 `WebGLGeometries` onGeometryDispose; its vertex array goes alone). */
function letGoBare(g: BufferGeometry): void {
  for (const name of Object.keys(g.attributes)) g.deleteAttribute(name);
  g.setIndex(null);
  g.dispose();
}

export class FarPartBatch {
  readonly group = new Group();
  private readonly kinds = new Map<PartKind, KindBatch>();
  private readonly cells = new Set<string>();
  private readonly drawn = new Map<string, number>();
  /** Each cell's instances' world box (every kind), for the shadows: a cell come or gone changes the sun's stores under its box alone (`renderer.ts` casterChanges reads each mesh's `castBox`, and its `wholeBox` when the mesh is shown or hidden). */
  private readonly boxes = new Map<string, Box3>();
  private faded = false;
  private casting = true;

  /** `changed`: told when a kind is drawn at another level and what the batch draws of a cell changed with it (`choose`): the view's budget reads `trianglesOf`. */
  constructor(private readonly kit: BuildingKit, private readonly changed: () => void = () => {}) {
    this.group.name = 'building-far-parts';
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    for (const kind of PART_KINDS) {
      if (SHELL_PARTS.has(kind)) continue;
      const level = baseLevel(kit.screen[kind].levels);
      const capacity = 256;
      const poseBuffer = new InstancedInterleavedBuffer(new Float32Array(capacity * POSE_FLOATS), POSE_FLOATS);
      const material = partLook(kit, kind, false).material;
      const geometry = posedCopy(level.geometry, poseBuffer, 0);
      const mesh = new InstancedMesh(geometry, material, 0);
      mesh.name = `building-${kind}`;
      // A card casts nothing (`kit.ts` cards): its face would cast whole.
      mesh.castShadow = kit.castsShadow.has(kind) && !level.card;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = partPoseDepth(material);
      // One draw a kind over the whole town: it is not culled by a piece's bounds (the pieces stand everywhere).
      mesh.frustumCulled = false;
      // Its bounds ours (`tellBoxes`), never three's: three sorts a mesh by its sphere even unculled (r186 `projectObject`), and works one out
      // from the instances' matrices when it has none - these have none (the poses are the instances, `posePart`). It read 16 numbers past the
      // end for each of tens of thousands of pieces, and the undefined it wrote into its scratch matrix made V8 make every Matrix4 of the game
      // a holey array from then on: every matrix read in the game boxed its numbers (three's `applyMatrix4` 188 MB a million calls, measured
      // 2026-10-24).
      mesh.boundingBox = new Box3();
      mesh.boundingSphere = new Sphere(new Vector3(), 0);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.count = 0;
      mesh.visible = false;
      if (COLOURED_PARTS.has(kind)) {
        mesh.instanceColor = new InstancedBufferAttribute(new Uint16Array(capacity * 3), 3);
        (mesh.instanceColor as unknown as { isFloat16BufferAttribute: boolean }).isFloat16BufferAttribute = true;
      }
      this.group.add(mesh);
      this.kinds.set(kind, {
        kind, base: level, level, model: level, caster: null, copies: new Map([[level.geometry, geometry]]), material, mesh, poses: poseBuffer,
        colours: mesh.instanceColor, capacity, used: 0, runs: [],
      });
    }
  }

  /** The level `batch` is drawn at where a model unit of its instances spans at most `worst` pixels: its base, or the coarsest of its measured
   *  levels whose error spans at most `ERROR_PIXELS` there (`propLevels.ts`, the owner's ladder's bound: the swap is not seen), entered under the
   *  bound narrowed by the band a level is held in (`cellInstances.ts` HYSTERESIS) and held up to it. The levels are read as the kit has them now:
   *  a small prop's simplified ones come in once the simplifier has loaded (`kit.ts` levelsReady). */
  private choose(batch: KindBatch, worst: number): void {
    const levels = this.kit.screen[batch.kind].levels;
    let pick = batch.base;
    for (const level of levels) {
      if (level.measured === undefined) continue;
      const bound = level === batch.model ? ERROR_PIXELS : ERROR_PIXELS / (1 + HYSTERESIS);
      if (level.measured * worst <= bound) pick = level;
    }
    // Its picture (its last level) where its instances span under `PICTURE_PX` at the most (held up to it, entered under the band narrowed as
    // above), once taken, and never faded (the faded material draws a model).
    const last = levels[levels.length - 1]!, picture = last.picture;
    const shown = picture && !this.faded && picture.ready() && picture.across * worst < PICTURE_PX / (last === batch.level ? 1 : 1 + HYSTERESIS) ? last : pick;
    if (shown !== batch.level || pick !== batch.model) this.draw(batch, shown, pick);
  }

  /** `level`'s copy posed by the batch's poses: made once, kept. */
  private copyOf(batch: KindBatch, level: PartLevel): BufferGeometry {
    let copy = batch.copies.get(level.geometry);
    if (!copy) {
      copy = posedCopy(level.geometry, batch.poses, 0);
      batch.copies.set(level.geometry, copy);
    }
    return copy;
  }

  /** `batch` drawn at `level` (its model's level `model`): its copy posed by the batch's poses, its material, what casts; each cell's triangles
   *  counted again at it (`trianglesOf`). */
  private draw(batch: KindBatch, level: PartLevel, model: PartLevel): void {
    batch.mesh.geometry = this.copyOf(batch, level);
    const look = partLook(this.kit, batch.kind, this.faded);
    batch.mesh.material = level.picture?.material ?? look.material;
    // First of the blended things, over what is drawn solid, as its model is (`partPictures.ts` PICTURE_ORDER).
    batch.mesh.renderOrder = level.picture ? PICTURE_ORDER : look.renderOrder;
    batch.level = level;
    batch.model = model;
    const casts = this.kit.castsShadow.has(batch.kind) && !model.card;
    // A picture casts nothing: its model's level does, by the caster.
    batch.mesh.castShadow = casts && !level.picture;
    if (level.picture && casts && !batch.caster) batch.caster = this.makeCaster(batch);
    if (batch.caster) {
      batch.caster.geometry = this.copyOf(batch, model);
      batch.caster.castShadow = casts && level.picture !== undefined;
    }
    // Every instance of the kind drawn otherwise casts another shadow: the sun's kept stores told so over the cells' boxes. DO NOT leave it to
    // the geometry's id the casters' signature hashes: a batch that keeps a `castBox` is taken by that box alone, empty since the last pass, and
    // the stores kept the shadows of the level drawn before (`renderer.ts` casterChanges).
    const whole = new Box3();
    for (const box of this.boxes.values()) whole.union(box);
    if (!whole.isEmpty()) {
      for (const mesh of meshesOf(batch)) {
        const kept = mesh.userData['castBox'] as Box3 | undefined;
        if (kept) kept.union(whole); else mesh.userData['castBox'] = whole.clone();
      }
    }
    for (const cell of this.drawn.keys()) this.drawn.set(cell, 0);
    for (const each of this.kinds.values()) for (const run of each.runs) this.drawn.set(run.cell, (this.drawn.get(run.cell) ?? 0) + run.count * each.level.triangles);
    this.changed();
  }

  /** The cells of `cells` the view draws at their facade level (`shown`) are in the batch: those that came are copied in, those gone taken out. */
  sync(cells: ReadonlyMap<string, PartCell>, shown: (key: string) => boolean): void {
    for (const key of this.cells) if (!cells.has(key) || !shown(key)) this.remove(key);
    for (const [key, cell] of cells) if (!this.cells.has(key) && shown(key)) this.add(key, cell.filing);
  }

  /** Each kind drawn only while its pieces span a pixel where the nearest cell stands: a balcony a kilometre off is under one, and only its cost is left (the near cells hide them so, `partCells.ts` `levelAt`); each at the level its error on the screen allows (`choose`). */
  view(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null): void {
    for (const batch of this.kinds.values()) {
      if (batch.used === 0) { batch.mesh.visible = false; continue; }
      const extent = this.kit.screen[batch.kind].extent;
      const across = Math.hypot(extent[0], extent[1], extent[2]);
      let nearest = Infinity;
      /** A kind of bars: drawn while some cell's bars span half a pixel where it stands (`partCells.ts` BAR_PIXELS). DO NOT judge them by their whole diagonal at the nearest cell: every facade cell's window frames, 6 cm bars a fifth of a pixel wide that the facade shader already paints, were drawn over the town (5 M triangles of a district's frame, 2026-10-20). */
      let barPixels = 0;
      /** The most pixels a model unit of the kind spans at any of its instances: each cell's largest scale where the cell stands. */
      let worst = 0;
      for (const run of batch.runs) {
        // A run's key is its facade cell's (the world grid's CELL, 250 m), not a 50 m sub-cell's: read on the sub-cell's side, each run stood a fifth of the way to the origin.
        const x0 = run.i * CELL, y0 = run.j * CELL;
        const dx = Math.max(x0 - eyeX, 0, eyeX - (x0 + CELL));
        const dy = Math.max(y0 - eyeY, 0, eyeY - (y0 + CELL));
        // Three's world: the plan's y is -z; the eye's height over the cell's ground is the third term.
        const dz = Math.max(0, eyeZ);
        const distance = Math.hypot(dx, dy, dz);
        if (distance < nearest) nearest = distance;
        const pixels = orthoPx !== null ? orthoPx : pxAtMetre / Math.max(distance, 1);
        if (run.bar > 0) barPixels = Math.max(barPixels, run.bar * pixels);
        worst = Math.max(worst, run.scale * pixels);
      }
      this.choose(batch, worst);
      if (batch.runs.length && !Number.isNaN(batch.runs[0]!.bar)) { batch.mesh.visible = barPixels >= BAR_PIXELS; continue; }
      const perMetre = orthoPx !== null ? orthoPx : pxAtMetre / Math.max(nearest, 1);
      // As the near cells hide an instance under a pixel across its diagonal (`partCells.ts` `levelAt`).
      batch.mesh.visible = across * perMetre >= 1;
    }
  }

  /** A kind's caster (`KindBatch.caster`): its instances at its model's level, its depth material, drawn into the near cascades alone. */
  private makeCaster(batch: KindBatch): InstancedMesh {
    const material = partLook(this.kit, batch.kind, false).material;
    const caster = new InstancedMesh(this.copyOf(batch, batch.model), material, 0);
    caster.name = `building-${batch.kind}-caster`;
    caster.customDepthMaterial = partPoseDepth(material);
    // Drawn in the cascades alone: the casters' signature reads it hidden (`renderer.ts` casterChanges).
    caster.userData['shadowOnly'] = true;
    caster.castShadow = true;
    caster.receiveShadow = false;
    caster.frustumCulled = false;
    // Its bounds the batch's (`tellBoxes`), as its mesh's.
    caster.boundingBox = batch.mesh.boundingBox!.clone();
    caster.boundingSphere = batch.mesh.boundingSphere!.clone();
    caster.userData['wholeBox'] = batch.mesh.userData['wholeBox'];
    caster.matrixAutoUpdate = false;
    caster.updateMatrix();
    caster.count = batch.used;
    caster.visible = false;
    this.group.add(caster);
    return caster;
  }

  /** Every instance let go (a lost context's cells asked again): the buffers kept, nothing drawn until cells land. */
  clear(): void {
    for (const batch of this.kinds.values()) {
      batch.used = 0;
      batch.runs.length = 0;
      for (const mesh of meshesOf(batch)) mesh.count = 0;
      batch.mesh.visible = false;
    }
    this.cells.clear();
    this.drawn.clear();
    this.boxes.clear();
    this.tellBoxes(null);
  }

  /** The meshes told where their instances stand: `changed`, the box of the cell that came or went, joined into each mesh's `castBox`; every mesh's `wholeBox` the union of every cell's. */
  private tellBoxes(changed: Box3 | null): void {
    const whole = new Box3();
    for (const box of this.boxes.values()) whole.union(box);
    for (const batch of this.kinds.values()) {
      for (const mesh of meshesOf(batch)) {
        const data = mesh.userData;
        data['wholeBox'] = whole;
        mesh.boundingBox!.copy(whole);
        if (whole.isEmpty()) mesh.boundingSphere!.set(new Vector3(), 0); else whole.getBoundingSphere(mesh.boundingSphere!);
        if (changed) {
          const kept = data['castBox'] as Box3 | undefined;
          if (kept) kept.union(changed); else data['castBox'] = changed.clone();
        }
      }
    }
  }

  /** Its instances drawn at the coarsest level the far view was made for. */
  setFaded(faded: boolean): void {
    if (faded === this.faded) return;
    this.faded = faded;
    for (const batch of this.kinds.values()) {
      // A picture is not drawn faded: its model's level is (`choose` takes the picture back once shown again).
      if (faded && batch.level.picture) this.draw(batch, batch.model, batch.model);
      const look = partLook(this.kit, batch.kind, faded);
      batch.mesh.material = look.material;
      batch.mesh.customDepthMaterial = partPoseDepth(look.material);
      batch.mesh.renderOrder = look.renderOrder;
      batch.mesh.visible = batch.used > 0 && look.visible;
    }
  }

  /** The far cascades take the buildings by their masses alone: the batch casts nothing (`layer.ts` `castInto`). `over`: the passes are over -
   *  a kind drawn as its picture casts by its caster, shown for the near cascades' passes alone and hidden between them, as its signature reads it. */
  castShadow(cast: boolean, over = false): void {
    for (const batch of this.kinds.values()) if (batch.caster) batch.caster.visible = cast && !over && batch.mesh.visible && batch.level.picture !== undefined;
    if (cast === this.casting) return;
    this.casting = cast;
    this.group.visible = cast;
  }

  /** The triangles the batch draws of a cell, for the view's budget. */
  trianglesOf(cell: string): number {
    return this.drawn.get(cell) ?? 0;
  }

  dispose(): void {
    for (const batch of this.kinds.values()) {
      this.letGoCopies(batch);
      for (const mesh of meshesOf(batch)) mesh.dispose();
    }
    this.group.clear();
    this.cells.clear();
    this.drawn.clear();
  }

  /** Every copy of `batch` let go: the one drawn frees the poses (`letGoPosed`, the kit's model kept), the others before it with nothing of their own. */
  private letGoCopies(batch: KindBatch): void {
    for (const copy of batch.copies.values()) if (copy !== batch.mesh.geometry) letGoBare(copy);
    batch.copies.clear();
    letGoPosed(batch.mesh.geometry, batch.level.geometry);
  }

  /** A cell drawn at its facade level: its instances of every batched kind, each at the level its kind is drawn at. */
  private add(cell: string, filing: PartFiling): void {
    this.cells.add(cell);
    const comma = cell.indexOf(',');
    const i = Number(cell.slice(0, comma)), j = Number(cell.slice(comma + 1));
    let triangles = 0;
    const box = new Box3();
    for (const band of filing.bands) {
      const batch = this.kinds.get(band.kind);
      if (!batch) continue;
      const count = band.start[band.start.length - 1]!;
      if (!count) continue;
      // Where the band's instances stand: each pose's place, its model's extent at its scale round it (`partPose.ts`: x, y, z, cos, sin, sx, sy, sz).
      const extent = this.kit.screen[band.kind].extent;
      for (let k = 0; k < count; k++) {
        const o = k * POSE_FLOATS;
        const reach = Math.hypot(band.poses[o + 5]! * extent[0], band.poses[o + 6]! * extent[1], band.poses[o + 7]! * extent[2]);
        box.expandByPoint(reachPoint.set(band.poses[o]! - reach, band.poses[o + 1]! - reach, band.poses[o + 2]! - reach));
        box.expandByPoint(reachPoint.set(band.poses[o]! + reach, band.poses[o + 1]! + reach, band.poses[o + 2]! + reach));
      }
      const start = batch.used;
      this.grow(batch, start + count);
      (batch.poses.array as Float32Array).set(band.poses, start * POSE_FLOATS);
      if (batch.colours && band.colours) (batch.colours.array as Uint16Array).set(band.colours, start * 3);
      const screen = this.kit.screen[band.kind];
      const bar = screen.pieces[0] !== screen.extent ? widestBar(screen.pieces, band.scale) : Number.NaN;
      // The cell's largest scales, after its sub-cells' (`FiledBand.scale`).
      const s = band.scale, last = s.length - 3;
      batch.runs.push({ cell, i, j, start, count, bar, scale: Math.max(s[last]!, s[last + 1]!, s[last + 2]!) });
      batch.used += count;
      for (const mesh of meshesOf(batch)) mesh.count = batch.used;
      batch.mesh.visible = true;
      dirty(batch, start, count);
      triangles += count * batch.level.triangles;
    }
    this.drawn.set(cell, triangles);
    this.group.visible = this.casting;
    if (!box.isEmpty()) { this.boxes.set(cell, box); this.tellBoxes(box); }
  }

  /** A cell gone from the facade level: its runs taken out and the runs after each moved down (the buffers kept compact). */
  private remove(cell: string): void {
    if (!this.cells.delete(cell)) return;
    this.drawn.delete(cell);
    const box = this.boxes.get(cell);
    this.boxes.delete(cell);
    if (box) this.tellBoxes(box);
    for (const batch of this.kinds.values()) {
      for (let i = batch.runs.length - 1; i >= 0; i--) {
        const run = batch.runs[i]!;
        if (run.cell !== cell) continue;
        const end = run.start + run.count;
        const tail = batch.used - end;
        if (tail > 0) {
          (batch.poses.array as Float32Array).copyWithin(run.start * POSE_FLOATS, end * POSE_FLOATS, batch.used * POSE_FLOATS);
          if (batch.colours) (batch.colours.array as Uint16Array).copyWithin(run.start * 3, end * 3, batch.used * 3);
          for (const other of batch.runs) if (other !== run && other.start >= end) other.start -= run.count;
        }
        batch.runs.splice(i, 1);
        batch.used -= run.count;
        for (const mesh of meshesOf(batch)) mesh.count = batch.used;
        batch.mesh.visible = batch.used > 0;
        dirty(batch, run.start, Math.max(0, batch.used - run.start));
        if (tail < 0) break;
      }
    }
  }

  /** Room for `need` instances: the buffers made again, what is drawn kept. */
  private grow(batch: KindBatch, need: number): void {
    if (need <= batch.capacity) return;
    let capacity = batch.capacity;
    while (capacity < need) capacity *= 2;
    const poses = new Float32Array(capacity * POSE_FLOATS);
    poses.set(batch.poses.array as Float32Array);
    const poseBuffer = new InstancedInterleavedBuffer(poses, POSE_FLOATS);
    // Three frees an InstancedMesh's instance buffers only on its dispose (r186 `WebGLObjects` onInstancedMeshDispose): let the old colour buffer go before it is replaced, or its GPU buffer is never freed.
    batch.mesh.dispose();
    // Every copy was posed by the old poses: let go with them, the one drawn made again on the new ones.
    this.letGoCopies(batch);
    const copy = posedCopy(batch.level.geometry, poseBuffer, 0);
    batch.copies.set(batch.level.geometry, copy);
    batch.mesh.geometry = copy;
    batch.poses = poseBuffer;
    if (batch.caster) batch.caster.geometry = this.copyOf(batch, batch.model);
    if (batch.colours) {
      const colours = new Uint16Array(capacity * 3);
      colours.set(batch.colours.array as Uint16Array);
      batch.mesh.instanceColor = new InstancedBufferAttribute(colours, 3);
      (batch.mesh.instanceColor as unknown as { isFloat16BufferAttribute: boolean }).isFloat16BufferAttribute = true;
      batch.colours = batch.mesh.instanceColor;
    }
    batch.capacity = capacity;
  }
}

const reachPoint = new Vector3();

/** A batch's meshes: the one drawn, and its caster once made. */
const meshesOf = (batch: KindBatch): InstancedMesh[] => (batch.caster ? [batch.mesh, batch.caster] : [batch.mesh]);

/** The run's poses and colours sent to the GPU, its range only. DO NOT clear the ranges a change already added: every cell added or taken out this frame adds its own, and three merges and clears them once, after the upload (r186 `WebGLAttributes.updateBuffer`). */
function dirty(batch: KindBatch, start: number, count: number): void {
  if (count <= 0) return;
  const poses = batch.poses;
  poses.addUpdateRange(start * POSE_FLOATS, count * POSE_FLOATS);
  poses.needsUpdate = true;
  if (batch.colours) {
    batch.colours.addUpdateRange(start * 3, count * 3);
    batch.colours.needsUpdate = true;
  }
}
