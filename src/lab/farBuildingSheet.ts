import { Box3, BufferAttribute, BufferGeometry, Group, InterleavedBuffer, InterleavedBufferAttribute, type InstancedMesh, Mesh, MeshStandardMaterial, type Object3D, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial, SRGBColorSpace, Vector3, WebGLRenderer, ACESFilmicToneMapping } from 'three';
import { Rng } from '@core/rng';
import { CELL } from '@world/cells';
import { instantiate } from '@world/buildings/blueprints';
import { madeToMeasure } from '@world/buildings/procedural';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { assembleBuildingMeshes, emitProgram } from '../render/buildings/buildingMesh';
import { cellMass } from '../render/buildings/cellArrays';
import { type BuildingKit, type PartKind, createBuildingKit } from '../render/buildings/kit';
import { COARSE_PARTS } from '../render/buildings/layerCells';
import { BASE_VERTEX, type BaseMass, type BasePiece, BaseWriter, writeBase } from '../render/buildings/massBase';
import { cellMesh } from '../render/buildings/massCells';
import { CELL_DETAIL, type MassDetail, PLATE_DETAIL, TILE_DETAIL, massFloor, massOf } from '../render/buildings/massing';
import type { PartView } from '../render/buildings/partCells';
import { SHELL_PARTS } from '../render/buildings/shellParts';
import { type SceneEnvironment, createEnvironment, sunShadowChunks } from '../render/environment';
import { createGpuTimer } from '../render/gpuTimer';
import { takeWaitingPictures } from '../render/plantImpostors';
import { buildingFilings, facadeBatch, nearCells } from './partLadderSheet';

/**
 * THE FAR BUILDINGS' SHEET (`scripts/far-building-sheet.mjs`): a glass tower and a masonry tower drawn by every level of the building layer, each
 * as the layer draws it - the detail (L0: the near program's shells and the near cells' parts, `partLadderSheet.ts` nearCells), the facade level
 * (L1: the far program's shells and the town's far batch), the masses at the cell's, the tile's and the plate's detail (`massing.ts` massOf over
 * the program, `massCells.ts` cellMesh) and the base (`massBase.ts`, for information) - under the game's own sky, sun, cascades and light at the
 * hour the game opens on (`environment.ts`), at the screen's own size (1920 x 1080, the iso rig's 35°), looked at as the Home view (V0) looks at
 * downtown, from several distances. Each shot: the tower's crop, three's draws and triangles of it alone, the mean colour of each of its faces
 * (the light averaged, as the eye averages a face it cannot resolve). And a district of towers at the masses' and the facade level from the V0 and
 * V5 eyes, its scene pass timed under a steady load. Whatever checkout serves the page draws its own levels: one tree's sheet against another's.
 */

/** The screen: 1080 lines under the iso rig's perspective (`isoViewport.ts` PERSPECTIVE_FOV), 16:9. */
const WIDTH = 1920, HEIGHT = 1080, FOV = 35;
/** A metre's pixels at a metre's distance on it. */
const PX_AT_METRE = HEIGHT / 2 / Math.tan((FOV * Math.PI) / 360);
/** The Home view's look down at downtown (V0: the camera at (932, 1464, 932) over the origin, 48.0° down; five wheel steps in, V5, 47.2°, both
 *  measured in the game, 2026-10-25) and its bearing, from the +x, +z quadrant of three's world. */
const DOWN = (47.6 * Math.PI) / 180, BEARING = Math.PI / 4;
/** The eyes' distances to a tower, m: the facade level's reach, V5's nearest and farthest towers (1.9 and 1.2 px a metre), V0's (0.86 to 0.71). */
const DISTANCES = [350, 900, 1400, 2000, 2400].map(m);
/** The district's eyes: V0's distance to the origin, and V5's. */
const V0_DISTANCE = m(1975), V5_DISTANCE = m(1041);
/** The hour the game opens on (its clock at the V0 to V5 shots, 06:35). */
const GAME_MINUTES = 6 * 60 + 35;
/** The scene pass timed under a steady load (`partLadderSheet.ts`): `WARM` passes back to back, then `TIMED` samples of `BLOCK` passes each. */
const WARM = 200, TIMED = 30, BLOCK = 10;

export const FAR_LEVELS = ['L0', 'L1', 'cell', 'tile', 'plate', 'base'] as const;
export type FarLevel = (typeof FAR_LEVELS)[number];

/** A face's mean colour seen at a shot: its pixels' light averaged in linear and given back in sRGB, 0..255, and how many pixels it covers. */
export interface FaceMean { readonly rgb: readonly [number, number, number]; readonly pixels: number }

/** One tower drawn by one level from one distance. */
export interface FarTowerShot {
  readonly tower: string;
  readonly level: FarLevel;
  readonly distance: number;
  /** The tower's crop of the frame, a PNG as a data URL, and where it was cut (pixels from the top left). */
  readonly png: string;
  readonly crop: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Three's draws and triangles of the tower alone at this level. */
  readonly drawCalls: number;
  readonly triangles: number;
  /** A metre across the face turned to +x, across the one turned to +z, and up, in pixels at the tower's middle. */
  readonly pxPerMetre: { readonly x: number; readonly z: number; readonly up: number };
  /** The mean colour of its walls facing +x, those facing +z, and its roofs (`FaceMean`). */
  readonly faces: { readonly x: FaceMean; readonly z: FaceMean; readonly roof: FaceMean };
}

/** A frame of the district, timed. */
export interface FarDistrictFrame {
  readonly name: string;
  readonly png: string;
  readonly drawCalls: number;
  readonly triangles: number;
  /** The scene pass's GPU time, ms a pass: its median and its 10th and 90th centiles over `TIMED` samples, the shadow maps kept. */
  readonly gpu: { readonly supported: boolean; readonly label: string; readonly samples: number; readonly median: number; readonly p10: number; readonly p90: number };
}

/** The stage: the renderer, the game's environment (sky, its sky as the environment map, the sun's cascades, the fill and the sky light). */
interface Stage {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly env: SceneEnvironment;
  dispose(): void;
}

function stage(kit: BuildingKit): Stage {
  sunShadowChunks();
  const canvas = document.createElement('canvas');
  // The game's renderer's settings (`renderer.ts`): reversed depth, ACES, sRGB out, the cascades drawn when asked.
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false, reversedDepthBuffer: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  const scene = new Scene();
  // The ultra quality's shadows (`quality.ts`).
  const env = createEnvironment(scene, renderer, { shadows: true, shadowMapSize: 2048 });
  const dark = env.setTimeOfDay(GAME_MINUTES);
  kit.setNight(dark, GAME_MINUTES / 60);
  const floor = new Mesh(new PlaneGeometry(m(20_000), m(20_000)).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x8f918c, roughness: 0.95 }));
  floor.position.y = -m(0.02);
  floor.receiveShadow = true;
  scene.add(floor);
  return {
    renderer, scene, env,
    dispose() {
      floor.geometry.dispose();
      (floor.material as MeshStandardMaterial).dispose();
      env.dispose();
      renderer.dispose();
    },
  };
}

/** What a level draws: its group, the parts' choice for the eye, their shadow's casters for a cascade's texel. */
interface LevelDrawn {
  readonly group: Group;
  look(view: PartView): void;
  cast(texel: number | null): void;
  dispose(): void;
}

const ground = (): number => 0;

/** Every level of `buildings`, each in a group of its own, hidden; the masses coloured by each finish's colour from afar, as the layer's jobs colour them (`cellWork.ts`, `kit.finishTone`). */
function levelsOf(kit: BuildingKit, buildings: readonly Building[], levels: readonly FarLevel[]): Map<FarLevel, LevelDrawn> {
  const near = levels.includes('L0');
  const programs = buildings.map((b) => ({ b, p: emitProgram(b, ground, undefined, ground, { near, far: true }, { floor: massFloor(b, ground) ?? null, tone: kit.finishTone }) }));
  const out = new Map<FarLevel, LevelDrawn>();
  const still = (group: Group, dispose: () => void): LevelDrawn => ({ group, look() {}, cast() {}, dispose });
  for (const level of levels) {
    const group = new Group();
    group.name = `far-sheet-${level}`;
    group.visible = false;
    if (level === 'L0') {
      const chunks = programs.map(({ b, p }) => ({ b, chunk: p.near! }));
      const shells = assembleBuildingMeshes(chunks.map((c) => c.chunk), kit, false, false, { parts: COARSE_PARTS, shells: true, furniture: false });
      const parts = nearCells(kit, buildingFilings(kit, chunks), new Group());
      group.add(shells.group, parts.group);
      out.set(level, { group, look: (v) => parts.look(v), cast: (t) => parts.cast(t), dispose() { parts.dispose(); shells.dispose(); } });
    } else if (level === 'L1') {
      const chunks = programs.map(({ b, p }) => ({ b, chunk: p.far! }));
      const shells = assembleBuildingMeshes(chunks.map((c) => c.chunk), kit, false, false, { parts: new Set<PartKind>([...COARSE_PARTS, ...SHELL_PARTS]), shells: true, furniture: true });
      const parts = facadeBatch(kit, buildingFilings(kit, chunks));
      group.add(shells.group, parts.group);
      out.set(level, { group, look: (v) => parts.look(v), cast: (t) => parts.cast(t), dispose() { parts.dispose(); shells.dispose(); } });
    } else if (level === 'base') {
      const writer = new BaseWriter();
      for (const { b, p } of programs) writeBase(writer.cellOf(b), p);
      const xs = buildings.map((b) => Math.floor(b.x / CELL)), ys = buildings.map((b) => Math.floor(b.y / CELL));
      const i0 = Math.min(...xs), j0 = Math.min(...ys);
      const base = writer.done({ i0, j0, n: Math.max(Math.max(...xs) - i0, Math.max(...ys) - j0) + 1 });
      const meshes = base ? base.pieces.map((piece) => baseMeshOf(piece, base.place, kit)) : [];
      group.add(...meshes);
      out.set(level, still(group, () => { for (const mesh of meshes) mesh.geometry.dispose(); }));
    } else {
      const detail: MassDetail = level === 'cell' ? CELL_DETAIL : level === 'tile' ? TILE_DETAIL : PLATE_DETAIL;
      const chunks = programs.flatMap(({ p }) => { const c = massOf(p, detail); return c ? [c] : []; });
      const mass = cellMass(chunks);
      const mesh = mass ? cellMesh(mass, kit, `building-massing-${level}`) : null;
      if (mesh) group.add(mesh);
      out.set(level, still(group, () => { mesh?.geometry.dispose(); }));
    }
  }
  return out;
}

/** A base's piece as the layer draws it (`massCells.ts` baseMesh: its vertices one buffer of shorts, its place on its grid read normalised and
 *  put in place by the mesh's matrix, its paint), every cell of it drawn (the layer leaves a group a cell the base draws, `syncBases`). */
function baseMeshOf(piece: BasePiece, place: BaseMass['place'], kit: BuildingKit): Mesh {
  const g = new BufferGeometry();
  const vertices = new InterleavedBuffer(piece.vertices, BASE_VERTEX);
  g.setAttribute('position', new InterleavedBufferAttribute(vertices, 3, 0, true));
  g.setAttribute('basePaint', new InterleavedBufferAttribute(vertices, 1, 3, true));
  g.setIndex(new BufferAttribute(piece.index, 1));
  g.addGroup(0, piece.index.length, 0);
  const mesh = new Mesh(g, [kit.massingBase]);
  mesh.position.set(place.x, place.y, place.z);
  mesh.scale.setScalar(place.step * 65535);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Its box on its grid: three culls by the geometry's own frame.
  mesh.frustumCulled = false;
  mesh.name = 'building-massing-base';
  return mesh;
}

/** The eye `distance` from `target`, looking at it as the Home view looks at downtown. */
function cameraAt(target: Vector3, distance: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, m(2), m(30_000));
  const flat = distance * Math.cos(DOWN);
  camera.position.set(target.x + flat * Math.cos(BEARING), target.y + distance * Math.sin(DOWN), target.z + flat * Math.sin(BEARING));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

/** The level `drawn` alone of the buildings' levels, its parts chosen for the eye, the sun's cascades fitted to the view and drawn with its casters. */
function show(at: Stage, levels: ReadonlyMap<FarLevel, LevelDrawn>, drawn: LevelDrawn, camera: PerspectiveCamera, target: Vector3, top: number): void {
  for (const other of levels.values()) other.group.visible = other === drawn;
  // The cascades fitted first: the parts' view carries the near cascade's texel, as the layer hands it (`layer.ts` cullDetails).
  at.env.follow(camera, target, top, ground);
  drawn.look({ x: camera.position.x, y: -camera.position.z, z: camera.position.y, pxAtMetre: PX_AT_METRE, orthoPx: null, shadowTexel: at.env.shadowNearTexel() });
  at.env.setCasters((texel) => drawn.cast(texel));
  if (at.env.shadowPass({ changed: true, effects: false })) at.renderer.shadowMap.needsUpdate = true;
  at.renderer.render(at.scene, camera);
  drawn.cast(null);
  at.env.setCasters(null);
  // The frame as it stands, the cascades kept.
  at.renderer.render(at.scene, camera);
}

/** Three's draws and triangles of `group` alone (the sky and the floor left out). */
function counts(at: Stage, camera: PerspectiveCamera, group: Group): { drawCalls: number; triangles: number } {
  const visible = new Map(at.scene.children.map((child) => [child, child.visible] as const));
  for (const child of at.scene.children) child.visible = child === group;
  at.renderer.info.autoReset = false;
  at.renderer.info.reset();
  at.renderer.render(at.scene, camera);
  const out = { drawCalls: at.renderer.info.render.calls, triangles: at.renderer.info.render.triangles };
  at.renderer.info.autoReset = true;
  for (const [child, was] of visible) child.visible = was;
  return out;
}

/** A face's world normal, from the derivatives of its place (every level alike, whatever its vertex carries), packed into the colour. */
const NORMALS = new ShaderMaterial({
  vertexShader: 'varying vec3 vWorld;\nvoid main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
  fragmentShader: `varying vec3 vWorld;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(n, cameraPosition - vWorld) < 0.0) n = -n;
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
});

/** The pixels of a crop of the frame now drawn, top row first, RGBA. */
function pixels(renderer: WebGLRenderer, x: number, y: number, w: number, h: number): Uint8Array {
  const gl = renderer.getContext();
  const raw = new Uint8Array(w * h * 4);
  gl.readPixels(x, HEIGHT - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) out.set(raw.subarray((h - 1 - row) * w * 4, (h - row) * w * 4), row * w * 4);
  return out;
}

const toLinear = (c: number): number => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const toSrgb = (x: number): number => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));

/** Each face's pixels of the level now shown (its meshes alone through `NORMALS`: the instanced parts, which place themselves, left out) and their mean colour in `colour`. */
function faceMeans(at: Stage, drawn: LevelDrawn, camera: PerspectiveCamera, crop: FarTowerShot['crop'], colour: Uint8Array): FarTowerShot['faces'] {
  const hidden: Object3D[] = [];
  at.scene.traverse((o) => {
    if (!o.visible) return;
    const inLevel = (() => { for (let p: Object3D | null = o; p; p = p.parent) if (p === drawn.group) return true; return false; })();
    if ((o as Mesh).isMesh && (!inLevel || (o as InstancedMesh).isInstancedMesh)) { o.visible = false; hidden.push(o); }
  });
  // Cleared black (the renderer's own clear colour, `scene.background` null: the game's sky is a mesh, hidden here).
  at.scene.overrideMaterial = NORMALS;
  at.renderer.render(at.scene, camera);
  const normals = pixels(at.renderer, crop.x, crop.y, crop.w, crop.h);
  at.scene.overrideMaterial = null;
  for (const o of hidden) o.visible = true;
  const sums = { x: [0, 0, 0, 0], z: [0, 0, 0, 0], roof: [0, 0, 0, 0] };
  for (let i = 0; i < crop.w * crop.h; i++) {
    const o = i * 4;
    if (normals[o]! === 0 && normals[o + 1]! === 0 && normals[o + 2]! === 0) continue;
    const nx = normals[o]! / 127.5 - 1, ny = normals[o + 1]! / 127.5 - 1, nz = normals[o + 2]! / 127.5 - 1;
    const face = ny > 0.7 ? sums.roof : Math.abs(ny) < 0.3 ? (Math.abs(nx) > Math.abs(nz) ? sums.x : sums.z) : null;
    if (!face) continue;
    face[0]! += toLinear(colour[o]!); face[1]! += toLinear(colour[o + 1]!); face[2]! += toLinear(colour[o + 2]!); face[3]!++;
  }
  const mean = (s: number[]): FaceMean => ({ rgb: s[3] ? [toSrgb(s[0]! / s[3]), toSrgb(s[1]! / s[3]), toSrgb(s[2]! / s[3])] : [0, 0, 0], pixels: s[3]! });
  return { x: mean(sums.x), z: mean(sums.z), roof: mean(sums.roof) };
}

/** RGBA pixels, top row first, as a PNG data URL. */
function pngOf(rgba: Uint8Array, w: number, h: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  return canvas.toDataURL('image/png');
}

/** A point of three's world on the frame, pixels from the top left. */
function onFrame(camera: PerspectiveCamera, p: Vector3): { x: number; y: number } {
  const v = p.clone().project(camera);
  return { x: ((v.x + 1) / 2) * WIDTH, y: ((1 - v.y) / 2) * HEIGHT };
}

/** A tower of the study: the made-to-measure building of `use` and the high density on the large lot (40 x 36 m), `seed` its variety, at the plan's (x, y). */
function tower(use: 'commercial' | 'residential', seed: number, at: { x: number; y: number }, id: number): Building {
  const made = madeToMeasure(use, 'high', { W: m(40), D: m(36) }, new Rng(seed));
  return { ...instantiate(made.body, at, 0), id: id as BuildingId } as Building;
}

/** The study's towers: an office of the glass style (its walls the 'glass' finish, 73 m) and a block of flats in ceramic (77 m). */
const TOWERS = [
  { name: 'glass', use: 'commercial', seed: 1 },
  { name: 'masonry', use: 'residential', seed: 1 },
] as const;

/** Each study tower drawn by each level from each distance. */
async function towerShots(kit: BuildingKit, at: Stage): Promise<FarTowerShot[]> {
  const out: FarTowerShot[] = [];
  for (const [k, spec] of TOWERS.entries()) {
    const b = tower(spec.use, spec.seed, { x: m(60), y: m(60) }, 1 + k);
    const levels = levelsOf(kit, [b], FAR_LEVELS);
    for (const drawn of levels.values()) at.scene.add(drawn.group);
    // The tower's box from its cell masses (`CellMass.bounds`, the world's).
    const box = new Box3().setFromObject(levels.get('cell')!.group);
    const target = box.getCenter(new Vector3());
    for (const distance of DISTANCES) {
      const camera = cameraAt(target, distance);
      // The crop: the box's corners on the frame, a few pixels round them.
      let x0 = WIDTH, y0 = HEIGHT, x1 = 0, y1 = 0;
      for (const cx of [box.min.x, box.max.x]) for (const cy of [box.min.y, box.max.y]) for (const cz of [box.min.z, box.max.z]) {
        const p = onFrame(camera, new Vector3(cx, cy, cz));
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      const pad = 6;
      const crop = { x: Math.max(0, Math.floor(x0) - pad), y: Math.max(0, Math.floor(y0) - pad), w: 0, h: 0 };
      crop.w = Math.min(WIDTH, Math.ceil(x1) + pad) - crop.x;
      crop.h = Math.min(HEIGHT, Math.ceil(y1) + pad) - crop.y;
      const middle = onFrame(camera, target);
      const along = (d: Vector3): number => { const p = onFrame(camera, target.clone().add(d)); return Math.hypot(p.x - middle.x, p.y - middle.y); };
      const pxPerMetre = { x: along(new Vector3(0, 0, 1)), z: along(new Vector3(1, 0, 0)), up: along(new Vector3(0, 1, 0)) };
      for (const level of FAR_LEVELS) {
        const drawn = levels.get(level)!;
        show(at, levels, drawn, camera, target, box.max.y);
        const colour = pixels(at.renderer, crop.x, crop.y, crop.w, crop.h);
        const png = pngOf(colour, crop.w, crop.h);
        const { drawCalls, triangles } = counts(at, camera, drawn.group);
        const faces = faceMeans(at, drawn, camera, crop, colour);
        out.push({ tower: spec.name, level, distance, png, crop, drawCalls, triangles, pxPerMetre, faces });
      }
    }
    for (const drawn of levels.values()) { at.scene.remove(drawn.group); drawn.dispose(); }
  }
  return out;
}

/** The scene pass's GPU time under a steady load (`partLadderSheet.ts` shoot). */
async function timed(at: Stage, camera: PerspectiveCamera): Promise<FarDistrictFrame['gpu']> {
  const timer = createGpuTimer(at.renderer);
  const frame = (): Promise<void> => new Promise((done) => { requestAnimationFrame(() => done()); });
  for (let i = 0; i < WARM; i++) {
    at.renderer.render(at.scene, camera);
    if (i % BLOCK === BLOCK - 1) await frame();
  }
  for (let i = 0; i < TIMED; i++) {
    timer.poll();
    timer.begin();
    for (let k = 0; k < BLOCK; k++) at.renderer.render(at.scene, camera);
    timer.end();
    await frame();
  }
  for (let i = 0; i < 30 && timer.samples.size < TIMED; i++) { await frame(); timer.poll(); }
  const times = timer.samples.toArray().map((ms) => ms / BLOCK).sort((a, b) => a - b);
  const centile = (q: number): number => times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))]! : Number.NaN;
  return { supported: timer.supported, label: timer.label, samples: times.length, median: centile(0.5), p10: centile(0.1), p90: centile(0.9) };
}

/** A district of 12 x 12 towers 90 m apart round the origin, of 16 kinds (the offices and the blocks of flats of the high density, seeds 1 to 8:
 *  five of them glass), drawn by its masses, tiles and facade level from the V0 and V5 eyes, and an empty frame (the floor and the sky) for the
 *  timer's own spread; each timed. */
async function districtFrames(kit: BuildingKit, at: Stage): Promise<FarDistrictFrame[]> {
  const kinds = [...[1, 2, 3, 4, 5, 6, 7, 8].map((seed) => ['commercial', seed] as const), ...[1, 2, 3, 4, 5, 6, 7, 8].map((seed) => ['residential', seed] as const)];
  const buildings: Building[] = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    const [use, seed] = kinds[(i * 12 + j * 5) % kinds.length]!;
    buildings.push(tower(use, seed, { x: m(-540) + i * m(90), y: m(-540) + j * m(90) }, 100 + i * 12 + j));
  }
  const levels = levelsOf(kit, buildings, ['L1', 'cell', 'tile']);
  for (const drawn of levels.values()) at.scene.add(drawn.group);
  const target = new Vector3(0, 0, 0);
  const out: FarDistrictFrame[] = [];
  const frame = async (name: string, level: FarLevel | null, distance: number): Promise<void> => {
    const camera = cameraAt(target, distance);
    const drawn = level ? levels.get(level)! : null;
    if (drawn) show(at, levels, drawn, camera, target, m(120));
    else { for (const other of levels.values()) other.group.visible = false; at.renderer.render(at.scene, camera); }
    const png = at.renderer.domElement.toDataURL('image/png');
    const { drawCalls, triangles } = drawn ? counts(at, camera, drawn.group) : { drawCalls: 0, triangles: 0 };
    out.push({ name, png, drawCalls, triangles, gpu: await timed(at, camera) });
  };
  await frame('district-cell-V0', 'cell', V0_DISTANCE);
  await frame('district-tile-V0', 'tile', V0_DISTANCE);
  await frame('district-cell-V5', 'cell', V5_DISTANCE);
  await frame('district-L1-V5', 'L1', V5_DISTANCE);
  await frame('empty-V0', null, V0_DISTANCE);
  for (const drawn of levels.values()) { at.scene.remove(drawn.group); drawn.dispose(); }
  return out;
}

/** The sheet's shots and frames: the study's towers by every level (`towers`), then the district (`district`). The parts' pictures taken first, as the game's first frames take them. */
export async function farBuildingSheet(district = true, towers = true): Promise<{ readonly towers: readonly FarTowerShot[]; readonly districts: readonly FarDistrictFrame[] }> {
  const kit = createBuildingKit(16);
  await kit.levelsReady;
  const at = stage(kit);
  takeWaitingPictures(at.renderer);
  const shots = towers ? await towerShots(kit, at) : [];
  const districts = district ? await districtFrames(kit, at) : [];
  at.dispose();
  kit.dispose();
  return { towers: shots, districts };
}

/** One cell of a composed sheet: an image (a PNG data URL) enlarged `scale` times by its nearest pixel, a caption under it, and swatches of colours with their labels. */
export interface SheetCell { readonly png: string; readonly scale: number; readonly caption: string; readonly swatches?: readonly { readonly rgb: readonly [number, number, number]; readonly label: string }[] }
/** A row of a composed sheet: its title, then its cells left to right. */
export interface SheetRow { readonly title: string; readonly cells: readonly SheetCell[] }

/** Rows of images side by side, each enlarged by its nearest pixel, as one PNG data URL: a sheet's page. */
export async function composeSheet(heading: string, rows: readonly SheetRow[]): Promise<string> {
  const load = (src: string): Promise<HTMLImageElement> => new Promise((done, fail) => { const img = new Image(); img.onload = () => done(img); img.onerror = () => fail(new Error('[far sheet] an image did not load')); img.src = src; });
  const images = await Promise.all(rows.map((row) => Promise.all(row.cells.map((cell) => load(cell.png)))));
  const GAP = 10, TITLE = 22, CAPTION = 18, SWATCH = 16, HEAD = 34;
  const sizes = rows.map((row, r) => row.cells.map((cell, c) => ({ w: images[r]![c]!.width * cell.scale, h: images[r]![c]!.height * cell.scale })));
  const swatchRows = (cell: SheetCell): number => (cell.swatches?.length ? cell.swatches.length : 0);
  const rowHeights = rows.map((row, r) => TITLE + Math.max(0, ...sizes[r]!.map((s) => s.h)) + CAPTION + Math.max(0, ...row.cells.map((cell) => swatchRows(cell) * SWATCH)) + GAP);
  const width = Math.max(600, ...sizes.map((row) => row.reduce((sum, s) => sum + Math.max(s.w, 170) + GAP, GAP)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = HEAD + rowHeights.reduce((a, b) => a + b, 0);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#f2f2f2';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(heading, GAP, 24);
  let y = HEAD;
  rows.forEach((row, r) => {
    ctx.fillStyle = '#e8d9a0';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(row.title, GAP, y + 16);
    let x = GAP;
    const top = y + TITLE, tallest = Math.max(0, ...sizes[r]!.map((s) => s.h));
    row.cells.forEach((cell, c) => {
      const s = sizes[r]![c]!;
      ctx.drawImage(images[r]![c]!, x, top, s.w, s.h);
      ctx.fillStyle = '#d8d8d8';
      ctx.font = '13px sans-serif';
      ctx.fillText(cell.caption, x, top + tallest + 14);
      (cell.swatches ?? []).forEach((sw, k) => {
        const sy = top + tallest + CAPTION + k * SWATCH;
        ctx.fillStyle = `rgb(${sw.rgb[0]}, ${sw.rgb[1]}, ${sw.rgb[2]})`;
        ctx.fillRect(x, sy, 26, SWATCH - 3);
        ctx.fillStyle = '#d8d8d8';
        ctx.font = '12px sans-serif';
        ctx.fillText(sw.label, x + 32, sy + 11);
      });
      x += Math.max(s.w, 170) + GAP;
    });
    y += rowHeights[r]!;
  });
  return canvas.toDataURL('image/png');
}

/** Two images of one size and their difference: per pixel, the largest channel's, times `gain`, as red over the first image darkened; and the share of pixels over 8 and over 32 of 255, and the largest. */
export async function diffImage(before: string, after: string, gain = 4): Promise<{ readonly png: string; readonly changed8: number; readonly changed32: number; readonly largest: number }> {
  const read = async (src: string): Promise<ImageData> => {
    const img = await new Promise<HTMLImageElement>((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = () => fail(new Error('[far sheet] an image did not load')); i.src = src; });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  };
  const a = await read(before), b = await read(after);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`[far sheet] images of different sizes: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  const out = new Uint8Array(a.data.length);
  let over8 = 0, over32 = 0, largest = 0;
  for (let o = 0; o < a.data.length; o += 4) {
    const d = Math.max(Math.abs(a.data[o]! - b.data[o]!), Math.abs(a.data[o + 1]! - b.data[o + 1]!), Math.abs(a.data[o + 2]! - b.data[o + 2]!));
    if (d > 8) over8++;
    if (d > 32) over32++;
    largest = Math.max(largest, d);
    const grey = (a.data[o]! + a.data[o + 1]! + a.data[o + 2]!) / 3 * 0.3;
    out[o] = Math.min(255, grey + d * gain); out[o + 1] = grey; out[o + 2] = grey; out[o + 3] = 255;
  }
  const n = a.data.length / 4;
  return { png: pngOf(out, a.width, a.height), changed8: over8 / n, changed32: over32 / n, largest };
}
