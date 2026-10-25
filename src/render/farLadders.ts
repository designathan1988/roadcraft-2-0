import { MeshDepthMaterial, Matrix4, Vector4, type Box3, type InstancedMesh, type Material } from 'three';
import type { KindLevels } from './cellInstances';

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
