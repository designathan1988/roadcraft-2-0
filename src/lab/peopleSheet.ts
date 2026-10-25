import {
  AmbientLight, BufferAttribute, BufferGeometry, Color, DataTexture, DirectionalLight, DoubleSide, FloatType, InstancedBufferAttribute,
  Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, SkinnedMesh,
  SphereGeometry, SRGBColorSpace, Vector3, WebGLRenderer, type Object3D, type Texture,
} from 'three';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { clipTransferFor, loadRocketboxClips, neutralWalkFor, walkDuration } from '../render/citizenWalk';
import { readKtx2 } from '../render/ktx2Texture';
import { assemblePerson, decodeCookedPerson, type CookedHeader } from '../render/people/cookedPerson';
import { createPersonImpostor } from '../render/people/personImpostor';
import { createPersonMaterials } from '../render/people/personMaterial';
import { BIKE_FIT, MOTO_FIT, RIDER_CLIPS, STEER_FULL, helmetShape, stopTiltFor, type RiderClipKey } from '../render/riderPoses';
import { buildTwoWheelerModel } from '../render/vehicleModels';

/**
 * A COOKED PERSON'S SHEET (`scripts/people-sheet.mjs`): one person's file and atlas, read from whatever folder the script serves, drawn
 * level by level with the game's own reader and material (`cookedPerson.ts`, `personMaterial.ts`) and its impostor card
 * (`personImpostor.ts`). Rows: the body rendered, the body as wireframe, the head rendered, the head as wireframe; columns: each mesh
 * level, then the impostor. No fingerprint is checked: the sheet draws the file it is handed.
 */

/** One level's numbers: its triangles, and the vertices its triangles reach. */
export interface SheetLevel { readonly triangles: number; readonly vertices: number; readonly error: number }

export interface SheetResult {
  readonly id: string;
  readonly height: number;
  readonly vertices: number;
  readonly levels: readonly SheetLevel[];
  readonly impostor: CookedHeader['mesh']['impostor'];
  readonly atlas: CookedHeader['atlas'];
  readonly morphs: number;
  readonly bones: number;
  /** The sheet, a PNG as a data URL. */
  readonly png: string;
}

const BODY_W = 300, BODY_H = 600, HEAD_W = 300, HEAD_H = 300;
const RENDER_BACK = 0xd9dde2, WIRE_BACK = 0xffffff;
/** The camera's yaw from the front (+Z, the impostor's frame 0) unless the sheet asks another: a three-quarter view. */
const THREE_QUARTER = 25;

/** The bones' matrices of `mesh` as the palette pass writes them: one row, four texels a bone (`personMaterial.ts` getBoneMatrix). */
function paletteOf(mesh: SkinnedMesh): DataTexture {
  mesh.skeleton.update();
  const data = Float32Array.from(mesh.skeleton.boneMatrices!);
  const texture = new DataTexture(data, mesh.skeleton.bones.length * 4, 1, RGBAFormat, FloatType);
  texture.needsUpdate = true;
  return texture;
}

/** A geometry with `source`'s vertex attributes (no face shapes) and `index`. */
function levelGeometry(source: BufferGeometry, index: BufferAttribute): BufferGeometry {
  const g = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) g.setAttribute(name, attribute);
  g.setIndex(index);
  g.boundingBox = source.boundingBox;
  g.boundingSphere = source.boundingSphere;
  return g;
}

/** One figure of `geometry` drawn as the game draws it: an instance at the origin, its palette row 0, its mesh's own frame (`local`). */
function figure(geometry: BufferGeometry, material: InstancedMesh['material'], local: Matrix4): InstancedMesh {
  const g = geometry.clone();
  g.setAttribute('citizenRow', new InstancedBufferAttribute(new Float32Array(1), 1));
  const mesh = new InstancedMesh(g, material, 1);
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3);
  mesh.setMatrixAt(0, local);
  mesh.frustumCulled = false;
  return mesh;
}

/** The same level as wireframe over a flat fill: the triangles the level draws, in its bind pose. */
function wire(geometry: BufferGeometry, local: Matrix4): Object3D[] {
  const fill = new Mesh(geometry, new MeshBasicMaterial({ color: 0xc8ccd2, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  const lines = new Mesh(geometry, new MeshBasicMaterial({ color: 0x1a1d22, wireframe: true }));
  for (const m of [fill, lines]) { m.matrixAutoUpdate = false; m.matrix.copy(local); m.frustumCulled = false; }
  return [fill, lines];
}

/** An orthographic camera at the sheet's yaw looking at `centre`, `height` metres of the scene tall, `aspect` wide. */
function cameraAt(centre: Vector3, height: number, aspect: number, yaw: number): OrthographicCamera {
  const camera = new OrthographicCamera((-height * aspect) / 2, (height * aspect) / 2, height / 2, -height / 2, 0.01, 50);
  camera.position.set(centre.x + Math.sin(yaw) * 10, centre.y, centre.z + Math.cos(yaw) * 10);
  camera.lookAt(centre);
  camera.updateMatrixWorld(true);
  return camera;
}

/** The person's file and atlas drawn into one sheet, seen from `yawDegrees` off the front. */
export async function peopleSheet(binUrl: string, atlasUrl: string, yawDegrees = THREE_QUARTER): Promise<SheetResult> {
  const yaw = (yawDegrees * Math.PI) / 180;
  const binResponse = await fetch(binUrl);
  if (!binResponse.ok) throw new Error(`${binUrl}: ${binResponse.status}`);
  const { person } = decodeCookedPerson(await binResponse.arrayBuffer());
  const header = person.header;
  const atlasResponse = await fetch(atlasUrl);
  if (!atlasResponse.ok) throw new Error(`${atlasUrl}: ${atlasResponse.status}`);
  const atlas: Texture = await readKtx2(await atlasResponse.arrayBuffer(), header.atlas.codec, 'color');
  const root = assemblePerson(person);
  root.updateMatrixWorld(true);
  let source: SkinnedMesh | undefined;
  root.traverse((o) => { if ((o as SkinnedMesh).isSkinnedMesh && !source) source = o as SkinnedMesh; });
  if (!source) throw new Error(`${header.id}: no mesh`);
  const mesh = source;
  const levels = mesh.geometry.userData['levels'] as BufferAttribute[];
  const local = mesh.matrixWorld.clone();
  const palette = { uniform: { value: paletteOf(mesh) as Texture }, base: { value: 0 } };
  const materials = createPersonMaterials(atlas, header.mesh.alphaTest, palette, mesh);
  const plain = new BufferGeometry();
  for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) plain.setAttribute(name, attribute);
  plain.boundingBox = mesh.geometry.boundingBox;
  plain.boundingSphere = mesh.geometry.boundingSphere;

  // Where the head is: its bone in the bind posture, or the top tenth of the body.
  const head = new Vector3(0, header.height * 0.92, 0);
  root.traverse((o) => { if (/^(head|Bip01_Head)$/.test(o.name)) o.getWorldPosition(head); });
  head.y += 0.06;
  const body = new Vector3(0, header.height / 2, 0);

  const columns = levels.length + 1;
  const canvas = document.createElement('canvas');
  canvas.width = columns * BODY_W;
  canvas.height = BODY_H * 2 + HEAD_H * 2;
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setScissorTest(true);
  renderer.autoClear = false;
  const light = (scene: Scene): void => {
    scene.add(new AmbientLight(0xffffff, 1.1));
    const sun = new DirectionalLight(0xffffff, 2.4);
    sun.position.set(2, 4, 5);
    scene.add(sun);
  };
  const draw = (scene: Scene, camera: OrthographicCamera, x: number, y: number, w: number, h: number, back: number): void => {
    // Rows from the top of the sheet: WebGL's viewport counts from the bottom.
    const bottom = canvas.height - y - h;
    renderer.setViewport(x, bottom, w, h);
    renderer.setScissor(x, bottom, w, h);
    renderer.setClearColor(new Color(back), 1);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
  };
  const stats: SheetLevel[] = [];
  levels.forEach((index, k) => {
    const geometry = levelGeometry(plain, index);
    const used = new Set<number>();
    for (let i = 0; i < index.count; i++) used.add(index.getX(i));
    stats.push({ triangles: index.count / 3, vertices: used.size, error: header.mesh.levels[k]!.error });
    const lit = new Scene();
    light(lit);
    lit.add(figure(geometry, materials.lit, local));
    const lines = new Scene();
    lines.add(...wire(geometry, local));
    const x = k * BODY_W;
    draw(lit, cameraAt(body, header.height * 1.08, BODY_W / BODY_H, yaw), x, 0, BODY_W, BODY_H, RENDER_BACK);
    draw(lines, cameraAt(body, header.height * 1.08, BODY_W / BODY_H, yaw), x, BODY_H, BODY_W, BODY_H, WIRE_BACK);
    draw(lit, cameraAt(head, 0.42, HEAD_W / HEAD_H, yaw), x, BODY_H * 2, HEAD_W, HEAD_H, RENDER_BACK);
    draw(lines, cameraAt(head, 0.42, HEAD_W / HEAD_H, yaw), x, BODY_H * 2 + HEAD_H, HEAD_W, HEAD_H, WIRE_BACK);
  });
  // The impostor: its card at the origin as the game stands it, its two triangles, and its strip of frames from the atlas.
  {
    const card = createPersonImpostor(atlas, header.mesh.impostor, header.atlas.size, header.height, 1);
    card.mesh.count = 1;
    card.mesh.visible = true;
    card.mesh.frustumCulled = false;
    card.mesh.setMatrixAt(0, new Matrix4());
    const lit = new Scene();
    light(lit);
    lit.add(card.mesh);
    const x = levels.length * BODY_W;
    draw(lit, cameraAt(body, header.height * 1.08, BODY_W / BODY_H, yaw), x, 0, BODY_W, BODY_H, RENDER_BACK);
    const quad = new BufferGeometry();
    const w = (header.height * header.mesh.impostor.width) / header.mesh.impostor.height;
    quad.setAttribute('position', new BufferAttribute(new Float32Array([-w / 2, 0, 0, w / 2, 0, 0, w / 2, header.height, 0, -w / 2, header.height, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const lines = new Scene();
    lines.add(...wire(quad, new Matrix4().makeRotationY(yaw)));
    draw(lines, cameraAt(body, header.height * 1.08, BODY_W / BODY_H, yaw), x, BODY_H, BODY_W, BODY_H, WIRE_BACK);
    // The strip: frame k at yaw k * 2pi / frames, left to right, as the atlas holds them.
    const imp = header.mesh.impostor, size = header.atlas.size;
    const strip = new PlaneGeometry(1, 1);
    const u0 = imp.x / size, u1 = (imp.x + imp.width * imp.frames) / size, v1 = 1 - imp.y / size, v0 = 1 - (imp.y + imp.height) / size;
    strip.setAttribute('uv', new BufferAttribute(new Float32Array([u0, v1, u1, v1, u0, v0, u1, v0]), 2));
    const stripMesh = new Mesh(strip, new MeshBasicMaterial({ map: atlas, transparent: true, alphaTest: 0.5 }));
    const stripScene = new Scene();
    stripScene.add(stripMesh);
    const aspect = (imp.width * imp.frames) / imp.height;
    stripMesh.scale.set(aspect, 1, 1);
    const stripCamera = new OrthographicCamera(-aspect / 2, aspect / 2, (aspect / 2) * (HEAD_H * 2) / HEAD_W, (-aspect / 2) * (HEAD_H * 2) / HEAD_W, -1, 1);
    draw(stripScene, stripCamera, x, BODY_H * 2, HEAD_W, HEAD_H * 2, RENDER_BACK);
  }
  const png = canvas.toDataURL('image/png');
  renderer.dispose();
  atlas.dispose();
  return {
    id: header.id, height: header.height, vertices: header.mesh.vertexCount, levels: stats, impostor: header.mesh.impostor, atlas: header.atlas,
    morphs: header.mesh.morphs.length, bones: header.mesh.bones.length, png,
  };
}

/**
 * One picture of a person: a level (`level`, 0 the nearest), the whole body or the head, `width` x `height` pixels, seen from `yaw` degrees
 * off the front, in a pose: `bind`, `walk:<cycle share 0..1>`, `idle:<seconds>` (the game's own transfer, `citizenWalk.ts`) or `ride:<rider clip>` (on its machine, `rideScene`), with face
 * channels (`face`, `faceExpression.ts` names and weights). `metresTall`: the scene's height in the picture (the body: its height x 1.08;
 * the head: 0.42 m), so a picture's pixels per metre are `height / metresTall`.
 */
export interface PersonView {
  readonly name: string;
  readonly level: number;
  readonly kind: 'body' | 'head';
  readonly yaw: number;
  readonly pose: string;
  readonly width: number;
  readonly height: number;
  readonly metresTall?: number;
  readonly face?: Readonly<Record<string, number>>;
  /** The impostor's frames: the background left transparent, and lit by an ambient light of 1 alone, so the picture is the surface's own
   *  colour (the impostor's card is lit again where it is drawn, `personImpostor.ts`). */
  readonly impostor?: boolean;
}

/**
 * A rider posed by a rider clip (`ride:<clip>`, `riderPoses.ts` RIDER_CLIPS) on its machine as the game puts them together (`agents.ts`
 * placeRiderFigure): the two-wheeler's body, trim, fork and cranks under the pelvis (`TwoWheelerModel.seatX`, `seatY`), a motorcyclist's helmet on
 * the posed head (`helmetShape`), and a stopped machine tilted onto the rider's foot by `tilt` (this body's own, `stopTiltFor`) about the line its
 * tyres stand on, the road flat under it; added to `scene`. The wheels are left out (`agents.ts` draws them as parts of their own). Returns the
 * point the picture centres on.
 */
function rideScene(scene: Scene, person: Object3D, root: Object3D, ride: RiderClipKey, helmet: Matrix4 | null, tilt: number): Vector3 {
  const moto = ride.startsWith('moto');
  const model = buildTwoWheelerModel(ARCHETYPES.find((a) => a.id === (moto ? 'motorcycle' : 'bicycle'))!);
  const pelvis = root.getObjectByName('Bip01_Pelvis')!.getWorldPosition(new Vector3());
  const road = pelvis.y - model.seatY;
  // The machine's frame (+X along it, +Z its right) turned into the rider's (+Z forward, +X left), its seat point under the pelvis.
  const machine = new Group();
  machine.rotation.y = -Math.PI / 2;
  machine.position.set(pelvis.x, road, pelvis.z - model.seatX);
  const paint = new MeshStandardMaterial({ color: 0x9a2a2a, roughness: 0.5 }), trim = new MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7 });
  machine.add(new Mesh(model.body, paint), new Mesh(model.trim, trim));
  const steering = new Mesh(model.steering, trim);
  steering.position.set(model.headX, model.headY, 0);
  // The bars turned as the steered poses hold them (`riderPoses.ts` gripPoint: about the upright through the steering head, left positive).
  steering.rotation.y = ride.endsWith('Left') ? STEER_FULL : ride.endsWith('Right') ? -STEER_FULL : 0;
  machine.add(steering);
  if (model.cranks) {
    const cranks = new Mesh(model.cranks, trim);
    cranks.position.set(model.bracketX, model.bracketY, 0);
    machine.add(cranks);
  }
  const tilted = new Group();
  tilted.add(machine, person);
  if (moto && helmet) {
    const head = root.getObjectByName('Bip01_Head')!;
    const shell = new Mesh(new SphereGeometry(0.5, 24, 16), new MeshStandardMaterial({ color: 0xf0f0ee, roughness: 0.25 }));
    shell.matrixAutoUpdate = false;
    shell.matrix.multiplyMatrices(head.matrixWorld, helmet);
    tilted.add(shell);
  }
  // Stopped: tilted onto the left foot about the tyres' line on the road (`agents.ts` frameAt, `TwoWheelerFit.stopTilt`).
  if (tilt !== 0) {
    const pivot = new Group();
    pivot.position.set(pelvis.x, road, 0);
    pivot.rotation.z = -tilt;
    tilted.position.set(-pelvis.x, -road, 0);
    pivot.add(tilted);
    scene.add(pivot);
  } else scene.add(tilted);
  const ground = new Mesh(new PlaneGeometry(6, 6), new MeshStandardMaterial({ color: 0x6b6e72, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(pelvis.x, road - 0.001, pelvis.z);
  scene.add(ground);
  return new Vector3(pelvis.x, road + 0.95, pelvis.z + 0.2);
}

/** Each view of `views` drawn with the game's reader, material and walk transfer: PNG data URLs in the same order. */
export async function personViews(binUrl: string, atlasUrl: string, views: readonly PersonView[]): Promise<string[]> {
  const binResponse = await fetch(binUrl);
  if (!binResponse.ok) throw new Error(`${binUrl}: ${binResponse.status}`);
  const { person } = decodeCookedPerson(await binResponse.arrayBuffer());
  const header = person.header;
  const atlasResponse = await fetch(atlasUrl);
  if (!atlasResponse.ok) throw new Error(`${atlasUrl}: ${atlasResponse.status}`);
  const atlas: Texture = await readKtx2(await atlasResponse.arrayBuffer(), header.atlas.codec, 'color');
  const root = assemblePerson(person);
  root.updateMatrixWorld(true);
  let source: SkinnedMesh | undefined;
  root.traverse((o) => { if ((o as SkinnedMesh).isSkinnedMesh && !source) source = o as SkinnedMesh; });
  if (!source) throw new Error(`${header.id}: no mesh`);
  const mesh = source;
  const sex = header.id.startsWith('female') ? 'female' : 'male';
  const walk = neutralWalkFor(root, mesh, sex);
  const clips = views.some((v) => v.pose.startsWith('idle:')) ? await loadRocketboxClips(sex) : undefined;
  const idle = clips ? clipTransferFor(root, mesh, clips.idle) : undefined;
  const levels = mesh.geometry.userData['levels'] as BufferAttribute[];
  const local = mesh.matrixWorld.clone();
  const palette = { uniform: { value: paletteOf(mesh) as Texture }, base: { value: 0 } };
  const materials = createPersonMaterials(atlas, header.mesh.alphaTest, palette, mesh);
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  const out: string[] = [];
  const restQ = new Map(mesh.skeleton.bones.map((b) => [b, b.quaternion.clone()]));
  const restP = new Map(mesh.skeleton.bones.map((b) => [b, b.position.clone()]));
  // A motorcyclist's helmet fitted to this head at rest, as the game fits it once (`citizenBake.ts` bake).
  const helmet = helmetShape(root);
  for (const view of views) {
    for (const [b, q] of restQ) { b.quaternion.copy(q); b.position.copy(restP.get(b)!); }
    root.updateMatrixWorld(true);
    const ride = view.pose.startsWith('ride:') ? view.pose.slice(5) as RiderClipKey : null;
    let tilt = 0;
    if (ride) {
      const clip = RIDER_CLIPS.find((c) => c.key === ride);
      if (!clip) throw new Error(`pose ${view.pose}`);
      // A stopped machine's tilt read off the body at rest, as the bake reads it (`citizenBake.ts`).
      if (ride === 'motoStop' || ride === 'bikeStop') tilt = stopTiltFor(root, ride === 'motoStop' ? MOTO_FIT : BIKE_FIT);
      clip.pose(root, 0);
    } else if (view.pose.startsWith('walk:')) walk.pose(Number(view.pose.slice(5)) * walkDuration(sex));
    else if (view.pose.startsWith('idle:')) {
      if (!idle) throw new Error('idle pose without the clips');
      idle.pose(Number(view.pose.slice(5)));
    } else if (view.pose !== 'bind') throw new Error(`pose ${view.pose}`);
    palette.uniform.value.dispose();
    palette.uniform.value = paletteOf(mesh);
    const index = levels[view.level];
    if (!index) throw new Error(`${header.id}: no level ${view.level}`);
    const geometry = new BufferGeometry();
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(index);
    geometry.boundingBox = mesh.geometry.boundingBox;
    geometry.boundingSphere = mesh.geometry.boundingSphere;
    if (view.face) {
      // The face's channels baked into the positions for this picture (the game's morphs are relative, in quantised units).
      const base = mesh.geometry.attributes['position'] as BufferAttribute;
      const moved = new Int16Array(base.array as Int16Array);
      const dictionary = mesh.morphTargetDictionary ?? {};
      const targets = mesh.geometry.morphAttributes['position'] ?? [];
      for (const [name, weight] of Object.entries(view.face)) {
        const k = dictionary[name];
        if (k === undefined) throw new Error(`${header.id}: no face channel ${name}`);
        const delta = targets[k]!.array as Int16Array;
        for (let i = 0; i < moved.length; i++) moved[i] = Math.max(-32767, Math.min(32767, Math.round(moved[i]! + delta[i]! * weight)));
      }
      geometry.setAttribute('position', new BufferAttribute(moved, 3, true));
    }
    const scene = new Scene();
    if (view.impostor) scene.add(new AmbientLight(0xffffff, 1));
    else {
      scene.add(new AmbientLight(0xffffff, 1.1));
      const sun = new DirectionalLight(0xffffff, 2.4);
      sun.position.set(2, 4, 5);
      scene.add(sun);
    }
    const person = figure(geometry, materials.lit, local);
    // The camera's centre from the posed skeleton: the head bone, or the body's middle.
    const centre = new Vector3(0, header.height / 2, 0);
    if (ride) centre.copy(rideScene(scene, person, root, ride, helmet, tilt));
    else scene.add(person);
    if (view.kind === 'head') root.traverse((o) => { if (o.name === 'Bip01_Head') { o.getWorldPosition(centre); centre.y += 0.06; } });
    const tall = view.metresTall ?? (view.kind === 'head' ? 0.42 : header.height * 1.08);
    renderer.setSize(view.width, view.height, false);
    renderer.setClearColor(new Color(RENDER_BACK), view.impostor ? 0 : 1);
    renderer.clear(true, true, true);
    renderer.render(scene, cameraAt(centre, tall, view.width / view.height, (view.yaw * Math.PI) / 180));
    out.push(canvas.toDataURL('image/png'));
  }
  renderer.dispose();
  atlas.dispose();
  return out;
}
