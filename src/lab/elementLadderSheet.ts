import {
  ACESFilmicToneMapping, AmbientLight, Box3, Color, DirectionalLight, Frustum, HemisphereLight, type InstancedMesh, Matrix4, Mesh, MeshStandardMaterial,
  type Object3D, PCFShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DEFAULT_BRUSH, scatter, type ElementItem, type ElementKind } from '@world/elements';
import { m, UNITS_PER_METER } from '@world/units';
import { createElementLayer, loadElementKit } from '../render/elements';
import { takeWaitingPictures } from '../render/plantImpostors';
import { castCastersInto } from '../render/shadowCasters';

/**
 * THE GROUND COVER'S LADDER SHEETS (`scripts/element-ladder-sheet.mjs`): a strip of one kind of element laid as the brush lays it (`scatter`, its
 * default brush), from under the eye to the horizon, drawn by the game's own element layer (`elements.ts`) with its own files, textures and
 * materials, the game's lights and shadows, at the screen's own size (1920 x 1080 under the iso rig's 35° perspective): every size an element is
 * seen at, from its model to its last pixel, in one frame. Whatever checkout serves the page draws its own layer and files.
 */

const WIDTH = 1920, HEIGHT = 1080, FOV = 35;
/** The strip: along the plan's x from the eye, this wide; laid in dabs of this radius. */
const LENGTH = m(800), HALF_WIDTH = m(6), DAB = m(4);
/** The eye: over the strip's start, a person's height, looking down along it. */
const EYE = { x: -m(1), height: m(1.7) };
/** The sizes the ladder's levels change at (`propLevels.ts`: 48, 16, 1.5 px) and between them: the element nearest each is reported. */
const SIZES = [96, 48, 40, 24, 16, 12, 8, 4, 2, 1.5];

export interface ElementLadderFrame {
  readonly name: string;
  /** The frame, a PNG as a data URL. */
  readonly png: string;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly elements: number;
  /** For each of SIZES, the element nearest it on the strip's middle: where it stands on the frame and its size there (its model's largest extent). */
  readonly crops: readonly { readonly x: number; readonly y: number; readonly px: number; readonly distance: number }[];
  /** Each mesh of the layer drawn: its name, instances and triangles an instance. */
  readonly meshes: readonly { readonly name: string; readonly count: number; readonly triangles: number }[];
}

const trianglesOf = (mesh: InstancedMesh): number => (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.getAttribute('position').count) / 3;

/** The frames: one a kind, the strip of that kind alone. */
export async function elementLadderFrames(kinds: readonly ElementKind[]): Promise<ElementLadderFrame[]> {
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  const kit = await loadElementKit(16);
  const out: ElementLadderFrame[] = [];
  for (const kind of kinds) {
    // The strip laid dab by dab, each dab's spacing kept from the dabs round it (`terrainBrush.ts` passes the elements near the dab).
    let seed = 1234567;
    const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const items: ElementItem[] = [];
    for (let x = DAB; x < LENGTH; x += DAB * 2) {
      for (let y = -HALF_WIDTH + DAB; y <= HALF_WIDTH - DAB; y += DAB * 2) {
        const nearby = items.filter((e) => Math.abs(e.x - x) < DAB * 3 && Math.abs(e.y - y) < DAB * 3);
        items.push(...scatter(kind, DEFAULT_BRUSH[kind], x, y, DAB, UNITS_PER_METER, random, nearby));
      }
    }
    const layer = createElementLayer(kit);
    layer.sync(null, { elements: items, elementsIn: (r) => items.filter((e) => e.x >= r[0] && e.x <= r[2] && e.y >= r[1] && e.y <= r[3]) }, () => 0);
    const scene = new Scene();
    scene.background = new Color(0xc9d6e0);
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.6;
    // The game's lights (`environment.ts`): the sky fill, the floor's ambient, the sun.
    scene.add(new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8), new AmbientLight(0xdfe9f2, 0.07));
    const sun = new DirectionalLight(0xfff0cf, 3.6);
    sun.position.set(m(60) - m(160), m(220), -m(120));
    sun.target.position.set(m(60), 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -m(80), right: m(80), top: m(80), bottom: -m(80), near: m(1), far: m(800) });
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun, sun.target);
    const floor = new Mesh(new PlaneGeometry(m(20_000), m(20_000)).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x8a8f7c, roughness: 0.95 }));
    floor.position.y = -m(0.02);
    floor.receiveShadow = true;
    scene.add(floor, layer.group);

    const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, m(0.08), m(8000));
    camera.position.set(EYE.x, EYE.height, 0);
    camera.lookAt(EYE.x + m(60), 0, 0);
    camera.updateMatrixWorld();
    const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(view);
    // Culled, the pictures taken between draws (as `farForest.ts` takes them in the game), culled again with them.
    layer.cull(frustum, view);
    takeWaitingPictures(renderer);
    layer.cull(frustum, view);
    // The sun's map drawn as the game draws a cascade (`sunCascades.ts`), then the colour over it with the map kept.
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
    layer.cull(frustum, view);
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
    const meshes: { name: string; count: number; triangles: number }[] = [];
    layer.group.traverse((o) => {
      const mesh = o as InstancedMesh;
      if (mesh.isInstancedMesh && shown(mesh) && mesh.count > 0) meshes.push({ name: mesh.name, count: mesh.count, triangles: trianglesOf(mesh) });
    });
    // Each element's size on the frame: its model's largest extent (every part) times its size, over its depth (the ladder's measure).
    const variants = kit.models.get(kind) ?? [];
    const measures = variants.map((parts) => {
      const box = new Box3();
      for (const part of parts) { if (!part.geometry.boundingBox) part.geometry.computeBoundingBox(); box.union(part.geometry.boundingBox!); }
      return Math.max(...box.getSize(new Vector3()).toArray());
    });
    const perUnitAtOne = (HEIGHT / 2) / Math.tan((FOV * Math.PI) / 360);
    const placed = items.filter((e) => Math.abs(e.y) < m(1.5)).map((e) => {
      const measure = measures[Math.min(measures.length - 1, Math.floor(e.seed * measures.length))] ?? 1;
      const foot = new Vector3(e.x, measure * e.size * 0.5, -e.y);
      const depth = -foot.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const at = foot.clone().project(camera);
      return { x: Math.round(((at.x + 1) / 2) * WIDTH), y: Math.round(((1 - at.y) / 2) * HEIGHT), px: (measure * e.size * perUnitAtOne) / Math.max(depth, 1e-6), distance: e.x - EYE.x };
    }).filter((p) => p.x >= 12 && p.x < WIDTH - 12 && p.y >= 12 && p.y < HEIGHT - 12);
    const crops = SIZES.flatMap((size) => {
      let best: (typeof placed)[number] | null = null;
      for (const p of placed) if (!best || Math.abs(Math.log(p.px / size)) < Math.abs(Math.log(best.px / size))) best = p;
      return best ? [best] : [];
    });
    out.push({ name: kind, png, drawCalls, triangles, elements: items.length, crops, meshes });
    layer.dispose();
    pmrem.dispose();
    floor.geometry.dispose();
    (floor.material as MeshStandardMaterial).dispose();
  }
  kit.dispose();
  renderer.dispose();
  return out;
}
