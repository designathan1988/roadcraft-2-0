import {
  ACESFilmicToneMapping, AmbientLight, BoxGeometry, Color, DataUtils, DirectionalLight, Group, HemisphereLight, type InstancedMesh, Mesh, MeshStandardMaterial,
  type Object3D, PCFShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Rng } from '@core/rng';
import { CELL } from '@world/cells';
import { instantiate } from '@world/buildings/blueprints';
import { madeToMeasure } from '@world/buildings/procedural';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { assembleBuildingMeshes, emitProgram, kitBoxes } from '../render/buildings/buildingMesh';
import { type CellArrays, cellArrays } from '../render/buildings/cellArrays';
import type { BuildingChunk } from '../render/buildings/chunk';
import { FarPartBatch } from '../render/buildings/farParts';
import { type BuildingKit, PART_KINDS, type PartKind, createBuildingKit } from '../render/buildings/kit';
import { COARSE_PARTS, DETAIL_PARTS } from '../render/buildings/layerCells';
import { massFloor } from '../render/buildings/massing';
import { PartCell, type PartView } from '../render/buildings/partCells';
import { DETAIL_CELL, type PartFiling, fileParts, partBandings } from '../render/buildings/partFiling';
import { POSE_FLOATS } from '../render/buildings/partPose';
import { SHELL_PARTS } from '../render/buildings/shellParts';
import { sunShadowChunks } from '../render/environment';
import { createGpuTimer } from '../render/gpuTimer';
import { takeWaitingPictures } from '../render/plantImpostors';
import { SUN_CASCADES } from '../render/sunCascades';

/**
 * THE BUILDING PARTS' LADDER SHEETS (`scripts/part-ladder-sheet.mjs`), drawn by the game's own part cells (`partCells.ts`), facade level's batch
 * (`farParts.ts`), shells (`buildingMesh.ts` assembleBuildingMeshes) and materials (`kit.ts`), under the game's lights, its sun's shadow chunks (the
 * cascades', `environment.ts` sunShadowChunks: three lights of one direction, each a map, as `sunCascades.ts` keeps them) and depth convention
 * (reversed, `renderer.ts`), at the screen's own size (1920 x 1080 under the iso rig's 35° perspective):
 * - a ladder a kind: a row of the part on the ground from a few metres to where it is under a pixel, every size it is seen at in one frame;
 * - a wall seen at a slant, condensers hung on it as a bay hangs them and plants on balconies behind glass parapets, a few tens of pixels each:
 *   where a picture's depth meets the wall, the slab and the glass;
 * - the study's tower (the made-to-measure 25-floor residential building) from four corners at a slant;
 * - a district of nine towers, its parts at the detail level (the near cells) and at the facade level (the batch).
 * Each frame: three's draws and triangles (the scene's, and the parts' alone), the scene pass's GPU time (`gpuTimer.ts`), and where the parts
 * stand on it. Whatever checkout serves the page draws its own parts: the same sheet draws one commit's and another's.
 */

/** The screen: 1080 lines under the iso rig's perspective (`isoViewport.ts` PERSPECTIVE_FOV), 16:9. */
const WIDTH = 1920, HEIGHT = 1080, FOV = 35;
/** A metre's pixels at a metre's distance on it: what the layer hands the cells and the batch (`layer.ts` cullDetails). */
const PX_AT_METRE = HEIGHT / 2 / Math.tan((FOV * Math.PI) / 360);
/** Where a ladder's parts stand: from the eye, each this many metres on (a ratio of about 1.3: every size from hundreds of pixels to under one). */
const DISTANCES = [4, 6, 8, 11, 15, 20, 27, 36, 48, 64, 85, 110, 150, 200, 270, 360, 480, 640, 850, 1100, 1500, 2000, 2700].map(m);
/** A ladder's eye (the plan's x and y, its height) and the row it looks along, 4 m to its side. */
const EYE = { x: -m(6), y: m(9), z: m(6) };
const ROW_Y = m(5);
/** Each ladder kind's tint, an instance colour as the town gives them (`facadeProps.ts`'s palettes): a white condenser, a green plant, a blue chair. */
const TINT: Readonly<Partial<Record<PartKind, number>>> = {
  acUnit: 0xe9e7df, foliage: 0x4f7a3a, bush: 0x58803f, chair: 0x3a62a8, table: 0x8a5a36, airer: 0xf0f0ec, dish: 0xd9d4c8, lounger: 0x2f3a46, bike: 0xc0392b, pot: 0xb5643c,
};
/** The scene pass timed under a steady load (a GPU's clock falls between frames of a light page, and an idle one doubled a frame's time,
 *  2026-10-25): `WARM` passes drawn back to back first, then `TIMED` samples, each `BLOCK` passes back to back in one query. */
const WARM = 200, TIMED = 30, BLOCK = 10;

/** One frame of the sheet. */
export interface PartSheetFrame {
  readonly name: string;
  /** The frame, a PNG as a data URL. */
  readonly png: string;
  /** Three's draws and triangles of the frame, and of the building parts alone (the cells' and the batch's groups). */
  readonly drawCalls: number;
  readonly triangles: number;
  readonly partDraws: number;
  readonly partTriangles: number;
  /** The scene pass's GPU time, ms a pass: its median and its 10th and 90th centiles over `TIMED` samples, the shadow map kept. */
  readonly gpu: { readonly supported: boolean; readonly label: string; readonly samples: number; readonly median: number; readonly p10: number; readonly p90: number };
  /** Parts placed: what they are, their distance, their middle on the frame (pixels from the top left) and their diagonal there, pixels. */
  readonly props: readonly { readonly label: string; readonly distance: number; readonly x: number; readonly y: number; readonly px: number }[];
  /** Each part mesh drawn: its name, instances and triangles an instance. */
  readonly meshes: readonly { readonly name: string; readonly count: number; readonly triangles: number }[];
}

/** The stage every frame is drawn on: the renderer, the game's lights and sky, a floor. */
interface Stage {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  /** The sun's cascades: one direction and colour (the shader lights a pixel once, by the first), each its map. */
  readonly suns: readonly DirectionalLight[];
  dispose(): void;
}

function stage(): Stage {
  // The game's shadow chunks, as its renderer sets them before any program is built.
  sunShadowChunks();
  const canvas = document.createElement('canvas');
  // The game's depth convention (`renderer.ts`): the pictures' depth is written in it (`partPictures.ts`).
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false, reversedDepthBuffer: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  const scene = new Scene();
  scene.background = new Color(0xc9d6e0);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  // The game's lights (`environment.ts`): the sky fill, the floor's ambient, the sun.
  scene.add(new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8), new AmbientLight(0xdfe9f2, 0.07));
  const suns = Array.from({ length: SUN_CASCADES }, () => {
    const sun = new DirectionalLight(0xfff0cf, 3.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    scene.add(sun, sun.target);
    return sun;
  });
  const floor = new Mesh(new PlaneGeometry(m(20_000), m(20_000)).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x8f918c, roughness: 0.95 }));
  floor.position.y = -m(0.02);
  floor.receiveShadow = true;
  scene.add(floor);
  return {
    renderer, scene, suns,
    dispose() {
      floor.geometry.dispose();
      (floor.material as MeshStandardMaterial).dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}

/** The sun over `focus` (three's world), each cascade's map `reach` metres a side (the finest holds every point): its texel, m. */
function aimSun(suns: readonly DirectionalLight[], focus: Vector3, reach: number): number {
  for (const sun of suns) {
    sun.position.set(focus.x - m(160), focus.y + m(220), focus.z - m(120));
    sun.target.position.copy(focus);
    Object.assign(sun.shadow.camera, { left: -reach / 2, right: reach / 2, top: reach / 2, bottom: -reach / 2, near: m(1), far: m(900) });
    sun.shadow.camera.updateProjectionMatrix();
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
  }
  return reach / suns[0]!.shadow.mapSize.x;
}

/** What a frame draws of the parts: their group, their choice for the view, their shadow's casters for a texel (null: the passes over). */
export interface PartsDrawn {
  readonly group: Object3D;
  look(view: PartView): void;
  cast(texel: number | null): void;
  dispose(): void;
}

/** The near cells of `filings` (`partCells.ts`), as the layer draws a cell at its detail level. */
export function nearCells(kit: BuildingKit, filings: Iterable<readonly [string, PartFiling]>, root: Group): PartsDrawn {
  const cells = [...filings].map(([key, filing]) => new PartCell(key, filing, kit));
  for (const cell of cells) root.add(cell.group);
  return {
    group: root,
    look(view) { for (const cell of cells) cell.choose(view); },
    cast(texel) { for (const cell of cells) cell.castInto(texel); },
    dispose() { for (const cell of cells) cell.dispose(); },
  };
}

/** The facade level of `filings`: the town's batch of every part kind but the shell's (`farParts.ts`), as the layer draws its facade cells. */
export function facadeBatch(kit: BuildingKit, filings: ReadonlyMap<string, PartFiling>): PartsDrawn {
  const batch = new FarPartBatch(kit);
  const cells = new Map([...filings].map(([key, filing]) => [key, new PartCell(key, { bands: filing.bands.filter((band) => SHELL_PARTS.has(band.kind)) }, kit, filing)] as const));
  batch.sync(cells, () => true);
  return {
    group: batch.group,
    look(view) { batch.view(view.x, view.y, view.z, view.pxAtMetre, view.orthoPx); },
    // The near cascades' passes, then the passes over (`layer.ts` castInto).
    cast(texel) { batch.castShadow(true, texel === null); },
    dispose() { batch.dispose(); for (const cell of cells.values()) cell.dispose(); },
  };
}

/** Whether an object and its parents are shown. */
const shown = (o: Object3D): boolean => { for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
const trianglesOf = (mesh: InstancedMesh): number => (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.getAttribute('position').count) / 3;

/** One frame drawn as the game draws it: the parts chosen for the eye, the sun's map drawn with their casters, the colour without them; three's
 *  counts of it and of the parts alone, the scene pass timed. */
async function shoot(at: Stage, camera: PerspectiveCamera, eye: { x: number; y: number; z: number }, parts: PartsDrawn, texel: number, name: string,
  props: PartSheetFrame['props']): Promise<PartSheetFrame> {
  const { renderer, scene } = at;
  const view: PartView = { x: eye.x, y: eye.y, z: eye.z, pxAtMetre: PX_AT_METRE, orthoPx: null, shadowTexel: texel };
  parts.look(view);
  parts.cast(texel);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  parts.cast(null);
  renderer.render(scene, camera);
  // The parts alone, then the whole frame.
  const visible = new Map(scene.children.map((child) => [child, child.visible] as const));
  for (const child of scene.children) child.visible = child === parts.group;
  renderer.info.reset();
  renderer.info.autoReset = false;
  renderer.render(scene, camera);
  const partDraws = renderer.info.render.calls, partTriangles = renderer.info.render.triangles;
  for (const [child, was] of visible) child.visible = was;
  renderer.info.reset();
  renderer.render(scene, camera);
  const drawCalls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
  renderer.info.autoReset = true;
  const png = renderer.domElement.toDataURL('image/png');
  const meshes: { name: string; count: number; triangles: number }[] = [];
  parts.group.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (mesh.isInstancedMesh && shown(mesh) && mesh.count > 0 && mesh.userData['shadowOnly'] !== true) meshes.push({ name: mesh.name, count: mesh.count, triangles: trianglesOf(mesh) });
  });
  // The scene pass alone (the sun's map kept), timed by the GPU under a steady load.
  const timer = createGpuTimer(renderer);
  const frame = (): Promise<void> => new Promise((done) => { requestAnimationFrame(() => done()); });
  for (let i = 0; i < WARM; i++) {
    renderer.render(scene, camera);
    if (i % BLOCK === BLOCK - 1) await frame();
  }
  for (let i = 0; i < TIMED; i++) {
    timer.poll();
    timer.begin();
    for (let k = 0; k < BLOCK; k++) renderer.render(scene, camera);
    timer.end();
    await frame();
  }
  for (let i = 0; i < 30 && timer.samples.size < TIMED; i++) { await frame(); timer.poll(); }
  const times = timer.samples.toArray().map((ms) => ms / BLOCK).sort((a, b) => a - b);
  const centile = (q: number): number => times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))]! : Number.NaN;
  const gpu = { supported: timer.supported, label: timer.label, samples: times.length, median: centile(0.5), p10: centile(0.1), p90: centile(0.9) };
  return { name, png, drawCalls, triangles, partDraws, partTriangles, gpu, props, meshes };
}

/** A part's middle on the frame and its diagonal there, pixels (its picture's measure, `partPictures.ts`). */
function mark(camera: PerspectiveCamera, middle: Vector3, diagonal: number, label: string, distance: number): PartSheetFrame['props'][number] {
  const depth = -middle.clone().applyMatrix4(camera.matrixWorldInverse).z;
  const p = middle.clone().project(camera);
  return { label, distance, x: Math.round(((p.x + 1) / 2) * WIDTH), y: Math.round(((1 - p.y) / 2) * HEIGHT), px: (diagonal * PX_AT_METRE) / Math.max(depth, 1e-6) };
}

/** One part of `kind` at (x, y, z) in three's world, turned `turn` about up, tinted as the ladder tints it, filed as a cell of its own
 *  (`ladderFilings`). */
function oneFiling(kit: BuildingKit, kind: PartKind, x: number, y: number, z: number, turn: number): readonly [string, PartFiling] {
  const reach = Math.hypot(...kit.screen[kind].extent);
  const tint = new Color(TINT[kind] ?? 0xffffff);
  const poses = new Float32Array([x, y, z, Math.cos(turn), Math.sin(turn), m(1), m(1), m(1)]);
  const colours = new Uint16Array([DataUtils.toHalfFloat(tint.r), DataUtils.toHalfFloat(tint.g), DataUtils.toHalfFloat(tint.b)]);
  const bounds = new Float64Array([x - reach, y - reach, z - reach, x + reach, y + reach, z + reach, x, y, z, reach]);
  const arrays: CellArrays = { shells: [], parts: { [kind]: { count: 1, poses, instanceColor: colours, bounds } }, furniture: {} };
  // The plan's y is three's -z.
  const u = Math.floor(x / DETAIL_CELL), v = Math.floor(-z / DETAIL_CELL);
  const cell = `${Math.floor((u * DETAIL_CELL) / CELL)},${Math.floor((v * DETAIL_CELL) / CELL)}`;
  return [cell, fileParts(cell, [[`${u},${v}`, arrays]], partBandings(kit.screen))] as const;
}

/** A ladder of `kind`: one part at each of `DISTANCES` along the row, each filed as a cell of its own (`fileParts`, its sub-cell's box its
 *  own): its level the one its own size asks. DO NOT file the row as the town's cells: one part a sub-cell, a cell's runs are folded into one
 *  draw at the finest level whenever that costs less than a draw (`partCells.ts` runsOf, `DRAW_TRIANGLES`), and a part at 200 m was drawn as
 *  the one at 6 m is - not what its size asks, as a cell of a town's hundreds of parts does. */
function ladderFilings(kit: BuildingKit, kind: PartKind): { filings: (readonly [string, PartFiling])[]; middles: { distance: number; at: Vector3 }[] } {
  // Its front (the model's +z) turned to the eye at a slant.
  const turn = Math.PI + 0.5;
  const model = kit.geometry[kind];
  if (!model.boundingBox) model.computeBoundingBox();
  // Stood on the ground: its box's foot on it (a condenser's model is centred on its case).
  const lift = -model.boundingBox!.min.y;
  const filings = DISTANCES.map((distance) => oneFiling(kit, kind, EYE.x + distance, lift, -ROW_Y, turn));
  // Its box's middle, turned with it, over its foot.
  const centre = model.boundingBox!.getCenter(new Vector3()).applyAxisAngle(new Vector3(0, 1, 0), turn);
  return { filings, middles: DISTANCES.map((distance) => ({ distance, at: new Vector3(EYE.x + distance, lift, -ROW_Y).add(centre) })) };
}

/** The ladder frames of `kinds`. */
async function ladderFrames(kit: BuildingKit, at: Stage, kinds: readonly PartKind[]): Promise<PartSheetFrame[]> {
  const out: PartSheetFrame[] = [];
  const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, m(0.4), m(8000));
  camera.position.set(EYE.x, EYE.z, -EYE.y);
  camera.lookAt(EYE.x + m(400), 0, -EYE.y);
  camera.updateMatrixWorld();
  const texel = aimSun(at.suns, new Vector3(EYE.x + m(120), 0, -EYE.y), m(300));
  for (const kind of kinds) {
    const { filings, middles } = ladderFilings(kit, kind);
    const root = new Group();
    at.scene.add(root);
    const parts = nearCells(kit, filings, root);
    const diagonal = Math.hypot(...kit.screen[kind].extent);
    const props = middles.map(({ distance, at: middle }) => mark(camera, middle, diagonal, kind, distance));
    out.push(await shoot(at, camera, { x: EYE.x, y: EYE.y, z: EYE.z }, parts, texel, kind, props));
    parts.dispose();
    at.scene.remove(root);
  }
  return out;
}

/** A wall in three's plane z = 0 (facing -z, the plan's +y), 160 m long and 20 m high: condensers hung on it as a bay hangs them (`facadeProps.ts`:
 *  the case's middle `AC.gap + AC.d / 2` out of the wall, its front out), and balconies (a slab 1.4 m deep, a glass parapet at its edge, the
 *  kit's own glass) with a plant and a chair on each against the wall; seen from two eyes at a slant. */
async function wallFrames(kit: BuildingKit, at: Stage): Promise<PartSheetFrame[]> {
  const out: PartSheetFrame[] = [];
  const concrete = new MeshStandardMaterial({ color: 0xd8c8a8, roughness: 0.85 });
  const scenery = new Group();
  const wall = new Mesh(new BoxGeometry(m(160), m(20), m(0.3)), concrete);
  wall.position.set(m(20), m(10), m(0.15));
  scenery.add(wall);
  // Facing -z: the model's +z turned there.
  const out0 = Math.PI;
  const parts: (readonly [string, PartFiling])[] = [];
  const marks: { kind: PartKind; middle: Vector3 }[] = [];
  const place = (kind: PartKind, x: number, y: number, z: number): void => {
    parts.push(oneFiling(kit, kind, x, y, z, out0));
    const geometry = kit.geometry[kind];
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    marks.push({ kind, middle: geometry.boundingBox!.getCenter(new Vector3()).applyAxisAngle(new Vector3(0, 1, 0), out0).add(new Vector3(x, y, z)) });
  };
  for (let k = 0; k < 10; k++) place('acUnit', m(-20) + k * m(9), k % 2 ? m(5) : m(3), -m(0.08 + 0.23 / 2));
  for (let k = 0; k < 7; k++) {
    const x = m(-15) + k * m(12), floor = m(7);
    const slab = new Mesh(new BoxGeometry(m(2.4), m(0.15), m(1.4)), concrete);
    slab.position.set(x, floor - m(0.075), -m(0.7));
    const glass = new Mesh(new BoxGeometry(m(2.4), m(0.92), m(0.02)), kit.material.glassRail);
    glass.position.set(x, floor + m(0.46), -m(1.35));
    scenery.add(slab, glass);
    place(k % 2 ? 'bush' : 'foliage', x - m(0.6), floor, -m(0.3));
    place('chair', x + m(0.5), floor, -m(0.45));
  }
  scenery.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  at.scene.add(scenery);
  const root = new Group();
  at.scene.add(root);
  const drawn = nearCells(kit, parts, root);
  const texel = aimSun(at.suns, new Vector3(m(20), 0, -m(10)), m(200));
  for (const [name, eye, look] of [
    ['wall-left', { x: m(-45), y: m(40), z: m(8) }, new Vector3(m(15), m(5), 0)],
    ['wall-right', { x: m(75), y: m(28), z: m(12) }, new Vector3(m(10), m(5), 0)],
  ] as const) {
    const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, m(0.5), m(8000));
    camera.position.set(eye.x, eye.z, -eye.y);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    const diagonal = (kind: PartKind): number => Math.hypot(...kit.screen[kind].extent);
    const props = marks.map((p) => mark(camera, p.middle, diagonal(p.kind), p.kind, p.middle.distanceTo(camera.position)))
      .filter((p) => p.x > 40 && p.x < WIDTH - 40 && p.y > 40 && p.y < HEIGHT - 40);
    out.push(await shoot(at, camera, eye, drawn, texel, name, props));
  }
  drawn.dispose();
  at.scene.remove(root, scenery);
  scenery.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose(); });
  concrete.dispose();
  return out;
}

/** The study's tower at a lot (the plan's x, y), `seed` its variety. */
function tower(at: { x: number; y: number }, id: number, seed: number): Building {
  const made = madeToMeasure('residential', 'high', { W: m(40), D: m(36) }, new Rng(seed));
  return { ...instantiate(made.body, at, 0), id: id as BuildingId } as Building;
}

/** Buildings' chunks filed by cell as their jobs file them: each building in its sub-cell (`cellWork.ts`), every detail part (`DETAIL_PARTS`). */
export function buildingFilings(kit: BuildingKit, chunks: readonly { readonly b: Building; readonly chunk: BuildingChunk }[]): Map<string, PartFiling> {
  const boxes = kitBoxes(kit);
  const bySub = new Map<string, BuildingChunk[]>();
  for (const { b, chunk } of chunks) {
    const key = `${Math.floor(b.x / DETAIL_CELL)},${Math.floor(b.y / DETAIL_CELL)}`;
    bySub.set(key, [...(bySub.get(key) ?? []), chunk]);
  }
  const parts = PART_KINDS.filter((k) => DETAIL_PARTS.has(k));
  const byCell = new Map<string, (readonly [string, CellArrays])[]>();
  for (const [sub, list] of bySub) {
    const comma = sub.indexOf(',');
    const cell = `${Math.floor(Number(sub.slice(0, comma)) * DETAIL_CELL / CELL)},${Math.floor(Number(sub.slice(comma + 1)) * DETAIL_CELL / CELL)}`;
    byCell.set(cell, [...(byCell.get(cell) ?? []), [sub, cellArrays(list, { parts, shells: false, furniture: false, ghost: false, dim: false }, boxes)] as const]);
  }
  return new Map([...byCell].map(([cell, details]) => [cell, fileParts(cell, details, boxes.bandings!)] as const));
}

/** Each pose of `kinds` in `filings`: its box's middle in three's world (the pose turned and scaled), and its diagonal, m. */
function partsOf(kit: BuildingKit, filings: ReadonlyMap<string, PartFiling>, kinds: readonly PartKind[]): { kind: PartKind; middle: Vector3; diagonal: number }[] {
  const out: { kind: PartKind; middle: Vector3; diagonal: number }[] = [];
  for (const filing of filings.values()) {
    for (const band of filing.bands) {
      if (!kinds.includes(band.kind)) continue;
      const geometry = kit.geometry[band.kind];
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const centre = geometry.boundingBox!.getCenter(new Vector3());
      const e = kit.screen[band.kind].extent;
      for (let i = 0; i < band.start[band.start.length - 1]!; i++) {
        const o = i * POSE_FLOATS, p = band.poses;
        const c = p[o + 3]!, s = p[o + 4]!, sx = p[o + 5]!, sy = p[o + 6]!, sz = p[o + 7]!;
        // `partPose.ts` poseMatrixInto: T * Ry * S.
        const x = centre.x * sx, y = centre.y * sy, z = centre.z * sz;
        out.push({ kind: band.kind, middle: new Vector3(p[o]! + c * x + s * z, p[o + 1]! + y, p[o + 2]! - s * x + c * z), diagonal: Math.hypot(e[0] * sx, e[1] * sy, e[2] * sz) });
      }
    }
  }
  return out;
}

/** The tower from its four corners at a slant (its condensers and plants a few tens of pixels), then the district of nine towers at its detail
 *  level from 250 and 800 m and at its facade level from 800 m. */
async function townFrames(kit: BuildingKit, at: Stage): Promise<PartSheetFrame[]> {
  const out: PartSheetFrame[] = [];
  const ground = (): number => 0;
  const programOf = (b: Building): { near: BuildingChunk; far: BuildingChunk } => {
    const p = emitProgram(b, ground, undefined, ground, { near: true, far: true }, { floor: massFloor(b, ground) ?? null });
    return { near: p.near!, far: p.far! };
  };
  const draw = async (name: string, buildings: readonly Building[], level: 'detail' | 'facade', eye: { x: number; y: number; z: number }, look: Vector3, props: readonly PartKind[]): Promise<void> => {
    const programs = buildings.map((b) => ({ b, ...programOf(b) }));
    const chunks = programs.map(({ b, near, far }) => ({ b, chunk: level === 'detail' ? near : far }));
    const filings = buildingFilings(kit, chunks);
    const shells = level === 'detail'
      ? assembleBuildingMeshes(chunks.map((c) => c.chunk), kit, false, false, { parts: COARSE_PARTS, shells: true, furniture: false })
      : assembleBuildingMeshes(chunks.map((c) => c.chunk), kit, false, false, { parts: new Set<PartKind>([...COARSE_PARTS, ...SHELL_PARTS]), shells: true, furniture: true });
    at.scene.add(shells.group);
    const root = new Group();
    at.scene.add(root);
    const parts = level === 'detail' ? nearCells(kit, filings, root) : facadeBatch(kit, filings);
    if (level === 'facade') at.scene.add(parts.group);
    const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, m(0.5), m(20_000));
    camera.position.set(eye.x, eye.z, -eye.y);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    const texel = aimSun(at.suns, look.clone().setY(0), level === 'detail' && props.length ? m(260) : m(700));
    // The parts asked for, in the frame, a few tens of pixels: what the crops show.
    const marks = partsOf(kit, filings, props).map((p) => mark(camera, p.middle, p.diagonal, p.kind, p.middle.distanceTo(camera.position)))
      .filter((p) => p.x > 40 && p.x < WIDTH - 40 && p.y > 40 && p.y < HEIGHT - 40 && p.px > 12 && p.px < 46)
      .sort((a, b) => Math.hypot(a.x - WIDTH / 2, a.y - HEIGHT / 2) - Math.hypot(b.x - WIDTH / 2, b.y - HEIGHT / 2));
    const picked = props.flatMap((kind) => marks.filter((p) => p.label === kind).slice(0, 3));
    out.push(await shoot(at, camera, eye, parts, texel, name, picked));
    parts.dispose();
    at.scene.remove(root, parts.group, shells.group);
    shells.dispose();
  };
  // The tower's lot (40 x 36 m from its anchor), and its middle halfway up.
  const one = [tower({ x: m(60), y: m(60) }, 1, 1)];
  const middle = new Vector3(m(80), m(30), -m(78));
  for (const [corner, dx, dy] of [['ne', 1, 1], ['se', 1, -1], ['sw', -1, -1], ['nw', -1, 1]] as const) {
    const eye = { x: m(80) + dx * m(48), y: m(78) + dy * m(48), z: m(24) };
    await draw(`tower-${corner}`, one, 'detail', eye, middle, ['acUnit', 'foliage', 'bush']);
  }
  // Nine towers 90 m apart.
  const nine: Building[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nine.push(tower({ x: m(30) + i * m(90), y: m(30) + j * m(90) }, 10 + i * 3 + j, 1 + i * 3 + j));
  const centre = new Vector3(m(140), m(30), -m(140));
  await draw('district-detail-250', nine, 'detail', { x: m(140) - m(180), y: m(140) - m(180), z: m(80) }, centre, []);
  await draw('district-detail-800', nine, 'detail', { x: m(140) - m(520), y: m(140) - m(520), z: m(320) }, centre, []);
  await draw('district-facade-800', nine, 'facade', { x: m(140) - m(520), y: m(140) - m(520), z: m(320) }, centre, []);
  return out;
}

/** The sheet's frames: the ladders of `kinds`, then the tower and the district (`town`). The pictures are taken before anything is chosen, as
 *  the game's first frames take them (`farForest.ts` update). */
export async function partSheetFrames(kinds: readonly PartKind[], town = true): Promise<PartSheetFrame[]> {
  const kit = createBuildingKit(16);
  await kit.levelsReady;
  const at = stage();
  takeWaitingPictures(at.renderer);
  const out = [...await ladderFrames(kit, at, kinds), ...(town ? [...await wallFrames(kit, at), ...await townFrames(kit, at)] : [])];
  at.dispose();
  kit.dispose();
  return out;
}
