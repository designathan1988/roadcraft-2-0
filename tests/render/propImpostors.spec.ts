import { describe, expect, it } from 'vitest';
import {
  BackSide, BoxGeometry, DoubleSide, FrontSide, Frustum, Matrix4, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera, ShaderLib, Vector3,
  type InstancedMesh, type Material, type Object3D, type ShaderMaterial, type WebGLProgramParametersWithUniforms, type WebGLRenderer,
} from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { Rng } from '@core/rng';
import { m } from '@world/units';
import { createCellInstances, posesOf, type KindSpec, type Pack } from '@render/cellInstances';
import { NEAR_SQUARE, NEVER_NEAR, YAW_POSE, kindOf } from '@render/instanceRuns';
import { bakeMaterialsOf } from '@render/impostorBake';
import { createImpostors, createPlantImpostors, sceneryPictures, stillLook } from '@render/plantImpostors';
import { PROP_CELL, createPropLayer, lookProps, propView } from '@render/propCells';
import { trianglesOf } from '@render/propGeometry';
import { PROP_LEAST_PX, PROP_NEAR_PX, PROP_PICTURE_PX, propMeasure } from '@render/propLevels';
import { createSceneryKit } from '@render/scenery';
import { furnitureStores, propLadder } from '@render/streetFurnitureLayer';
import { sways } from '@render/wind';

/** THE STREET PROPS' LADDER (`propLevels.ts`, `plantImpostors.ts` createImpostors, `cellInstances.ts` mid level, `propCells.ts` far ladders). */

/** A material's shaders as its patches leave them, from three's own sources for its kind. */
function patched(material: Material): string {
  const lib = material.type === 'MeshDepthMaterial' ? ShaderLib.depth : ShaderLib.standard;
  const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, null as unknown as WebGLRenderer);
  return `${shader.vertexShader}\n----\n${shader.fragmentShader}`;
}

const box = (): { parts: { geometry: BoxGeometry; normals: 'vertex'; side: typeof FrontSide; casts: boolean }[] } =>
  ({ parts: [{ geometry: new BoxGeometry(1, 2, 1), normals: 'vertex', side: FrontSide, casts: true }] });

describe('the still models\' pictures', () => {
  it('draw every still set with one program and its depth with one, never a mover, apart from the plants\' two', () => {
    const props = new MeshStandardMaterial({ roughness: 0.62, metalness: 0.28 });
    const elements = new MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    const sets = [createImpostors([box()], stillLook(props), 'props'), createImpostors([box(), box()], stillLook(elements), 'elements')];
    const plants = createPlantImpostors([{ body: new BoxGeometry(1, 2, 1), cards: null, cardsCast: false }], { sway: 0.05, flutter: 0.01 }, 'scenery');
    for (const group of [sets.map((s) => s.material), sets.map((s) => s.depth)]) {
      expect(new Set(group.map((x) => x.customProgramCacheKey())).size).toBe(1);
      expect(new Set(group.map(patched)).size).toBe(1);
    }
    expect(sets[0]!.material.customProgramCacheKey()).toBe('static-impostor');
    expect(sets[0]!.depth.customProgramCacheKey()).toBe('static-impostor-depth');
    expect(plants.material.customProgramCacheKey()).toBe('plant-impostor');
    // Each set's own surface: the near model's values, uniforms of the one program.
    expect([sets[0]!.material.roughness, sets[0]!.material.metalness]).toEqual([0.62, 0.28]);
    expect([sets[1]!.material.roughness, sets[1]!.material.metalness]).toEqual([0.9, 0]);
    for (const s of sets) { expect(sways(s.material)).toBe(false); expect(sways(s.depth)).toBe(false); }
    expect(sways(plants.material)).toBe(true);
    for (const s of [...sets, plants]) s.dispose();
  });

  it('take a part\'s shadow outline with the side three r186 casts its material with, cut as its colour is', () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const front = bakeMaterialsOf({ geometry, normals: 'vertex', side: FrontSide, casts: true });
    expect(front.colour.side).toBe(FrontSide);
    expect(front.outline.side).toBe(BackSide);
    const map = { isTexture: true } as unknown as import('three').Texture;
    const leaves = bakeMaterialsOf({ geometry, map, alphaTest: 0.5, normals: 'vertex', side: DoubleSide, casts: true });
    expect(leaves.outline.side).toBe(DoubleSide);
    const defines = (x: Material): Record<string, unknown> => (x as ShaderMaterial).defines;
    expect(defines(leaves.colour)['BAKE_CUT']).toBe('0.5000');
    expect(defines(leaves.outline)['BAKE_CUT']).toBe('0.5000');
    // A two-sided part's back seen: its normal turned to the eye.
    expect(defines(leaves.colour)['BAKE_TURN']).toBe('');
    const faceted = bakeMaterialsOf({ geometry, normals: 'faceted', side: FrontSide, casts: false });
    expect(defines(faceted.colour)['BAKE_FACETED']).toBe('');
    for (const x of [front, leaves, faceted]) { x.colour.dispose(); x.outline.dispose(); }
  });

  it('take a part with its own near material: its colour and normal where three has them, after its own patches, never its program', () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const near = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.28 });
    // A patch of its own (a thin part's tone, a pose): kept in the pictures' program.
    near.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= 0.3;'); };
    near.customProgramCacheKey = () => 'thin-tone';
    const baked = bakeMaterialsOf({ geometry, normals: 'vertex', side: FrontSide, casts: true, material: near });
    expect(baked.colour).not.toBe(near);
    expect(baked.colour.side).toBe(FrontSide);
    expect(baked.outline.side).toBe(BackSide);
    expect(baked.colour.customProgramCacheKey()).toBe('thin-tone|picture-colour');
    expect(baked.outline.customProgramCacheKey()).toBe('thin-tone|picture-outline');
    const code = patched(baked.colour);
    expect(code).toContain('diffuseColor.rgb *= 0.3;');
    expect(code).toContain('layout(location = 1) out highp vec4 gNormal;');
    // Written after the material's colour and normal, before any light.
    expect(code.indexOf('diffuseColor.rgb *= 0.3;')).toBeLessThan(code.indexOf('gNormal = vec4('));
    expect(code.indexOf('gNormal = vec4(')).toBeLessThan(code.indexOf('#include <lights_fragment_begin>'));
    for (const x of [baked.colour, baked.outline, near]) x.dispose();
  });

  it('take an alpha-cut set\'s levels with its map read a mip coarser than their texels, its outline as it is', () => {
    // Each level is drawn where a pixel spans two of its texels (`plantImpostors.ts` STILL_READ_GLSL): its map read as the model's own pixel reads it.
    const geometry = new BoxGeometry(1, 1, 1);
    const map = { isTexture: true } as unknown as import('three').Texture;
    const near = new MeshStandardMaterial({ map, alphaTest: 0.5, side: DoubleSide });
    const biased = bakeMaterialsOf({ geometry, normals: 'vertex', side: DoubleSide, casts: true, material: near }, false, 1);
    expect(patched(biased.colour)).toContain('texture2D( map, vMapUv, 1.0 )');
    expect(patched(biased.outline)).not.toContain('vMapUv, 1.0');
    expect(biased.colour.customProgramCacheKey()).toContain('|bias-1');
    const plain = bakeMaterialsOf({ geometry, map, alphaTest: 0.5, normals: 'vertex', side: DoubleSide, casts: true }, false, 1);
    expect((plain.colour as ShaderMaterial).defines['BAKE_MAP_BIAS']).toBe('1.0');
    // Unbiased (every other set): three's own read, untouched.
    const own = bakeMaterialsOf({ geometry, normals: 'vertex', side: DoubleSide, casts: true, material: near });
    expect(patched(own.colour)).not.toContain('vMapUv, 1.0');
    for (const x of [biased.colour, biased.outline, plain.colour, plain.outline, own.colour, own.outline, near]) x.dispose();
  });
});

/** Three kinds of one model each at near, mid and far, and the counts each level draws for things `px` across on the screen. */
function ladderCounts(px: readonly number[]): { near: number; mid: number; far: number }[] {
  const model = new BoxGeometry(1, 1, 1);
  model.computeBoundingSphere();
  const material = new MeshStandardMaterial(), mid = new MeshStandardMaterial(), far = new MeshStandardMaterial();
  const reach = model.boundingSphere!.radius;
  const spec: KindSpec = {
    tinted: false,
    levels: { reach, mid: PROP_NEAR_PX, far: PROP_PICTURE_PX, least: PROP_LEAST_PX, small: true },
    meshes: [
      { name: 'near', geometry: model, material, castShadow: false, receiveShadow: false, cards: false, far: false },
      { name: 'mid', geometry: model, material: mid, castShadow: false, receiveShadow: false, cards: false, far: false, mid: true },
      { name: 'far', geometry: model, material: far, castShadow: false, receiveShadow: false, cards: false, far: true },
    ],
  };
  const cells = createCellInstances([spec], YAW_POSE, 0);
  // 400 things on a line, all the same size on an orthographic screen (w = 1 everywhere).
  const n = 400, data = new Float32Array(n * 8), scales = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) data.set([i * m(3), 0, 0, 0, 1, 1, 1, NEVER_NEAR], i * 8);
  const pack: Pack = { data, colours: null, scales, count: n };
  cells.update({ removed: [], added: [{ key: {}, packs: new Map([[0, pack]]) }] });
  const out: { near: number; mid: number; far: number }[] = [];
  for (const across of px) {
    // `across` pixels for the thing's measure (its sphere's diameter): half the screen 540 px, w = 1.
    const half = (540 * 2 * reach) / across;
    // As wide as the line (the size is measured by the screen's height alone), looking straight down.
    const camera = new OrthographicCamera(-n * m(2), n * m(2), half, -half, 1, m(20000));
    camera.up.set(0, 0, -1);
    camera.position.set(n * m(1.5), m(100), 0);
    camera.lookAt(n * m(1.5), 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // The screen the cells measure in: 540 px half high (`screenHalf`, as the meshes last drew).
    cells.cull(new Frustum().setFromProjectionMatrix(view), view);
    const count = (name: string): number => (cells.meshes.find((x) => x.name === name)?.count ?? 0);
    out.push({ near: count('near'), mid: count('mid'), far: count('far') });
  }
  cells.dispose();
  return out;
}

describe('the near cells\' ladder', () => {
  it('is the owner\'s tool\'s: L0 from 48 px, L1 from 16 px, the picture from 1.5 px, nothing under it', () => {
    expect([PROP_NEAR_PX, PROP_PICTURE_PX, PROP_LEAST_PX]).toEqual([48, 16, 1.5]);
    const kit = createSceneryKit();
    const stores = furnitureStores(kit, sceneryPictures(kit), propLadder(kit));
    for (const name of ['street-lights', 'street-bins', 'benches', 'hydrants', 'post-boxes', 'phones', 'drains', 'tree-pits']) {
      const store = stores.find((x) => x.name === name)!;
      const levels = store.levels!;
      expect([levels.mid, levels.far, levels.least], name).toEqual([48, 16, 1.5]);
      // Measured by its largest extent (the tool's `size`); its picture's measure the same (`aMeasure`).
      expect(2 * levels.reach, name).toBeCloseTo(propMeasure(store.geometry), 6);
      const picture = store.with!.find((x) => x.far)!.geometry.getAttribute('aMeasure');
      expect(2 * picture.getX(0), name).toBeCloseTo(propMeasure(store.geometry), 6);
    }
  });

  it('draws a thing whole from 48 px, simplified from 16 px, as its picture from 1.5 px, not at all under it, each level kept within its band', () => {
    const [big, middle, small, tiny, back, down, again] = ladderCounts([60, 30, 10, 1, 45, 15, 1.6]);
    expect(big).toEqual({ near: 400, mid: 0, far: 0 });
    expect(middle).toEqual({ near: 0, mid: 400, far: 0 });
    // Every one drawn as its picture, none thinned.
    expect(small).toEqual({ near: 0, mid: 0, far: 400 });
    expect(tiny).toEqual({ near: 0, mid: 0, far: 0 });
    // Grown back to 45 px from nothing: mid (over the picture bar's band), not yet near (under the near bar's).
    expect(back).toEqual({ near: 0, mid: 400, far: 0 });
    // Shrunk to 15 px from mid: still mid (within the picture bar's band, 16 x 0.85).
    expect(down).toEqual({ near: 0, mid: 400, far: 0 });
    // Shrunk to 1.6 px: its picture.
    expect(again).toEqual({ near: 0, mid: 0, far: 400 });
  });
});

/** The district view of the large city (seed 4242) as `npm run diagnose` counted it (b46c5894, 2026-10-24): the far blocks' benches, bins, hydrants. */
const DISTRICT = { benches: 3582, bins: 3427, hydrants: 1212 } as const;
type Counted = Record<keyof typeof DISTRICT, number>;

/** The fixed set (`DISTRICT`) spread over a 4.5 km square, in a layer of the furniture's kinds, brought to `camera`'s view; what it draws. */
async function farDrawn(camera: OrthographicCamera | PerspectiveCamera, half: number): Promise<{
  before: Counted; inView: Counted; submitted: Counted; drawn: Counted; levels: Record<string, number>; twice: number; missing: number;
}> {
  const kit = createSceneryKit();
  const pictures = sceneryPictures(kit);
  const ladder = propLadder(kit);
  await MeshoptSimplifier.ready;
  let steps = 0;
  while (!ladder.step() && steps < 64) steps++;
  // Every prop made, one a step as a frame makes them: none left over.
  expect(ladder.step()).toBe(true);
  // As if taken (`takeWaitingPictures`): no renderer here; the triangles drawn do not depend on the pictures' texels.
  (ladder.pictures.set as { ready: () => boolean }).ready = () => true;
  const stores = furnitureStores(kit, pictures, ladder);
  const store = (name: string): number => stores.findIndex((s) => s.name === name);
  const kinds: Counted = { benches: store('benches'), bins: store('street-bins'), hydrants: store('hydrants') };
  // Each count spread over the district's 4.5 km square, on the ground, turned at random.
  const rng = new Rng(0x4242);
  const packs = new Map<number, Pack>();
  for (const [name, count] of Object.entries(DISTRICT) as [keyof typeof DISTRICT, number][]) {
    const data = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) data.set([(rng.float() - 0.5) * m(4500), 0, (rng.float() - 0.5) * m(4500), rng.float() * Math.PI * 2, 1, 1, 1, NEVER_NEAR], i * 8);
    packs.set(kinds[name], { data, colours: null, scales: new Float32Array(count).fill(1), count });
  }
  const layer = createPropLayer({
    name: 'district', version: 1, kinds: stores.map(kindOf), margin: 0, changes: ['landscape'], pad: 0,
    pictures: pictures.set, pictureOf: stores.map(() => null), stills: [ladder.pictures.set], place: () => ({ packs, growing: false }),
  });
  camera.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const frustum = new Frustum().setFromProjectionMatrix(view);
  let square = lookProps([layer], propView(camera, frustum, half, 0));
  for (let i = 0; i < 200 && layer.busy; i++) square = lookProps([layer], propView(camera, frustum, half, 0));
  const shown = (mesh: Object3D): boolean => { for (let o: Object3D | null = mesh; o; o = o.parent) if (!o.visible) return false; return true; };
  const zero = (): Counted => ({ benches: 0, bins: 0, hydrants: 0 });
  const submitted = zero(), drawn = zero(), levels: Record<string, number> = {};
  // Each thing's size on the screen as the far batches' shaders measure it (`propCells.ts` BAND_GLSL, `plantImpostors.ts` vertexMain): its
  // kind's measure times its scale, over clip w at its foot; drawn by the visible rungs whose band holds it.
  const e = view.elements, perUnitAtOne = Math.hypot(e[1]!, e[5]!, e[9]!) * half;
  const seen = new Map<string, number>();
  for (const mesh of layer.meshes as InstancedMesh[]) {
    if (!shown(mesh) || !mesh.name.endsWith('-far-cells')) continue;
    for (const name of Object.keys(DISTRICT) as (keyof typeof DISTRICT)[]) {
      const kind = stores[kinds[name]]!;
      if (!mesh.name.startsWith(`${kind.name}`)) continue;
      const level = mesh.name.slice(kind.name.length + 1, -'-far-cells'.length) || 'model';
      const band = level === 'far' ? [PROP_LEAST_PX, PROP_PICTURE_PX] : level === 'mid' ? [PROP_PICTURE_PX, PROP_NEAR_PX]
        : [ladder.mid[name === 'benches' ? 'bench' : name === 'bins' ? 'bin' : 'hydrant'].ready() ? PROP_NEAR_PX : PROP_PICTURE_PX, Infinity];
      const triangles = trianglesOf(mesh.geometry);
      submitted[name] += mesh.count * triangles;
      const poses = posesOf(mesh).buffer.array as Float32Array;
      const square4 = NEAR_SQUARE.value;
      for (let i = 0; i < mesh.count; i++) {
        const x = poses[i * 8]!, y = poses[i * 8 + 1]!, z = poses[i * 8 + 2]!;
        // In the near square: the near cells' (none here: no cell was asked for this layer's things beyond it).
        const cx = Math.floor(x / PROP_CELL), cy = Math.floor(-z / PROP_CELL);
        if (square4.z >= 0 && Math.max(Math.abs(cx - square4.x), Math.abs(cy - square4.y)) <= square4.z) continue;
        const w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
        const across = (2 * kind.levels!.reach * Math.max(poses[i * 8 + 4]!, poses[i * 8 + 5]!, poses[i * 8 + 6]!) * perUnitAtOne) / Math.max(w, 1e-4);
        if (across < band[0]! || across >= band[1]!) continue;
        drawn[name] += triangles;
        levels[`${name} ${level}`] = (levels[`${name} ${level}`] ?? 0) + 1;
        const key = `${name} ${x},${y},${z}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
  }
  // Every thing of the set at least `PROP_LEAST_PX` across outside the near square drawn once, none twice.
  let twice = 0, missing = 0;
  // What HEAD's far batches drew at least: every thing in the view outside the near square, by its model (they drew whole blocks).
  const inView = zero();
  const model: Counted = { benches: trianglesOf(kit.furniture.bench), bins: trianglesOf(kit.furniture.bin), hydrants: trianglesOf(kit.furniture.hydrant) };
  for (const [name, count] of Object.entries(DISTRICT) as [keyof typeof DISTRICT, number][]) {
    const data = packs.get(kinds[name])!.data, reach = stores[kinds[name]]!.levels!.reach;
    for (let i = 0; i < count; i++) {
      const x = data[i * 8]!, y = data[i * 8 + 1]!, z = data[i * 8 + 2]!;
      const cx = Math.floor(x / PROP_CELL), cy = Math.floor(-z / PROP_CELL);
      if (square.k >= 0 && Math.max(Math.abs(cx - square.cx), Math.abs(cy - square.cy)) <= square.k) continue;
      const w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
      const clip = new Vector3(x, y, z).applyMatrix4(view);
      if (w <= 0 || Math.abs(clip.x) > 1 || Math.abs(clip.y) > 1) continue;
      inView[name] += model[name];
      const across = (2 * reach * perUnitAtOne) / w;
      const times = seen.get(`${name} ${x},${y},${z}`) ?? 0;
      if (times > 1) twice++;
      if (across >= PROP_LEAST_PX && times === 0) missing++;
      if (across < PROP_LEAST_PX && times > 0) twice++;
    }
  }
  // HEAD's far batch drew each thing by its model, at every size (`propCells.ts` before: its near bodies): the count times the model's triangles.
  const before: Counted = {
    benches: DISTRICT.benches * trianglesOf(kit.furniture.bench), bins: DISTRICT.bins * trianglesOf(kit.furniture.bin),
    hydrants: DISTRICT.hydrants * trianglesOf(kit.furniture.hydrant),
  };
  layer.dispose();
  pictures.release();
  ladder.release();
  return { before, inView, submitted, drawn, levels, twice, missing };
}

const sum = (c: Counted): number => c.benches + c.bins + c.hydrants;

describe('the far blocks\' street props', () => {
  it('draw nothing of the district view\'s benches, bins and hydrants under 1.5 px (the owner\'s ladder), at most 60,000 triangles', async () => {
    // The district's view: the iso camera at 48 degrees (`isoViewport.ts` DEFAULT_ELEVATION), 2,250 m half high on a 900 px screen (450 px
    // half high): the 4.5 km the counted things stand over (an assumption: the diagnose's own camera is not stored).
    const half = m(2250), elevation = (48 * Math.PI) / 180;
    const camera = new OrthographicCamera(-half * 16 / 9, half * 16 / 9, half, -half, 1, m(20000));
    camera.position.copy(new Vector3(0, Math.sin(elevation), Math.cos(elevation)).multiplyScalar(m(6000)));
    camera.lookAt(0, 0, 0);
    const got = await farDrawn(camera, 450);
    console.log(`district (ortho): before ${JSON.stringify(got.before)} = ${sum(got.before)}; before in view ${JSON.stringify(got.inView)} = ${sum(got.inView)}; submitted ${JSON.stringify(got.submitted)} = ${sum(got.submitted)}; `
      + `drawn ${JSON.stringify(got.drawn)} = ${sum(got.drawn)}; by level ${JSON.stringify(got.levels)}; twice ${got.twice}, missing ${got.missing}`);
    expect(got.twice).toBe(0);
    expect(got.missing).toBe(0);
    expect(sum(got.submitted)).toBeLessThanOrEqual(60_000);
  });

  it('draw a street view\'s far props each at its own level, once, as the near cells\' bars would', async () => {
    // Over the same square from 60 m up, looking across it (the iso rig's perspective, 35 degrees, `isoViewport.ts` PERSPECTIVE_FOV).
    const camera = new PerspectiveCamera(35, 16 / 9, m(1), m(8000));
    camera.position.set(-m(2000), m(60), m(2000));
    camera.lookAt(0, 0, 0);
    const got = await farDrawn(camera, 450);
    console.log(`street (perspective): before ${JSON.stringify(got.before)} = ${sum(got.before)}; before in view ${JSON.stringify(got.inView)} = ${sum(got.inView)}; submitted ${JSON.stringify(got.submitted)} = ${sum(got.submitted)}; `
      + `drawn ${JSON.stringify(got.drawn)} = ${sum(got.drawn)}; by level ${JSON.stringify(got.levels)}; twice ${got.twice}, missing ${got.missing}`);
    expect(got.twice).toBe(0);
    expect(got.missing).toBe(0);
    expect(sum(got.submitted)).toBeLessThan(sum(got.inView));
  });
});
