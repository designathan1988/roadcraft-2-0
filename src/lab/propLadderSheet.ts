import {
  ACESFilmicToneMapping, AmbientLight, type BufferGeometry, Color, DirectionalLight, Frustum, HemisphereLight, type InstancedMesh, Matrix4, Mesh, MeshStandardMaterial,
  MeshBasicMaterial, NoBlending, type Object3D, OrthographicCamera, PCFShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, SRGBColorSpace, type Texture,
  Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { RoadDoc } from '@world/doc';
import { buildRoadElevation } from '@world/elevation';
import { snapLandscape, type LandscapeKind } from '@world/landscape';
import { Network } from '@world/network';
import { m } from '@world/units';
import { takeWaitingPictures } from '../render/plantImpostors';
import { castCastersInto } from '../render/shadowCasters';
import { lookProps, propView } from '../render/propCells';
import { createSceneryKit } from '../render/scenery';
import { createStreetFurniture } from '../render/streetFurnitureLayer';
import type { ReferenceFurniture } from './propLadderReference';

/**
 * THE STREET PROPS' LADDER SHEETS (`scripts/prop-ladder-sheet.mjs`): a straight urban street with one kind of prop on its footway at distances
 * from a few metres to the horizon, drawn by the game's own street furniture layer (`streetFurnitureLayer.ts`: its near cells and its far blocks,
 * `propCells.ts`) with the game's own materials and lights (`environment.ts`: the sky fill, the floor's ambient, the sun, a sky to reflect), its
 * shadows on, at the screen's own size (1920 x 1080 under the iso rig's 35° perspective). Every size a prop is seen at, from its model to its
 * last pixel, is in one frame. Whatever checkout serves the page draws its own layer: the same sheet draws one commit's and another's.
 */

/** The screen: 1080 lines under the iso rig's perspective (`isoViewport.ts` PERSPECTIVE_FOV), 16:9. */
const WIDTH = 1920, HEIGHT = 1080, FOV = 35;
/** The street: straight along the plan's x, an urban road (`roadTypes.ts` type 1, footways of 2 m) cut in pieces of this length. */
const STREET = m(3000), PIECE = m(200);
/** Where the props stand: from the eye, each this many metres on (a ratio of about 1.3: every size from hundreds of pixels to under one). */
const DISTANCES = [4, 6, 8, 11, 15, 20, 27, 36, 48, 64, 85, 110, 150, 200, 270, 360, 480, 640, 850, 1100, 1500, 2000, 2700].map(m);
/** The eye: over the footway the props stand on, a little behind the first, looking down the street. */
const EYE = { x: -m(6), y: m(9), z: m(6) };
/** The city's hour: a morning, the plants grown, the lamps off. */
const MINUTES = 10 * 60 + 60 * 24 * 30;

/** One frame of the sheet: the picture, what three drew, and where each prop stands on it with its size by the layer's own measure. */
export interface LadderFrame {
  readonly name: string;
  /** The frame, a PNG as a data URL. */
  readonly png: string;
  readonly drawCalls: number;
  readonly triangles: number;
  /** Each prop placed: its distance, its middle on the frame (pixels from the top left) and its size there in pixels (its model's largest
   *  extent, the ladder's measure, `propLevels.ts`; a metre's for every kind at once). */
  readonly props: readonly { readonly distance: number; readonly x: number; readonly y: number; readonly px: number }[];
  /** Each mesh of the layer drawn in the frame: its name, instances and triangles an instance. */
  readonly meshes: readonly { readonly name: string; readonly count: number; readonly triangles: number }[];
}

const trianglesOf = (mesh: InstancedMesh): number => (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.getAttribute('position').count) / 3;

/** The frames: one a kind of `kinds` (a street of that prop alone), and the street with every kind at once (`all`). */
/** The reference layer's module (`propLadderReference.ts`), read only when asked: a checkout without it still draws its own frames. */
const REFERENCE = './propLadderReference.ts';

/** `reference`: every prop drawn by its model at every size (`propLadderReference.ts`), the ladder's yardstick, in place of the game's layer. */
export async function propLadderFrames(kinds: readonly LandscapeKind[], reference = false): Promise<LadderFrame[]> {
  const made = reference ? ((await import(/* @vite-ignore */ REFERENCE)) as { referenceFurniture(kit: ReturnType<typeof createSceneryKit>): ReferenceFurniture }) : null;
  // Its simplified models made where the checkout makes them (one a sync, `PropLadder.step`): the simplifier loaded first.
  await MeshoptSimplifier.ready;
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  const kit = createSceneryKit();
  const out: LadderFrame[] = [];
  for (const kind of [...kinds, 'all'] as const) {
    const doc = new RoadDoc();
    const net = new Network(doc);
    let last = doc.addNode({ x: 0, y: 0 });
    for (let x = PIECE; x <= STREET; x += PIECE) {
      const next = doc.addNode({ x, y: 0 });
      doc.addSegment(last.id, next.id, 1);
      last = next;
    }
    net.rebuild();
    const ground = (): number => 0;
    const elevation = buildRoadElevation(net, ground);
    // Each prop where the tool puts it: snapped to the footway on the eye's side (`snapLandscape`).
    const placed: { distance: number; x: number; y: number }[] = [];
    const list = kind === 'all' ? kinds : [kind];
    for (const distance of DISTANCES) {
      list.forEach((k, i) => {
        const along = EYE.x + distance + i * m(2.5);
        const snap = snapLandscape(net, doc.landscape.values(), k, { x: along, y: EYE.y }, m(30));
        if (!snap.ok) return;
        doc.addLandscape(k, snap.at);
        placed.push({ distance, x: snap.at.x, y: snap.at.y });
      });
    }
    net.rebuild();
    const layer = made ? made.referenceFurniture(kit) : createStreetFurniture(kit);
    // The simplifier's load seen by the layer's props' ladder (`PropLadder.step`, one prop a sync).
    await MeshoptSimplifier.ready;
    const scene = new Scene();
    scene.background = new Color(0xc9d6e0);
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.6;
    // The game's lights (`environment.ts`): the sky fill, the floor's ambient, the sun.
    scene.add(new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8), new AmbientLight(0xdfe9f2, 0.07));
    const sun = new DirectionalLight(0xfff0cf, 3.6);
    sun.position.set(EYE.x + m(120) - m(160), m(220), -(EYE.y + m(120)));
    sun.target.position.set(EYE.x + m(120), 0, -EYE.y);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -m(150), right: m(150), top: m(150), bottom: -m(150), near: m(1), far: m(800) });
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun, sun.target);
    const floor = new Mesh(new PlaneGeometry(m(20_000), m(20_000)).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x8f918c, roughness: 0.95 }));
    floor.position.y = -m(0.02);
    floor.receiveShadow = true;
    scene.add(floor, layer.group, layer.grass);

    const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, m(0.4), m(8000));
    camera.position.set(EYE.x, EYE.z, -EYE.y);
    camera.lookAt(EYE.x + m(400), 0, -EYE.y);
    camera.updateMatrixWorld();
    const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(view);
    const look = (): void => {
      layer.sync(net, elevation, ground, MINUTES);
      for (let i = 0; i < 400; i++) { lookProps([layer.layer], propView(camera, frustum, HEIGHT / 2, 0)); if (!layer.layer.busy) break; }
      layer.cull(frustum, view);
    };
    // Synced until every simplified model is made (one a sync) and the pictures are taken, as the game's frames do (`farForest.ts` update).
    for (let i = 0; i < 12; i++) look();
    takeWaitingPictures(renderer);
    look();
    // The sun's map drawn as the game draws a cascade (`sunCascades.ts`): each caster's instances and its casting for the map's texel
    // (`castCastersInto`), then the colour drawn over it with the colour's (the map kept).
    renderer.shadowMap.autoUpdate = false;
    const texel = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x;
    const draw = (): void => {
      castCastersInto(texel);
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
      castCastersInto(null);
      renderer.render(scene, camera);
    };
    // Drawn twice: the second with the screen's size the first read (`cellInstances.ts` screenHalf).
    draw();
    look();
    castCastersInto(texel);
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    castCastersInto(null);
    renderer.info.reset();
    renderer.info.autoReset = false;
    renderer.render(scene, camera);
    const drawCalls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
    renderer.info.autoReset = true;
    const png = canvas.toDataURL('image/png');
    const shown = (o: Object3D): boolean => { for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const meshes = (layer.meshes as InstancedMesh[]).filter((mesh) => shown(mesh) && mesh.count > 0)
      .map((mesh) => ({ name: mesh.name, count: mesh.count, triangles: trianglesOf(mesh) }));
    // Each prop's middle and its size on the frame: its model's largest extent over its depth (the cells' measure, `cellInstances.ts`).
    const model = kind === 'all' ? null : kind === 'tree' ? kit.treePit : (kit.furniture as Record<string, BufferGeometry | undefined>)[kind] ?? null;
    if (model && !model.boundingBox) model.computeBoundingBox();
    const extent = model ? Math.max(...model.boundingBox!.getSize(new Vector3()).toArray()) : m(1);
    const perUnitAtOne = (HEIGHT / 2) / Math.tan((FOV * Math.PI) / 360);
    const props = placed.map((p) => {
      const foot = new Vector3(p.x, 0, -p.y);
      const w = foot.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const at = foot.clone().project(camera);
      return { distance: p.distance, x: Math.round(((at.x + 1) / 2) * WIDTH), y: Math.round(((1 - at.y) / 2) * HEIGHT), px: (extent * perUnitAtOne) / Math.max(-w, 1e-6) };
    });
    out.push({ name: kind, png, drawCalls, triangles, props, meshes });
    layer.dispose();
    pmrem.dispose();
    floor.geometry.dispose();
    (floor.material as MeshStandardMaterial).dispose();
  }
  kit.dispose();
  renderer.dispose();
  return out;
}

/** Two frames compared on the page: their difference pixel by pixel (the largest channel's, 0..255), as a picture (red) and as numbers. */
export async function propLadderCompare(before: string, after: string, crops: readonly { readonly x: number; readonly y: number; readonly size: number; readonly label: string }[]): Promise<{
  readonly sheet: string; readonly changed8: number; readonly changed32: number; readonly largest: number; readonly mean: number;
  readonly crops: readonly { readonly label: string; readonly changed8: number; readonly largest: number }[];
}> {
  const load = async (url: string): Promise<ImageData> => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const c = document.createElement('canvas');
    c.width = image.width; c.height = image.height;
    const g = c.getContext('2d')!;
    g.drawImage(image, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  };
  const a = await load(before), b = await load(after);
  const w = a.width, h = a.height;
  const diff = new Uint8Array(w * h);
  let changed8 = 0, changed32 = 0, largest = 0, sum = 0;
  for (let i = 0; i < w * h; i++) {
    const d = Math.max(Math.abs(a.data[i * 4]! - b.data[i * 4]!), Math.abs(a.data[i * 4 + 1]! - b.data[i * 4 + 1]!), Math.abs(a.data[i * 4 + 2]! - b.data[i * 4 + 2]!));
    diff[i] = d;
    if (d > 8) changed8++;
    if (d > 32) changed32++;
    largest = Math.max(largest, d);
    sum += d;
  }
  // The sheet: before and after at half size, their difference (red, four times as strong), then each crop eight times, nearest pixel.
  const ZOOM = 8, CROP = 24, PAD = 12;
  const half = { w: Math.round(w / 2), h: Math.round(h / 2) };
  const cropRow = CROP * ZOOM;
  const page = document.createElement('canvas');
  page.width = half.w * 3 + PAD * 4;
  page.height = half.h + PAD * 3 + 22 + Math.ceil(crops.length / 2) * (cropRow + 28);
  const g = page.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
  g.imageSmoothingEnabled = true;
  const imageOf = (data: ImageData): HTMLCanvasElement => { const c = document.createElement('canvas'); c.width = data.width; c.height = data.height; c.getContext('2d')!.putImageData(data, 0, 0); return c; };
  const red = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) { const d = Math.min(255, diff[i]! * 4); red.data[i * 4] = 255; red.data[i * 4 + 1] = 255 - d; red.data[i * 4 + 2] = 255 - d; red.data[i * 4 + 3] = 255; }
  const [ca, cb, cd] = [imageOf(a), imageOf(b), imageOf(red)];
  g.font = '14px Segoe UI, sans-serif'; g.fillStyle = '#141e28';
  [[ca, 'before (HEAD)'], [cb, 'after (working copy)'], [cd, 'difference x4 (largest channel)']].forEach(([c, label], k) => {
    g.drawImage(c as HTMLCanvasElement, PAD + k * (half.w + PAD), PAD + 22, half.w, half.h);
    g.fillText(label as string, PAD + k * (half.w + PAD), PAD + 14);
  });
  g.imageSmoothingEnabled = false;
  const cropStats: { label: string; changed8: number; largest: number }[] = [];
  crops.forEach((crop, k) => {
    const x0 = Math.round(crop.x - CROP / 2), y0 = Math.round(crop.y - CROP / 2);
    const col = k % 2, row = Math.floor(k / 2);
    const top = half.h + PAD * 2 + 22 + row * (cropRow + 28);
    const left = PAD + col * (cropRow * 3 + PAD * 4);
    [ca, cb, cd].forEach((c, j) => g.drawImage(c, x0, y0, CROP, CROP, left + j * (cropRow + PAD), top + 18, cropRow, cropRow));
    let n8 = 0, most = 0;
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + CROP); y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + CROP); x++) {
      const d = diff[y * w + x]!;
      if (d > 8) n8++;
      most = Math.max(most, d);
    }
    cropStats.push({ label: crop.label, changed8: n8 / (CROP * CROP), largest: most });
    g.fillStyle = '#141e28';
    g.fillText(`${crop.label}: before | after | difference — ${(100 * n8 / (CROP * CROP)).toFixed(1)} % of the ${CROP}x${CROP} px over 8/255, largest ${most}`, left, top + 12);
  });
  return { sheet: page.toDataURL('image/png'), changed8: changed8 / (w * h), changed32: changed32 / (w * h), largest, mean: sum / (w * h), crops: cropStats };
}

/** The street props' pictures as taken (`plantImpostors.ts` propPictures): the atlas's colour and normal targets read back as PNGs, each with
 *  its cover as a second panel (grey). What the far props are drawn from. */
export async function propPicturesAtlas(): Promise<{ readonly colour: string; readonly normal: string; readonly modes: readonly string[] }> {
  await MeshoptSimplifier.ready;
  const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false, preserveDrawingBuffer: true });
  const kit = createSceneryKit();
  // Read when asked: a checkout without the props' pictures still draws its frames.
  const ladderOf = ((await import(/* @vite-ignore */ LADDER)) as { propLadder(k: typeof kit): { pictures: { set: { albedo: Texture; normals: Texture } }; release(): void } }).propLadder;
  const ladder = ladderOf(kit);
  takeWaitingPictures(renderer);
  let last = new Uint8Array(0), lastWidth = 0;
  const read = (texture: Texture): string => {
    const { width, height } = texture.image as { width: number; height: number };
    const target = new WebGLRenderTarget(width, height);
    const scene = new Scene();
    // Its alpha as stored: a transparent material (an opaque one writes 1), not blended.
    scene.add(new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ map: texture, transparent: true, blending: NoBlending })));
    renderer.setRenderTarget(target);
    renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, -1, 1));
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    last = pixels; lastWidth = width;
    renderer.setRenderTarget(null);
    target.dispose();
    // The colour as stored, then its cover: side by side.
    const canvas = document.createElement('canvas');
    canvas.width = width * 2; canvas.height = height;
    const image = new ImageData(width * 2, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const from = ((height - 1 - y) * width + x) * 4;
      const left = (y * width * 2 + x) * 4, right = (y * width * 2 + width + x) * 4;
      for (let c = 0; c < 3; c++) { image.data[left + c] = pixels[from + c]!; image.data[right + c] = pixels[from + 3]!; }
      image.data[left + 3] = 255; image.data[right + 3] = 255;
    }
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  };
  const colour = read(ladder.pictures.set.albedo);
  // Each model's block: its five commonest stored colours over its whole cover (a = 255), as hex, with their share.
  const BLOCK = 512, modes: string[] = [];
  const colourPixels = last, width = lastWidth;
  for (let block = 0; block < 8; block++) {
    const bx = (block % 4) * BLOCK, by = Math.floor(block / 4) * BLOCK;
    const counts = new Map<number, number>();
    let total = 0;
    for (let y = by; y < by + BLOCK; y++) for (let x = bx; x < bx + BLOCK; x++) {
      const at = (y * width + x) * 4;
      if (colourPixels[at + 3] !== 255) continue;
      const key = (colourPixels[at]! << 16) | (colourPixels[at + 1]! << 8) | colourPixels[at + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `#${k.toString(16).padStart(6, '0')} ${(100 * n / Math.max(total, 1)).toFixed(1)}%`);
    modes.push(`block ${block}: ${top.join(', ')}`);
  }
  const result = { colour, normal: read(ladder.pictures.set.normals), modes };
  ladder.release();
  kit.dispose();
  renderer.dispose();
  return result;
}

/** The street furniture layer's module, for its props' ladder (`propLadder`), read only when asked. */
const LADDER = '../render/streetFurnitureLayer.ts';

/** Each prop drawn alone, its model and its picture side by side, at each of `sizes` (pixels across by its measure), from three views:
 *  the picture checked against the model at any size, where a fault shows. One scene, one light rig, each prop's two draws made once. */
export async function propPictureCloseups(sizes: readonly number[]): Promise<string> {
  await MeshoptSimplifier.ready;
  const PANEL = 160;
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setPixelRatio(1);
  renderer.setSize(PANEL, PANEL, false);
  const kit = createSceneryKit();
  const { propLadder, furnitureStores } = (await import(/* @vite-ignore */ LADDER)) as {
    propLadder(k: typeof kit): { release(): void; step(): boolean };
    furnitureStores(k: typeof kit, pictures: unknown, ladder: unknown): {
      name: string; geometry: BufferGeometry; material: MeshStandardMaterial; levels?: { reach: number };
      with?: { far: boolean; geometry: BufferGeometry; material: MeshStandardMaterial; made?: (mesh: InstancedMesh) => void }[];
    }[];
  };
  const { sceneryPictures } = await import('../render/plantImpostors');
  const { createCellInstances } = await import('../render/cellInstances');
  const { YAW_POSE, NEVER_NEAR } = await import('../render/instanceRuns');
  const ladder = propLadder(kit);
  // Its simplifier's load seen by the ladder (a callback on the same promise, registered first), then every prop made, one a step.
  await MeshoptSimplifier.ready;
  for (let i = 0; i < 64 && !ladder.step(); i++) { /* one prop a step */ }
  const stores = furnitureStores(kit, sceneryPictures(kit), ladder).filter((s) => s.levels && s.with?.some((w) => w.far));
  takeWaitingPictures(renderer);
  const scene = new Scene();
  scene.background = new Color(0xcfcdc6);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  scene.add(new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8), new AmbientLight(0xdfe9f2, 0.07));
  const sun = new DirectionalLight(0xfff0cf, 3.6);
  sun.position.set(-1, 2, 1.2);
  scene.add(sun);
  const views = [{ elevation: 0.05, azimuth: 0.6 }, { elevation: 0.5, azimuth: 2.2 }, { elevation: 1.2, azimuth: 4 }];
  const page = document.createElement('canvas');
  page.width = (PANEL + 4) * 2 * views.length * sizes.length; page.height = (PANEL + 4) * stores.length;
  const g = page.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
  const one = { data: new Float32Array([0, 0, 0, 0, 1, 1, 1, NEVER_NEAR]), colours: null, scales: new Float32Array([1]), count: 1 };
  stores.forEach((store, row) => {
    const picture = store.with!.find((w) => w.far)!;
    const reach = store.levels!.reach;
    // Its model and its picture each a kind of its own, drawn at every size (no levels): the cells' own pose and programs.
    const cellsOf = (mesh: { geometry: BufferGeometry; material: MeshStandardMaterial; made?: (mesh: InstancedMesh) => void }) => {
      const cells = createCellInstances([{
        tinted: false, meshes: [{ name: 'one', geometry: mesh.geometry, material: mesh.material, castShadow: false, receiveShadow: false, cards: false, far: false, ...(mesh.made ? { made: mesh.made } : {}) }],
      }], YAW_POSE, 0);
      cells.update({ removed: [], added: [{ key: {}, packs: new Map([[0, one]]) }] });
      return cells;
    };
    const both = [cellsOf(store), cellsOf(picture)];
    sizes.forEach((px, s) => views.forEach((v, k) => {
      both.forEach((cells, j) => {
        for (const mesh of cells.meshes) scene.add(mesh);
        // At the distance the prop's measure spans `px` of the panel.
        const camera = new PerspectiveCamera(FOV, 1, 0.05, 10_000);
        const distance = (2 * reach * (PANEL / 2)) / Math.tan((FOV * Math.PI) / 360) / px;
        const centre = new Vector3(0, reach * 0.5, 0);
        camera.position.set(Math.cos(v.azimuth) * Math.cos(v.elevation), Math.sin(v.elevation), Math.sin(v.azimuth) * Math.cos(v.elevation)).multiplyScalar(distance).add(centre);
        camera.lookAt(centre);
        camera.updateMatrixWorld();
        const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const frustum = new Frustum().setFromProjectionMatrix(view);
        for (let pass = 0; pass < 2; pass++) { cells.cull(frustum, view); renderer.render(scene, camera); }
        g.drawImage(canvas, ((s * views.length + k) * 2 + j) * (PANEL + 4), row * (PANEL + 4));
        for (const mesh of cells.meshes) scene.remove(mesh);
      });
    }));
    for (const cells of both) cells.dispose();
  });
  pmrem.dispose();
  ladder.release();
  kit.dispose();
  renderer.dispose();
  return page.toDataURL('image/png');
}

/** A prop's model and its picture's variants drawn alone from one view at `px` across, with and without the sky's light: each one's mean
 *  colour over the pixels it covers (sRGB 0..255), to find what makes a picture lighter or darker than its model. */
export async function propPictureDiagnosis(kind: string, px: number): Promise<{ readonly rows: readonly string[]; readonly png: string }> {
  await MeshoptSimplifier.ready;
  const PANEL = 192;
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setPixelRatio(1);
  renderer.setSize(PANEL, PANEL, false);
  const kit = createSceneryKit();
  const model = (kit.furniture as Record<string, BufferGeometry | undefined>)[kind] ?? kit.treePit;
  if (!model.boundingBox) model.computeBoundingBox();
  const measure = Math.max(...model.boundingBox!.getSize(new Vector3()).toArray());
  const impostors = await import('../render/plantImpostors');
  const { createCellInstances } = await import('../render/cellInstances');
  const { YAW_POSE, NEVER_NEAR } = await import('../render/instanceRuns');
  /** The picture with `edit` made to its fragment shader (its own program). */
  const variant = (name: string, edit: (fragment: string) => string, blend = false, vertex: (v: string) => string = (v) => v) => {
    const set = impostors.createImpostors([{ parts: [{ geometry: model, normals: 'vertex', side: kit.props.side, casts: true, material: kit.props }], measure }], impostors.stillLook(kit.props), `diagnosis-${name}`);
    const own = set.material.onBeforeCompile.bind(set.material);
    set.material.onBeforeCompile = (shader, r) => { own(shader, r); shader.fragmentShader = edit(shader.fragmentShader); shader.vertexShader = vertex(shader.vertexShader); };
    set.material.customProgramCacheKey = () => `diagnosis-${name}`;
    // Its cover blended over what is behind (three's transparent pass, its depth written) in place of alpha to coverage.
    if (blend) { set.material.alphaToCoverage = false; set.material.transparent = true; set.material.depthWrite = true; }
    return { name, mesh: { geometry: set.quads[0]!, material: set.material as MeshStandardMaterial, made: set.attach }, set };
  };
  const variants = [
    { name: 'model', mesh: { geometry: model, material: kit.props as MeshStandardMaterial }, set: null },
    variant('picture', (f) => f),
    // Its cover made all or nothing at a half (the plants' sharpening without their growth): what the frames' blend and the mips do to it.
    variant('picture-cover-cut', (f) => f.replace('float cover = impostorColour.a;', 'float cover = impostorColour.a; cover = clamp((cover - 0.5) / max(fwidth(cover), 1e-4) + 0.5, 0.0, 1.0);')),
    variant('picture-blend', (f) => f, true),
    // Blended over what is behind, from the nearest of the frames alone (the owner's tool's `Mu`: one frame by the view's direction).
    variant('picture-blend-nearest', (f) => f, true, (v) => v.replace('vWeights = w / max(w.x + w.y + w.z, 1e-4);', 'vWeights = w.x >= w.y && w.x >= w.z ? vec3(1.0, 0.0, 0.0) : w.y >= w.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);')),
    // The plants' cover: grown with the mip level, then cut at a half.
    variant('picture-plant-cover', (f) => f.replace('float cover = impostorColour.a;', 'vec2 texelSize = vec2(textureSize(uAlbedo, 0)); float lod = max(0.0, 0.5 * log2(max(dot(impostorDx1 * texelSize, impostorDx1 * texelSize), dot(impostorDy1 * texelSize, impostorDy1 * texelSize)))); float cover = impostorColour.a * (1.0 + lod * 0.3); cover = clamp((cover - 0.5) / max(fwidth(cover), 1e-4) + 0.5, 0.0, 1.0);')),
    // Its normal the quad's (facing the eye): what the baked normal does to its light.
    variant('picture-quad-normal', (f) => f.replace('nonPerturbedNormal = normal;', 'normal = vec3(0.0, 0.0, 1.0); nonPerturbedNormal = normal;')),
  ];
  takeWaitingPictures(renderer);
  const scene = new Scene();
  scene.background = new Color(0xcfcdc6);
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  scene.add(new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8), new AmbientLight(0xdfe9f2, 0.07));
  const sun = new DirectionalLight(0xfff0cf, 3.6);
  sun.position.set(-1, 2, 1.2);
  scene.add(sun);
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 10_000);
  const distance = (measure * (PANEL / 2)) / Math.tan((FOV * Math.PI) / 360) / px;
  const centre = model.boundingBox!.getCenter(new Vector3());
  camera.position.set(Math.cos(0.6) * Math.cos(0.4), Math.sin(0.4), Math.sin(0.6) * Math.cos(0.4)).multiplyScalar(distance).add(centre);
  camera.lookAt(centre);
  camera.updateMatrixWorld();
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const frustum = new Frustum().setFromProjectionMatrix(view);
  const page = document.createElement('canvas');
  page.width = (PANEL + 4) * variants.length; page.height = (PANEL + 4) * 3;
  const g = page.getContext('2d')!;
  const rows: string[] = [];
  const one = { data: new Float32Array([0, 0, 0, 0, 1, 1, 1, NEVER_NEAR]), colours: null, scales: new Float32Array([1]), count: 1 };
  const ambient = new AmbientLight(0xffffff, 3);
  const lights = scene.children.filter((c) => (c as DirectionalLight).isLight);
  ['sky', 'no sky', 'ambient only'].forEach((rig, row) => {
    const sky = rig === 'sky';
    scene.environment = sky ? environment : null;
    // A light with no direction alone: what is left is the colour times its cover, no normal read.
    for (const light of lights) light.visible = rig !== 'ambient only';
    if (rig === 'ambient only') scene.add(ambient);
    variants.forEach((v, column) => {
      const cells = createCellInstances([{ tinted: false, meshes: [{ name: v.name, geometry: v.mesh.geometry, material: v.mesh.material, castShadow: false, receiveShadow: false, cards: false, far: false, ...('made' in v.mesh && v.mesh.made ? { made: v.mesh.made } : {}) }] }], YAW_POSE, 0);
      cells.update({ removed: [], added: [{ key: {}, packs: new Map([[0, one]]) }] });
      for (const mesh of cells.meshes) scene.add(mesh);
      for (let pass = 0; pass < 2; pass++) { cells.cull(frustum, view); renderer.render(scene, camera); }
      g.drawImage(canvas, column * (PANEL + 4), row * (PANEL + 4));
      const pixels = g.getImageData(column * (PANEL + 4), row * (PANEL + 4), PANEL, PANEL).data;
      let n = 0;
      const sum = [0, 0, 0];
      for (let i = 0; i < PANEL * PANEL; i++) {
        const r = pixels[i * 4]!, gg = pixels[i * 4 + 1]!, b = pixels[i * 4 + 2]!;
        if (Math.abs(r - 0xcf) + Math.abs(gg - 0xcd) + Math.abs(b - 0xc6) < 6) continue;
        sum[0]! += r; sum[1]! += gg; sum[2]! += b; n++;
      }
      // Its ink: how much darker than the ground it makes the panel, summed (its colour and its cover at once).
      let ink = 0;
      for (let i = 0; i < PANEL * PANEL; i++) ink += (0xcf - pixels[i * 4]!) + (0xcd - pixels[i * 4 + 1]!) + (0xc6 - pixels[i * 4 + 2]!);
      rows.push(`${kind} ${px} px, ${rig}, ${v.name}: ${n} px covered, mean ${sum.map((x) => (x / Math.max(n, 1)).toFixed(1)).join(', ')}, ink ${(ink / 3).toFixed(0)}`);
      for (const mesh of cells.meshes) scene.remove(mesh);
      cells.dispose();
    });
  });
  for (const v of variants) v.set?.dispose();
  pmrem.dispose();
  kit.dispose();
  renderer.dispose();
  return { rows, png: page.toDataURL('image/png') };
}
