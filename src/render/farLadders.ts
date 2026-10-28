import { InstancedBufferAttribute, InstancedInterleavedBuffer, MeshDepthMaterial, Matrix4, Vector4, type Box3, type InstancedMesh, type InterleavedBuffer, type Material } from 'three';
import type { KindLevels } from './cellInstances';
import { fillArrays, gpuOnlyAttributes } from './mesh/gpuOnly';

/**
 * A FAR BLOCK'S STREET PROPS AT THEIR OWN LEVELS (`propCells.ts`): a kind with a ladder (`KindLevels.mid`, `far`, `least`, `propLevels.ts`) has
 * its batches at each level sharing one buffer of poses, and each thing is drawn by the GPU at the level its own size on the screen calls for:
 * the near cells' bars, no band (a far thing's level is its size's, frame by frame). A level's batches are shown only where some thing of the
 * block can be in its band (`showLadder`): the district's tiny benches draw no model's triangles.
 */

/** One level of a far ladder: its batches, and the band of sizes on the screen they draw a thing in (`FarBands.of`, the GPU's per thing). */
export interface FarRung {
  readonly meshes: readonly InstancedMesh[];
  /** Device pixels across: from `x`, under `y` (the material's own numbers: `x` moved down to the cut while the pictures are not taken). */
  readonly band: Vector4;
  /** Its lowest bar when the pictures are taken, and while they are not (the cut: it draws their band too). */
  readonly floor: number;
  readonly floorUnpictured: number;
}

/** A kind of a far block drawn by its ladder. */
export interface FarLadder {
  readonly levels: KindLevels;
  /** Its things' feet (three's frame): what their size on the screen is measured at. */
  readonly feet: Box3;
  /** Its things' sizes, world units across (`KindLevels.reach` doubled, times their largest scale): the cells' own measure. */
  readonly largest: number;
  readonly smallest: number;
  /** Near, mid (none where its simplified models were not made when the block was). */
  readonly rungs: readonly FarRung[];
  /** The pictures' rung: drawn once they are taken. */
  readonly pictures: FarRung | null;
  /** Its things sorted into every rung's own buffers (`sortLadder`): the shadows' rungs too. */
  readonly sort: LadderSort;
}

/**
 * A FAR LADDER'S THINGS SORTED INTO THEIR RUNGS ON THE CPU: each rung (near, mid, their shadows, the pictures) draws from buffers of its own
 * holding only the things whose size on the screen may be in its band (its bars widened by `SORT_SLACK`), the shader's band test still drawing
 * each in exactly one (`BAND_GLSL`). DO NOT give every rung the kind's whole buffer of poses: each drew every thing of the block and dropped
 * those out of its band in the vertex shader, the near model shaded for the things drawn as pictures (the F7 audit: 1.78 M triangles shaded
 * and dropped, MISSION.md 3b). Sorted again only when a thing's size may have moved past the slack (`stillSorted`), or the pictures came.
 */
export interface LadderSort {
  /** The kind's things as placed: `stride` floats of pose a thing (its foot first, three's frame), 3 of tint (none: not tinted), its largest scale. */
  readonly poses: Float32Array;
  readonly tints: Float32Array | null;
  readonly scales: Float32Array;
  readonly stride: number;
  /** The kind's measure, model units (`KindLevels.reach`): a thing is `2 * reach * scale` across. */
  readonly reach: number;
  readonly rungs: readonly SortedRung[];
  /** The view's 16 numbers, the pixels a unit spans at w 1 and whether the pictures were taken, at the last sort (`unsorted`: NaN, never). */
  readonly at: Float64Array;
}

/** A rung's buffers as `sortLadder` fills them: its band (the material's numbers), its meshes, how many things it holds. */
export interface SortedRung {
  readonly band: Vector4;
  readonly meshes: readonly InstancedMesh[];
  /** A shadow alone (`KindLevels.shadowNear`): not one of `showLadder`'s rungs, shown wherever it holds a thing. */
  readonly shadowAlone: boolean;
  count: number;
  /** Its things' poses and tints handed to its buffers (a whole array each, their size fixed: three r186 resizes no buffer). */
  send(poses: Float32Array, tints: Float32Array | null): void;
}

/** What a sorted rung's meshes are drawn from: its own buffers, and the rung. */
export interface RungBuffers { readonly poses: InstancedInterleavedBuffer; readonly tints: InstancedBufferAttribute | null; readonly rung: SortedRung }

/**
 * A rung of `sort` of band `band`, its own buffers and the meshes `made` on them: GPU-only (`mesh/gpuOnly.ts`), made empty and given a whole
 * buffer of its things by each sort (`send`), the size of the kind's every thing each time (three r186 resizes no buffer); `sent` told at each
 * upload. DO NOT give a rung arrays before its first sort: one that never holds a thing kept them on the CPU, never uploaded.
 */
export function sortedRung(sort: LadderSort, band: Vector4, shadowAlone: boolean, made: (on: RungBuffers) => InstancedMesh[], sent: () => void): InstancedMesh[] {
  const poses = new InstancedInterleavedBuffer(new Float32Array(0), sort.stride);
  const tints = sort.tints ? new InstancedBufferAttribute(new Float32Array(0), 3) : null;
  // The things it can hold, as a buffer of its arrays' size counts them (three r186 sets `count` from the array it is made with alone).
  poses.count = sort.scales.length;
  const list: InstancedMesh[] = [];
  const rung: SortedRung = {
    band, shadowAlone, count: 0, meshes: list,
    send(p, t) {
      // Nothing in it: its meshes are hidden, its buffers left as they were (`sortLadder`).
      if (rung.count === 0 || !list[0]) return;
      fillArrays(list[0], t ? { poses: p, tints: t } : { poses: p });
    },
  };
  list.push(...made({ poses, tints, rung }));
  // Given its things again after a lost context, as the last sort chose them (`mesh/gpuOnly.ts` refillArrays).
  if (list[0]) gpuOnlyAttributes(list[0], tints ? { poses, tints } : { poses }, () => {
    const again = rungArrays(sort, rung, sort.at.subarray(0, 16), sort.at[16]!);
    rung.count = again.count;
    return again.tints ? { poses: again.poses, tints: again.tints } : { poses: again.poses };
  });
  const letGo = poses.onUploadCallback;
  poses.onUpload(function (this: InterleavedBuffer) {
    letGo.call(this);
    sent();
  });
  (sort.rungs as SortedRung[]).push(rung);
  return list;
}

/** How far a thing's size on the screen may move before its ladder is sorted again: a rung holds the things within its band widened by it. */
const SORT_SLACK = 1.25;
/** The numbers a sort is made for (`LadderSort.at`). */
const SORTED_AT = 18;
/** A sort never made. */
export const unsorted = (): Float64Array => new Float64Array(SORTED_AT).fill(Number.NaN);

/** A rung's things for the view of elements `e` and `per` pixels a unit at w 1: their poses and tints in order, a whole buffer's worth, and
 *  their count. A thing's size is the band's own measure (`BAND_GLSL`: clip w at its foot, its largest scale). None before any sort. */
function rungArrays(sort: LadderSort, rung: SortedRung, e: ArrayLike<number>, per: number): { poses: Float32Array; tints: Float32Array | null; count: number } {
  const { stride, scales, reach } = sort;
  const n = scales.length;
  const poses = new Float32Array(n * stride), tints = sort.tints ? new Float32Array(n * 3) : null;
  if (Number.isNaN(per)) return { poses, tints, count: 0 };
  const lo = rung.band.x / SORT_SLACK, hi = rung.band.y * SORT_SLACK;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const w = e[3]! * sort.poses[o]! + e[7]! * sort.poses[o + 1]! + e[11]! * sort.poses[o + 2]! + e[15]!;
    const across = (2 * reach * scales[i]! * per) / Math.max(w, 1e-4);
    if (across < lo || across >= hi) continue;
    poses.set(sort.poses.subarray(o, o + stride), count * stride);
    if (tints) tints.set(sort.tints!.subarray(i * 3, i * 3 + 3), count * 3);
    count++;
  }
  return { poses, tints, count };
}

/** Whether every thing's size on the screen is within `SORT_SLACK` of its size at the last sort: its clip w then over its w now is a ratio of
 *  two linear functions, at its least and most at a corner of the feet's box while both stay before the eye. */
function stillSorted(at: Float64Array, e: ArrayLike<number>, per: number, pictured: boolean, feet: Box3): boolean {
  if (Number.isNaN(at[16]!) || at[17] !== (pictured ? 1 : 0)) return false;
  let least = Infinity, most = 0;
  for (const x of [feet.min.x, feet.max.x]) for (const y of [feet.min.y, feet.max.y]) for (const z of [feet.min.z, feet.max.z]) {
    const was = at[3]! * x + at[7]! * y + at[11]! * z + at[15]!;
    const now = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
    if (!(was > 1e-4 && now > 1e-4)) return false;
    least = Math.min(least, was / now);
    most = Math.max(most, was / now);
  }
  const zoom = per / at[16]!;
  return least * zoom >= 1 / SORT_SLACK && most * zoom <= SORT_SLACK;
}

/** A far ladder's things sorted into its rungs for this view (after `showLadder`, which sets the bands), when a size may have moved past the
 *  slack since the last sort; each rung's meshes drawing its count, none drawn where it holds nothing. */
export function sortLadder(ladder: FarLadder, view: Matrix4, perUnitAtOne: number): void {
  const sort = ladder.sort, e = view.elements;
  const pictured = ladder.pictures !== null && (ladder.levels.ready?.() ?? true);
  if (!stillSorted(sort.at, e, perUnitAtOne, pictured, ladder.feet)) {
    for (const rung of sort.rungs) {
      const { poses, tints, count } = rungArrays(sort, rung, e, perUnitAtOne);
      rung.count = count;
      rung.send(poses, tints);
    }
    sort.at.set(e, 0);
    sort.at[16] = perUnitAtOne;
    sort.at[17] = pictured ? 1 : 0;
  }
  for (const rung of sort.rungs) {
    for (const mesh of rung.meshes) {
      // A shadow alone draws nothing in the colour pass: its count is the cascades' alone (`castBySize` counts).
      mesh.count = rung.shadowAlone ? 0 : rung.count;
      if (rung.shadowAlone) mesh.visible = rung.count > 0;
      else if (rung.count === 0) mesh.visible = false;
    }
  }
}

/** The near square as `propCells.ts` holds it: its middle cell and how many cells it reaches each way (-1: none), cells `cell` world units wide. */
export interface FarSquare { readonly cx: number; readonly cy: number; readonly k: number }

/** In place of three's `begin_vertex`, after it: a far batch's thing (its pose's cell, `instanceRuns.ts` nearCode) outside its rung's band
 *  of sizes on the screen (`uBand` x to y, device pixels, its kind's measure `uBand.z` across times its largest scale) is not drawn - every
 *  vertex at its foot. The cells' own measure (`cellInstances.ts` visit): clip w at the foot, of the view the cells were culled for. */
const BAND_GLSL = /* glsl */ `
  #ifdef USE_INSTANCING
  if (instancePoseB.w >= 0.0) {
    float bandScale = max(length(instanceMatrix[0].xyz), max(length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)));
    vec4 bandClip = uBandView * vec4(instanceMatrix[3].xyz, 1.0);
    float bandPerUnit = length(vec3(uBandView[0][1], uBandView[1][1], uBandView[2][1])) * uBandHalf / max(bandClip.w, 1e-4);
    float bandAcross = 2.0 * uBand.z * bandScale * bandPerUnit;
    if (bandAcross < uBand.x || bandAcross >= uBand.y) transformed = vec3(0.0);
  }
  #endif
`;

/** A far rung's materials: its kind's own, drawing only the things in its band, and their shadow's; the band's numbers (`FarRung.band`). */
export interface Banded { readonly material: Material; readonly depth: MeshDepthMaterial; readonly band: Vector4 }

/** A layer's far rungs' materials, sized by the view its cells are culled for (`setView`): a thing's shadow drawn at the level its colour is. */
export interface FarBands {
  /** A kind's `material` drawing its far batches' things `reach` x 2 across from `lo` to under `hi` pixels (`role`: the rung): made once a
   *  kind and rung, shared by every far block. One program for every band, and one for their shadows ('far-band'): their numbers uniforms. */
  of(material: Material, role: string, reach: number, lo: number, hi: number): Banded;
  setView(view: Matrix4, halfHeight: number): void;
  dispose(): void;
}

export function createFarBands(): FarBands {
  const view = { value: new Matrix4() }, half = { value: 540 };
  const made = new Map<Material, Map<string, Banded>>();
  const patch = <M extends Material>(material: M, values: Vector4, key: string): M => {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { uBandView: view, uBandHalf: half, uBand: { value: values } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 uBandView;\nuniform float uBandHalf;\nuniform vec4 uBand;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${BAND_GLSL}`);
    };
    material.customProgramCacheKey = () => key;
    return material;
  };
  return {
    of(material, role, reach, lo, hi) {
      let roles = made.get(material);
      if (!roles) made.set(material, roles = new Map());
      const key = `${role}:${reach}`;
      let banded = roles.get(key);
      if (!banded) {
        const values = new Vector4(lo, hi, reach, 0);
        // A copy of the kind's own (its colours, its surface), patched: three's `clone` copies the material's values, not its patches.
        banded = { material: patch(material.clone(), values, 'far-band'), depth: patch(new MeshDepthMaterial({ colorWrite: false }), values, 'far-band-depth'), band: values };
        roles.set(key, banded);
      }
      return banded;
    },
    setView(next, halfHeight) {
      view.value.copy(next);
      half.value = halfHeight;
    },
    dispose() {
      for (const roles of made.values()) for (const banded of roles.values()) { banded.material.dispose(); banded.depth.dispose(); }
      made.clear();
    },
  };
}

/**
 * The nearest the view comes (its clip w: the depth the cells measure a size by, `cellInstances.ts`) to the feet in `feet` that stand outside the
 * near square (those are the near cells'): w is linear, so its least over that region is at one of the region's corners - the box's own outside
 * the square, the square's inside the box, and where their edges cross - at its lowest or its highest foot. Infinity: none outside the square.
 */
function nearestDepth(view: Matrix4, feet: Box3, square: FarSquare, cell: number): number {
  const e = view.elements;
  // Three's frame: x east, y up, z south (the world's -y); the square in the world's cells.
  const x0 = feet.min.x, x1 = feet.max.x, z0 = feet.min.z, z1 = feet.max.z;
  const hole = square.k < 0 ? null : {
    x0: (square.cx - square.k) * cell, x1: (square.cx + square.k + 1) * cell,
    z0: -(square.cy + square.k + 1) * cell, z1: -(square.cy - square.k) * cell,
  };
  const inside = (x: number, z: number): boolean => hole !== null && x > hole.x0 && x < hole.x1 && z > hole.z0 && z < hole.z1;
  const points: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  if (hole) {
    const xs = [hole.x0, hole.x1].filter((x) => x >= x0 && x <= x1), zs = [hole.z0, hole.z1].filter((z) => z >= z0 && z <= z1);
    for (const x of xs) for (const z of zs) points.push([x, z]);
    for (const x of xs) points.push([x, z0], [x, z1]);
    for (const z of zs) points.push([x0, z], [x1, z]);
  }
  let least = Infinity;
  for (const [x, z] of points) {
    if (inside(x, z)) continue;
    for (const y of [feet.min.y, feet.max.y]) least = Math.min(least, e[3]! * x + e[7]! * y + e[11]! * z + e[15]!);
  }
  return least;
}

/** The farthest the view goes (its clip w) to the feet in `feet`: w is linear, so at one of the box's eight corners. */
function farthestDepth(view: Matrix4, feet: Box3): number {
  const e = view.elements;
  let most = -Infinity;
  for (const x of [feet.min.x, feet.max.x]) for (const y of [feet.min.y, feet.max.y]) for (const z of [feet.min.z, feet.max.z]) {
    most = Math.max(most, e[3]! * x + e[7]! * y + e[11]! * z + e[15]!);
  }
  return most;
}

/** A far block's kind's rungs shown where some thing of it can be in their band: its sizes on the screen run from its smallest thing at its
 *  farthest foot to its largest at its nearest outside the near square (`perUnitAtOne`: pixels a world unit spans at w = 1); each thing is
 *  drawn by the one rung whose band holds it (the GPU's). */
export function showLadder(ladder: FarLadder, view: Matrix4, perUnitAtOne: number, square: FarSquare, cell: number): void {
  const near = nearestDepth(view, ladder.feet, square, cell);
  const far = farthestDepth(view, ladder.feet);
  const most = near === Infinity ? 0 : near > 1e-4 ? (ladder.largest * perUnitAtOne) / near : Infinity;
  const least = far > 1e-4 ? (ladder.smallest * perUnitAtOne) / far : Infinity;
  const pictured = ladder.pictures !== null && (ladder.levels.ready?.() ?? true);
  for (const rung of ladder.rungs) {
    // Down to the pictures' band once they are taken, to the cut while they are not.
    rung.band.x = pictured ? rung.floor : rung.floorUnpictured;
    const shown = rung.band.x <= most && rung.band.y > least;
    for (const mesh of rung.meshes) mesh.visible = shown;
  }
  if (ladder.pictures) {
    const shown = pictured && ladder.pictures.band.x <= most && ladder.pictures.band.y > least;
    for (const mesh of ladder.pictures.meshes) mesh.visible = shown;
  }
}
