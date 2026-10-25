import {
  ACESFilmicToneMapping, AmbientLight, Color, DirectionalLight, HemisphereLight, type InstancedBufferGeometry, type InstancedMesh, type InterleavedBufferAttribute, Mesh,
  MeshStandardMaterial, type Object3D, PCFShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { PoleId } from '@world/ids';
import { m } from '@world/units';
import { castCastersInto } from '../render/shadowCasters';
import { buildUtilities } from '../render/poleLayer';
import { createSceneryKit } from '../render/scenery';
import { WIRE_WIDTH, wireChords } from '../render/utilities';

/**
 * THE WIRES' LADDER SHEETS (`scripts/wire-ladder-sheet.mjs`): two lines of poles strung with wires from a few metres to the horizon, drawn
 * by the game's own pole layer (`poleLayer.ts` buildUtilities: its blocks, levels and wires) with the game's lights and its sun's shadow, at the
 * screen's own size (1920 x 1080 under the iso rig's 35° perspective): every size a wire is seen at, from a cable tens of pixels wide to its
 * last fraction of a pixel, in one frame - from the street (the eye 6 m up) and from the air (150 m). Whatever checkout serves the page draws
 * its own layer: one tree's frames against another's (`propLadderSheet.ts` propLadderCompare).
 */

const WIDTH = 1920, HEIGHT = 1080, FOV = 35;
/** The poles: every 30 m along x (a street's span) from just ahead of the eye to the horizon, on two lines beside the eye's way. */
const SPAN = m(30), FIRST = m(4), LAST = m(2700);
/** The two lines: urban poles (the arm over the street, the rack, the light under the wires) and rural ones (`@world/utilities` POLE_KINDS). */
const LINES = [{ y: m(7), kind: 'urban' }, { y: -m(16), kind: 'rural' }] as const;
/** The views: from the street and from the air, each looking down the lines; and a pole of each line close up, three quarters on (the
 *  third pole of each, 64 m along, a lamp on it). */
const VIEWS = [
  { name: 'street', eye: new Vector3(-m(6), m(6), 0), at: new Vector3(m(400), m(5), 0) },
  { name: 'aerial', eye: new Vector3(-m(60), m(150), m(60)), at: new Vector3(m(500), 0, 0) },
  { name: 'urban-close', eye: new Vector3(m(56), m(7), m(1)), at: new Vector3(m(64), m(7.2), -m(7)) },
  { name: 'rural-close', eye: new Vector3(m(56), m(7), m(8)), at: new Vector3(m(64), m(7.2), m(16)) },
  // The urban pole from its arm's side (world +y, three's -z): its rack and spools, every wire on its support.
  { name: 'urban-rack', eye: new Vector3(m(59), m(7.4), -m(11)), at: new Vector3(m(64), m(7.6), -m(7)) },
] as const;

/** One frame of the sheet: the picture, what three drew, the wires' triangles, and where each span's middle stands on it with its size. */
export interface WireFrame {
  readonly name: string;
  readonly png: string;
  readonly drawCalls: number;
  readonly triangles: number;
  /** The wires' meshes drawn: their instances and triangles each, and their sum (what three sends: template x instances). */
  readonly wires: readonly { readonly count: number; readonly triangles: number }[];
  readonly wireTriangles: number;
  /** The triangles of the wires with an area: each wire's own chords as the vertex shader keeps them (`utilities.ts` WIRE_GLSL wireChords),
   *  4 a chord creased, 2 once thinner than 1.5 px at its nearest - worked out here on the CPU by the same rules, not read from the GPU. */
  readonly wireAreaTriangles: number;
  /** The triangles three sends for each of the layer's meshes drawn this frame, summed by name (index / 3 x instances). */
  readonly meshes: Readonly<Record<string, number>>;
  /** Each span's middle on the frame (pixels from the top left), its distance, and a metre's pixels there (`props` for the compare's crops). */
  readonly props: readonly { readonly distance: number; readonly x: number; readonly y: number; readonly px: number }[];
}

export async function wireLadderFrames(): Promise<WireFrame[]> {
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  const kit = createSceneryKit();
  const doc = new RoadDoc();
  for (const { y, kind } of LINES) {
    let last: PoleId | null = null;
    for (let x = FIRST, i = 0; x <= LAST; x += SPAN, i++) {
      const id = doc.addPole({ x, y }, i % 2 === 0, kind).id;
      if (last !== null) doc.addPoleSpan(last, id);
      last = id;
    }
  }
  const net = new Network(doc);
  net.rebuild();
  const layer = buildUtilities(net, () => 0, kit);
  const scene = new Scene();
  scene.background = new Color(0xc9d6e0);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  // The game's lights (`environment.ts`): the sky fill, the floor's ambient, the sun.
  scene.add(new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8), new AmbientLight(0xdfe9f2, 0.07));
  const sun = new DirectionalLight(0xfff0cf, 3.6);
  sun.position.set(m(120) - m(160), m(220), -m(120));
  sun.target.position.set(m(120), 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -m(150), right: m(150), top: m(150), bottom: -m(150), near: m(1), far: m(800) });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);
  const floor = new Mesh(new PlaneGeometry(m(20_000), m(20_000)).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x8f918c, roughness: 0.95 }));
  floor.position.y = -m(0.02);
  floor.receiveShadow = true;
  scene.add(floor, layer.group);
  const texel = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x;
  const perUnitAtOne = (HEIGHT / 2) / Math.tan((FOV * Math.PI) / 360);
  const out: WireFrame[] = [];
  for (const v of VIEWS) {
    const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, m(0.4), m(8000));
    // The views in three's axes: x east, y up, z south (the map's -y).
    camera.position.copy(v.eye);
    camera.lookAt(v.at);
    camera.updateMatrixWorld();
    // Drawn as a cascade of the game is (`sunCascades.ts`): each caster's casting for the map's texel, then the colour; twice, the second
    // with the screen's size the first told the layer (`poleLayer.ts` noteScreen).
    renderer.shadowMap.autoUpdate = false;
    for (let pass = 0; pass < 2; pass++) {
      castCastersInto(texel);
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
      castCastersInto(null);
      renderer.render(scene, camera);
    }
    renderer.info.reset();
    renderer.info.autoReset = false;
    renderer.render(scene, camera);
    const drawCalls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
    renderer.info.autoReset = true;
    const png = canvas.toDataURL('image/png');
    const shown = (o: Object3D): boolean => { for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const wires: { count: number; triangles: number }[] = [];
    let wireAreaTriangles = 0;
    const eye = camera.position, perUnit = (HEIGHT / 2) * camera.projectionMatrix.elements[5]!;
    layer.group.traverse((o) => {
      if (o.name !== 'utility-wires' || !shown(o)) return;
      const g = (o as InstancedMesh).geometry as InstancedBufferGeometry;
      wires.push({ count: g.instanceCount, triangles: g.index!.count / 3 });
      // Each wire's own chords, at most the template's: its chord's nearest point to the eye less its sag (`WIRE_GLSL` wireScale).
      const finest = g.index!.count / 12, data = (g.getAttribute('aStart') as InterleavedBufferAttribute).data.array as Float32Array;
      for (let i = 0; i < g.instanceCount; i++) {
        // An empty slot (`WIRE_ABSENT`): no wire.
        if (data[i * 8 + 6]! < 0) continue;
        const o8 = i * 8, a = new Vector3(data[o8], data[o8 + 1], data[o8 + 2]), c = new Vector3(data[o8 + 3], data[o8 + 4], data[o8 + 5]).sub(a);
        const k = Math.min(1, Math.max(0, eye.clone().sub(a).dot(c) / Math.max(c.lengthSq(), 1e-8)));
        const near = Math.max(a.clone().addScaledVector(c, k).distanceTo(eye) - data[o8 + 6]!, 1e-4);
        wireAreaTriangles += (WIRE_WIDTH * (perUnit / near) >= 1.5 ? 4 : 2) * Math.min(finest, wireChords(perUnit / near, data[o8 + 6]!));
      }
    });
    const meshes: Record<string, number> = {};
    layer.group.traverse((o) => {
      const mesh = o as InstancedMesh;
      if (!mesh.isMesh || !shown(o)) return;
      const g = mesh.geometry as InstancedBufferGeometry;
      const count = mesh.isInstancedMesh ? mesh.count : g.isInstancedBufferGeometry ? g.instanceCount : 1;
      const perOne = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      if (count > 0) meshes[o.name] = (meshes[o.name] ?? 0) + perOne * count;
    });
    const props = [];
    for (let x = FIRST + SPAN / 2; x <= LAST; x += SPAN) {
      // The nearer line's span middle, a few metres up (three's axes).
      const mid = new Vector3(x, m(6), -LINES[0].y);
      const w = mid.clone().applyMatrix4(camera.matrixWorldInverse).z;
      if (w >= 0) continue;
      const at = mid.clone().project(camera);
      props.push({ distance: x - v.eye.x, x: Math.round(((at.x + 1) / 2) * WIDTH), y: Math.round(((1 - at.y) / 2) * HEIGHT), px: perUnitAtOne / -w });
    }
    out.push({ name: v.name, png, drawCalls, triangles, wires, wireTriangles: wires.reduce((s, x) => s + x.count * x.triangles, 0), wireAreaTriangles, meshes, props });
  }
  layer.dispose();
  pmrem.dispose();
  floor.geometry.dispose();
  (floor.material as MeshStandardMaterial).dispose();
  kit.dispose();
  renderer.dispose();
  return out;
}
