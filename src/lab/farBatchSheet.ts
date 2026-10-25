import {
  Color, DirectionalLight, HemisphereLight, type InstancedMesh, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, SRGBColorSpace,
  Vector3, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Rng } from '@core/rng';
import { CELL } from '@world/cells';
import { instantiate } from '@world/buildings/blueprints';
import { madeToMeasure } from '@world/buildings/procedural';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { assembleBuildingMeshes, emitProgram, kitBoxes } from '../render/buildings/buildingMesh';
import { cellArrays } from '../render/buildings/cellArrays';
import { FarPartBatch } from '../render/buildings/farParts';
import { PART_KINDS, type PartKind, createBuildingKit } from '../render/buildings/kit';
import { COARSE_PARTS, DETAIL_PARTS } from '../render/buildings/layerCells';
import { massFloor } from '../render/buildings/massing';
import { PartCell } from '../render/buildings/partCells';
import { DETAIL_CELL, fileParts } from '../render/buildings/partFiling';
import { SHELL_PARTS } from '../render/buildings/shellParts';
import { takeWaitingPictures } from '../render/plantImpostors';

/**
 * THE FAR BATCH'S SHEETS (`scripts/far-batch-sheet.mjs`): the study's tower (the made-to-measure high residential building on the large lot,
 * 25 floors) as the town draws its facade cell from afar - its shell, panes and shell parts, and every other part kind from the town's far batch
 * (`farParts.ts`) - with the game's own materials, drawn at the screen's own size from the distances asked. The optimisation sheets cannot show it:
 * they draw each mesh with a plain material and frame the object (`catalog/items.ts` sheetMaterial), and a picture's quad would be a square.
 * Whatever checkout serves the page draws its own batch: the same sheet draws one commit's and another's.
 */

/** The screen: 1080 lines under a 35° view, 16:9 (the sheets' measure, `optimization/sheet.ts`). */
const WIDTH = 1920, HEIGHT = 1080, FOV = 35;
/** A metre's pixels at a metre's distance on it: what the layer hands the batch (`layer.ts` cullDetails), the device's own here. */
const PX_AT_METRE = HEIGHT / 2 / Math.tan((FOV * Math.PI) / 360);
/** The eye's height over the ground, and the tower's lot: the plan's (x, y) of its anchor. */
const EYE_Z = m(50);
const LOT = { x: m(60), y: m(60) };

/** One distance's frame: the picture, and what the batch says it draws of the cell and three counted. */
export interface FarBatchFrame {
  readonly distance: number;
  /** The frame, a PNG as a data URL. */
  readonly png: string;
  /** The tower's middle on the frame, pixels from the top left. */
  readonly centre: readonly [number, number];
  /** What the batch draws of the cell (`trianglesOf`), and three's count of the batch's draws and triangles in the frame. */
  readonly batchTriangles: number;
  readonly drawCalls: number;
  readonly triangles: number;
  /** Each mesh of the batch drawn in the frame: its name, instances and triangles an instance. */
  readonly meshes: readonly { readonly name: string; readonly count: number; readonly triangles: number }[];
}

/** The tower's facade cell drawn from each of `distances` (m, off its cell's side on the plan, `EYE_Z` up): one frame each, the batch chosen for
 *  it as the layer's cull chooses it (`view`), drawn twice (the second with the screen the first read, `look`) after its pictures are taken. */
export async function farBatchFrames(distances: readonly number[]): Promise<FarBatchFrame[]> {
  const kit = createBuildingKit(16);
  await kit.levelsReady;
  const ground = (): number => 0;
  const made = madeToMeasure('residential', 'high', { W: m(40), D: m(36) }, new Rng(1));
  const b = { ...instantiate(made.body, LOT, 0), id: 1 as BuildingId } as Building;
  const cell = `${Math.floor(b.x / CELL)},${Math.floor(b.y / CELL)}`;
  const far = emitProgram(b, ground, undefined, ground, { near: false, far: true }, { floor: massFloor(b, ground) ?? null }).far!;
  const boxes = kitBoxes(kit);
  const detail = cellArrays([far], { parts: PART_KINDS.filter((k) => DETAIL_PARTS.has(k)), shells: false, furniture: false, ghost: false, dim: false }, boxes);
  const filing = fileParts(cell, [[`${Math.floor(b.x / DETAIL_CELL)},${Math.floor(b.y / DETAIL_CELL)}`, detail]], boxes.bandings!);
  const batch = new FarPartBatch(kit);
  const parts = new PartCell(cell, { bands: filing.bands.filter((band) => SHELL_PARTS.has(band.kind)) }, kit, filing);
  batch.sync(new Map([[cell, parts]]), () => true);
  const facade = assembleBuildingMeshes([far], kit, false, false, { parts: new Set<PartKind>([...COARSE_PARTS, ...SHELL_PARTS]), shells: true, furniture: true });

  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  const scene = new Scene();
  scene.background = new Color(0xc9d6e0);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new HemisphereLight(0xdfe8f0, 0x8a8070, 1.2));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(-0.6, 1, 0.45);
  scene.add(sun);
  const floor = new Mesh(new PlaneGeometry(20_000, 20_000).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x9a9890, roughness: 0.95 }));
  floor.position.y = -0.05;
  scene.add(floor, facade.group, batch.group);

  // The tower's middle, three's world (the plan's y is -z).
  const middle = new Vector3(b.x + m(20), m(40), -(b.y + m(18)));
  const out: FarBatchFrame[] = [];
  for (const distance of distances) {
    const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.5, 100_000);
    camera.position.set(-distance, EYE_Z, -CELL / 2);
    camera.lookAt(middle);
    camera.updateMatrixWorld();
    // The pictures taken between draws, as the game takes them (`farForest.ts` update).
    takeWaitingPictures(renderer);
    batch.view(-distance, CELL / 2, EYE_Z, PX_AT_METRE, null);
    renderer.render(scene, camera);
    batch.view(-distance, CELL / 2, EYE_Z, PX_AT_METRE, null);
    takeWaitingPictures(renderer);
    // Three's count of the batch's draws alone, then the frame.
    const shown = new Map(scene.children.map((child) => [child, child.visible] as const));
    for (const child of scene.children) child.visible = child === batch.group;
    renderer.info.reset();
    renderer.info.autoReset = false;
    renderer.render(scene, camera);
    const drawCalls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
    renderer.info.autoReset = true;
    for (const [child, visible] of shown) child.visible = visible;
    renderer.render(scene, camera);
    const png = canvas.toDataURL('image/png');
    const at = middle.clone().project(camera);
    const meshes = batch.group.children.filter((child) => child.visible).map((child) => {
      const mesh = child as InstancedMesh;
      const g = mesh.geometry;
      return { name: child.name, count: mesh.count, triangles: (g.index ? g.index.count : g.getAttribute('position').count) / 3 };
    }).filter((mesh) => mesh.count > 0);
    out.push({
      distance, png, centre: [Math.round(((at.x + 1) / 2) * WIDTH), Math.round(((1 - at.y) / 2) * HEIGHT)],
      batchTriangles: batch.trianglesOf(cell), drawCalls, triangles, meshes,
    });
  }
  batch.dispose();
  parts.dispose();
  facade.dispose();
  pmrem.dispose();
  renderer.dispose();
  return out;
}
