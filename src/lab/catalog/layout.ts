import { BufferAttribute, BufferGeometry as BufferGeometryClass, Group, InstancedMesh, LineSegments, Mesh, Points, type BufferGeometry, type Material, type Object3D } from 'three';
import { PLATE_SIZE } from '@world/bounds';
import { LandLod } from '../../render/terrainLod';
import { LandLevels, LOD_PATCH } from '../../render/terrainLevels';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_SEGMENTS } from '../../render/terrainGrid';
import { slabGeometry, TERRAIN_BASE, wallMaterial } from '../../render/terrain';
import { createFlatFar, farIndexInto, writeFarPatch } from '../../render/flatAtlas';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { ROAD_TYPES, type SegmentDirection } from '@world/roadTypes';
import type { NodeId, SegmentId } from '@world/ids';
import type { RoadStructure } from '@world/structures';
import { m } from '@world/units';
import { createMaterials, type SceneMaterials } from '../../render/materials';
import { roadSurfaceSteps, type SurfaceReuse } from '../../render/roadSurfaces';
import type { RoadFootprints } from '../../render/roadFootprints';
import { SurfaceInputs } from '../../render/roadSurfaceInputs';
import { buildStructureDetails } from '../../render/structures';
import { buildUtilities } from '../../render/poleLayer';
import { poleGroundAt } from '../../render/utilities';
import { createSceneryKit } from '../../render/scenery';
import { createFlatAtlas } from '../../render/flatAtlas';
import { levelsOf } from '../../render/mesh/roadLod';
import { coarseArrays } from '../../render/mesh/roadLodPure';
import type { RoadTiler } from '../../render/roadTilePool';
import { farLevelMeshes } from '../../render/networkFarRoads';
import { CELL } from '../../render/roadSurfaceEntries';
import { take, type BatchCache } from './capture';
import { sheetMaterial, type ItemSpec, type PieceSpec } from './items';

/** WHAT THE ROADS' LAYOUT MAKES, BUILT BY THE ENGINE'S OWN BUILDERS ON A LAYOUT MADE HERE, no city: each class of road and each variation
 *  (straight, bend, junctions of three and four ways, one way, raised, bridge, tunnel) its own small document, as the renderer builds its
 *  warm-up roads (`renderer.ts` warmRoadShaders): the surfaces with their far levels (`roadSurfaces.ts`), the structures (`structures.ts`),
 *  the poles and wires (`poleLayer.ts`), and the ground (`flatAtlas.ts`). */

type Add = (spec: ItemSpec) => void;

/** A built object's meshes as pieces: each block's far level as its level (`mesh/roadLod.ts`), an instanced mesh's copies counted. */
export function piecesOf(root: Object3D): PieceSpec[] {
  const far = new Set<Object3D>();
  root.traverse((o) => { const coarse = (o as Mesh).isMesh ? levelsOf(o as Mesh)?.coarse : undefined; if (coarse) far.add(coarse); });
  const out: PieceSpec[] = [];
  root.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; material?: Material | Material[]; isInstancedMesh?: boolean; count?: number };
    if (!holder.geometry || far.has(o)) return;
    const copies = holder.isInstancedMesh ? holder.count ?? 0 : 1;
    if (copies === 0) return;
    const coarse = (o as Mesh).isMesh ? levelsOf(o as Mesh)?.coarse : undefined;
    out.push({ label: o.name || o.type, geometry: holder.geometry, material: holder.material ?? null, copies, ...(coarse ? { levels: [coarse.geometry] } : {}) });
  });
  return out;
}

/** The object as a sheet and a 3D file show it: every copy where the engine put it (its poses made matrices, `capture.ts`), in a material drawn without the engine's uniforms. */
export function shown(root: Object3D, cache: BatchCache): Object3D {
  const out = new Group();
  out.name = root.name;
  root.updateMatrixWorld(true);
  const far = new Set<Object3D>();
  root.traverse((o) => { const coarse = (o as Mesh).isMesh ? levelsOf(o as Mesh)?.coarse : undefined; if (coarse) far.add(coarse); });
  root.traverse((o) => {
    if (far.has(o)) return;
    for (const t of take(o, cache)) {
      const material = sheetMaterial([t.material as Material | Material[]].flat()[0] ?? null, t.geometry);
      const copies = t.matrices.length / 16;
      if (t.type === 'mesh' && copies > 1) {
        const mesh = new InstancedMesh(t.geometry, material, copies);
        (mesh.instanceMatrix.array as Float32Array).set(t.matrices);
        mesh.name = t.name;
        out.add(mesh);
        continue;
      }
      for (let i = 0; i < copies; i++) {
        const mesh = t.type === 'points' ? new Points(t.geometry, material) : t.type === 'lines' ? new LineSegments(t.geometry, material) : new Mesh(t.geometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.fromArray(t.matrices, i * 16);
        mesh.name = t.name;
        out.add(mesh);
      }
    }
  });
  return out;
}

/** One layout: its document, its roads put down by `lay`. */
interface Layout { readonly name: string; readonly variation: string; lay(doc: RoadDoc, type: number): void }

const LEG = m(70);

/** A road of `type` from (x0, y0) to (x1, y1). */
function road(doc: RoadDoc, type: number, x0: number, y0: number, x1: number, y1: number, structure: RoadStructure = 'ground', direction: SegmentDirection = 'both'): void {
  doc.addSegment(doc.addNode({ x: x0, y: y0 }).id, doc.addNode({ x: x1, y: y1 }).id, type, null, 0, direction, null, structure);
}

/** Roads of `type` from the centre out to each of `ends`, meeting there; the centre's id. */
function meeting(doc: RoadDoc, type: number, ends: readonly (readonly [number, number])[]): NodeId {
  const centre = doc.addNode({ x: 0, y: 0 });
  for (const [x, y] of ends) doc.addSegment(doc.addNode({ x, y }).id, centre.id, type);
  return centre.id;
}

/** Two roads end to end through the origin, the first of `a`, the second of `b`; the node between them. */
function through(doc: RoadDoc, a: number, b: number): { readonly node: NodeId; readonly first: SegmentId } {
  const mid = doc.addNode({ x: 0, y: 0 });
  const first = doc.addSegment(doc.addNode({ x: -LEG, y: 0 }).id, mid.id, a)!;
  doc.addSegment(mid.id, doc.addNode({ x: LEG, y: 0 }).id, b);
  return { node: mid.id, first: first.id };
}

const LAYOUTS: readonly Layout[] = [
  { name: 'straight', variation: `${LEG * 2} m`, lay: (doc, t) => road(doc, t, -LEG, 0, LEG, 0) },
  { name: 'one way', variation: `${LEG * 2} m`, lay: (doc, t) => road(doc, t, -LEG, 0, LEG, 0, 'ground', 'aToB') },
  { name: 'bend', variation: 'two roads at a right angle', lay: (doc, t) => meeting(doc, t, [[-LEG, 0], [0, LEG]]) },
  { name: 'junction', variation: 'three ways', lay: (doc, t) => meeting(doc, t, [[-LEG, 0], [LEG, 0], [0, LEG]]) },
  { name: 'junction', variation: 'four ways', lay: (doc, t) => meeting(doc, t, [[-LEG, 0], [LEG, 0], [0, LEG], [0, -LEG]]) },
  // Two corners of 45 degrees and two of 135: the kerb returns' stations at the sweeps a grid's right angles never have (`roads/junctionPiece.ts`).
  // A through road and a branch leaning off its square (the owner's road tool's angled T): a straight corner, and returns of 110 and 70 degrees.
  { name: 'junction', variation: 'three ways, the third at 70 degrees', lay: (doc, t) => meeting(doc, t, [[LEG, 0], [-LEG, 0], [LEG * Math.cos((70 * Math.PI) / 180), LEG * Math.sin((70 * Math.PI) / 180)]]) },
  { name: 'junction', variation: 'four ways crossed at 45 degrees', lay: (doc, t) => meeting(doc, t, [[-LEG, 0], [LEG, 0], [LEG * Math.SQRT1_2, LEG * Math.SQRT1_2], [-LEG * Math.SQRT1_2, -LEG * Math.SQRT1_2]]) },
  { name: 'raised', variation: `${LEG * 2} m elevated`, lay: (doc, t) => road(doc, t, -LEG, 0, LEG, 0, 'elevated') },
  { name: 'bridge', variation: `${LEG * 2} m`, lay: (doc, t) => road(doc, t, -LEG, 0, LEG, 0, 'bridge') },
  { name: 'tunnel', variation: `${LEG * 2} m`, lay: (doc, t) => road(doc, t, -LEG, 0, LEG, 0, 'tunnel') },
  // Its kerbs' parking and cycle lane, and their paint (`parkingLayout.ts`): no default class parks.
  // The rest of the paint the city lays (`world/markings.ts`): a junction's rules (a stop, a mini-roundabout's island), a crossing between junctions and
  // the taper where a road carries on at another class's width.
  { name: 'junction', variation: 'four ways, stop', lay: (doc, t) => doc.setNodeControl(meeting(doc, t, [[-LEG, 0], [LEG, 0], [0, LEG], [0, -LEG]]), 'stop') },
  { name: 'junction', variation: 'four ways, mini-roundabout', lay: (doc, t) => doc.setNodeControl(meeting(doc, t, [[-LEG, 0], [LEG, 0], [0, LEG], [0, -LEG]]), 'mini') },
  { name: 'crossing', variation: 'a zebra mid-block', lay: (doc, t) => { const { node, first } = through(doc, t, t); doc.setNodeCrossing(node, 'zebra', first); } },
  { name: 'taper', variation: 'to the next class', lay: (doc, t) => { through(doc, t, (t + 1) % ROAD_TYPES.length); } },
  {
    name: 'parking', variation: `${LEG * 2} m, parallel bays left, a cycle lane right`,
    lay: (doc, t) => doc.addSegment(doc.addNode({ x: -LEG, y: 0 }).id, doc.addNode({ x: LEG, y: 0 }).id, t, null, 0, 'both', null, 'ground', undefined, { left: 'parallel', right: 'cycle' }),
  },
];

/** The roads of a document as the engine builds them: the surfaces in steps with each block's far level made as the road workers make it (`roadTile.worker.ts`, here on the page);
 *  `footprints`, given, holds what they draw over the ground once they are put in place (`roadFootprints.ts`). */
export async function surfacesOf(net: Network, materials: SceneMaterials, groundMaterial: Material, footprints?: RoadFootprints,
  flat: (x: number, y: number) => number = () => 0): Promise<Group> {
  const elevation = buildRoadElevation(net, flat);
  const tiler: RoadTiler = {
    tiles: () => Promise.reject(new Error('the tiles are built on the page')),
    check: () => {},
    coarsen: (arrays, lock) => Promise.resolve(coarseArrays(structuredClone(arrays), lock)),
  };
  const reuse = { tiles: new Map(), dependsOn: () => 0, chunks: new Map(), inputs: new SurfaceInputs(), near: () => true, ...(footprints ? { footprints } : {}) } as unknown as SurfaceReuse;
  const steps = roadSurfaceSteps(net, elevation, materials, flat, reuse, tiler);
  for (;;) {
    const step = steps.next();
    if (step.done) { step.value.adopt(); break; }
    if (step.value === 'wait') await new Promise((done) => setTimeout(done, 0));
  }
  const group = new Group();
  group.name = 'roads';
  for (const { mesh } of reuse.chunks.values()) {
    group.add(mesh);
    const coarse = levelsOf(mesh)?.coarse;
    if (coarse) group.add(coarse);
  }
  const details = buildStructureDetails(net, elevation, flat, materials, groundMaterial);
  group.add(details.group);
  return group;
}

/** Every class of road in every layout, the poles and wires, and the ground: each built alone by the engine. */
export async function layoutItems(add: Add): Promise<void> {
  const materials = createMaterials(16);
  const terrain = createFlatAtlas(16);
  const cache: BatchCache = new Map();
  for (const layout of LAYOUTS) {
    for (let t = 0; t < ROAD_TYPES.length; t++) {
      const doc = new RoadDoc();
      layout.lay(doc, t);
      const net = new Network(doc);
      net.rebuild();
      const built = await surfacesOf(net, materials, terrain.vergeMaterial);
      add({
        group: 'Roads', name: `${ROAD_TYPES[t]!.id} ${layout.name}`, variation: layout.variation, origin: 'kit',
        source: 'src/render/roadSurfaces.ts (roadSurfaceSteps) + src/render/structures.ts (buildStructureDetails)', build: 'merged',
        pieces: piecesOf(built), object: shown(built, cache), countKey: `road:${ROAD_TYPES[t]!.id}:${layout.name}`,
        notes: ['built by the engine on a layout of its own (no city): each surface a block, its far level made as the road workers make it (coarseArrays)'],
      });
    }
  }
  await junctionLevelItems(add, materials, terrain.vergeMaterial, cache);
  // Poles and their wires: a span with a lamp at one end, as the renderer's warm-up puts them (`renderer.ts` warmRoadShaders).
  const doc = new RoadDoc();
  road(doc, 0, -LEG, 0, LEG, 0);
  const a = doc.addPole({ x: m(-15), y: m(12) }, true), b = doc.addPole({ x: m(15), y: m(12) }, false);
  doc.addPoleSpan(a.id, b.id);
  const net = new Network(doc);
  net.rebuild();
  const flat = (): number => 0;
  const poles = buildUtilities(net, poleGroundAt(buildRoadElevation(net, flat), flat), createSceneryKit());
  add({ group: 'Utility poles', name: 'pole span', variation: 'two poles (one with a lamp), their wires', origin: 'kit', source: 'src/render/poleLayer.ts (buildUtilities)', build: 'instanced',
    pieces: piecesOf(poles.group), object: shown(poles.group, cache), countKey: 'poles' });
}

/** Grounds off the flat a junction's levels are seen on (`junctionLevelItems`): a plane tilted 5 % east and 2 % north, and a ridge whose crown is
 *  the node (every road falling 5 % from it), so the plate folds along the bisectors between its legs. */
const GROUNDS: readonly { readonly variation: string; readonly at: (x: number, y: number) => number }[] = [
  { variation: 'four ways on a slope (5 % east, 2 % north)', at: (x, y) => 0.05 * x + 0.02 * y },
  { variation: 'four ways crowned (the node on a ridge, 5 % down every road)', at: (x, y) => -0.05 * Math.max(Math.abs(x), Math.abs(y)) },
];

/** The layouts whose levels are drawn each as an object of its own (`junctionLevelItems`), by name and variation. */
const LEVELLED: readonly (readonly [string, string])[] = [
  ['straight', `${LEG * 2} m`], ['bend', 'two roads at a right angle'], ['junction', 'three ways'], ['junction', 'four ways'], ['junction', 'four ways crossed at 45 degrees'],
  ['junction', 'three ways, the third at 70 degrees'],
];

/** A built layout's blocks' far levels alone (L1, `surfaceTiles.ts` attachFarLevel), each a mesh of its own on the far level's geometry. */
function farLevelsOf(built: Group): Group {
  const out = new Group();
  out.name = 'roads-far';
  built.traverse((o) => {
    const coarse = (o as Mesh).isMesh ? levelsOf(o as Mesh)?.coarse : undefined;
    if (!coarse) return;
    const copy = new Mesh(coarse.geometry, coarse.material);
    copy.name = coarse.name;
    out.add(copy);
  });
  return out;
}

/** A network's root level (L2, `networkFarRoads.ts`): the detail's own pieces a mesh a cell, drawn by the road material, at the heights the roads were solved at. */
function networkLevelOf(net: Network, ground: (x: number, y: number) => number, materials: SceneMaterials): Group {
  const out = new Group();
  out.name = 'road-far-network';
  for (const mesh of farLevelMeshes(net, buildRoadElevation(net, ground), ground, CELL, materials.roadRoot)) out.add(mesh);
  return out;
}

/**
 * The urban junctions' three levels each as an object, so a sheet draws and counts them apart: the detail (L0, as `layoutItems` makes it), the
 * blocks' far level (L1) and the network's far level (L2); the four ways also off the flat (`GROUNDS`), where the plate is not a plane.
 */
async function junctionLevelItems(add: Add, materials: SceneMaterials, groundMaterial: Material, cache: BatchCache): Promise<void> {
  const t = ROAD_TYPES.findIndex((type) => type.id === 'urban');
  if (t < 0) return;
  const id = ROAD_TYPES[t]!.id;
  const four = LAYOUTS.find((l) => l.variation === 'four ways')!;
  const cases = [
    ...LEVELLED.map(([name, variation]) => ({ layout: LAYOUTS.find((l) => l.name === name && l.variation === variation)!, variation, ground: (): number => 0, detail: false })),
    ...GROUNDS.map((g) => ({ layout: four, variation: g.variation, ground: g.at, detail: true })),
  ];
  const source = 'src/render/roadSurfaces.ts (roadSurfaceSteps) + src/render/networkFarPieces.ts (farPieceCells)';
  for (const { layout, variation, ground, detail } of cases) {
    const doc = new RoadDoc();
    layout.lay(doc, t);
    const net = new Network(doc);
    net.rebuild();
    const built = await surfacesOf(net, materials, groundMaterial, undefined, ground);
    const name = `${id} ${layout.name}`;
    if (detail) {
      add({ group: 'Roads', name, variation: `${variation} · L0`, origin: 'kit', source, build: 'merged', pieces: piecesOf(built), object: shown(built, cache),
        countKey: `road:${id}:${layout.name}:${variation}:L0`, notes: ['the detail, as the blocks draw it near'] });
    }
    const far = farLevelsOf(built);
    add({ group: 'Roads', name, variation: `${variation} · L1`, origin: 'kit', source, build: 'merged', pieces: piecesOf(far), object: shown(far, cache),
      countKey: `road:${id}:${layout.name}:${variation}:L1`, notes: ['the blocks\' far levels (attachFarLevel), as drawn past the near reach'] });
    const network = networkLevelOf(net, ground, materials);
    add({ group: 'Roads', name, variation: `${variation} · L2`, origin: 'kit', source, build: 'merged', pieces: piecesOf(network), object: shown(network, cache),
      countKey: `road:${id}:${layout.name}:${variation}:L2`, notes: ['the network\'s root level (farPieceCells), as drawn where a cell\'s blocks are not built'] });
  }
}

/** A near patch of the ground or its rim as the GPU places it on flat land (`terrainLod.ts` landVertex): a corner's cell and role made its point, a cell `cell` wide. */
function placedPatch(source: BufferGeometry, cell: number): BufferGeometry {
  const cells = source.getAttribute('position');
  const out = new BufferGeometryClass();
  const positions = new Float32Array(cells.count * 3);
  // Roles 0-3 are corners (0,0), (0,1), (1,1), (1,0) of the cell; on flat land the shader turns them by one (`flip` false). A rim's vertex: (k along the side, 0, 6 or 7 for its top or its bottom).
  const CORNER = [[0, 0], [0, 1], [1, 1], [1, 0]] as const;
  for (let v = 0; v < cells.count; v++) {
    const i = cells.getX(v), j = cells.getY(v), role = cells.getZ(v);
    if (role < 4) {
      const [di, dj] = CORNER[(role + 1) & 3]!;
      positions.set([(i + di) * cell, 0, (j + dj) * cell], v * 3);
    } else positions.set([i * cell, role === 7 ? -m(30) : 0, 0], v * 3);
  }
  out.setAttribute('position', new BufferAttribute(positions, 3));
  out.setIndex(source.index);
  out.computeVertexNormals();
  return out;
}

/** The ground as the engine draws it, each part built alone by its own code: a near patch and its rim (`terrainLod.ts`), a far patch (`flatAtlas.ts`), the slab round the map's edge. */
export function terrainItems(add: Add): void {
  const material = createFlatAtlas(16).meshMaterial;
  const lod = new LandLod(new LandLevels(TERRAIN_SEGMENTS), { seg: TERRAIN_SEGMENTS, cell: TERRAIN_CELL, half: TERRAIN_HALF }, { x: 0, y: 0 }, { west: true, east: true, north: true, south: true });
  const level = (geometry: BufferGeometry, name: string): Object3D => { const g = new Group(); g.add(new Mesh(placedPatch(geometry, TERRAIN_CELL), sheetMaterial(null, geometry))); g.name = name; return g; };
  add({ group: 'Terrain', name: 'near patch', variation: `${LOD_PATCH} x ${LOD_PATCH} cells (level 0: ${TERRAIN_CELL} m a cell, each level twice as wide)`, origin: 'kit',
    source: 'src/render/terrainLod.ts (LandLod, patchCells)', build: 'instanced', pieces: [{ label: 'patch', geometry: lod.geometry, material }],
    object: level(lod.geometry, 'near patch'), countKey: 'terrain:patches',
    notes: ['one instance a patch the camera needs (CDLOD, Strugar 2010), its corners read from the land texture in the vertex shader: the picture places them on flat land as the shader does'] });
  add({ group: 'Terrain', name: 'near patch rim', variation: 'one side, both ways round', origin: 'kit', source: 'src/render/terrainLod.ts (LandLod, patchRim)', build: 'instanced',
    pieces: [{ label: 'rim', geometry: lod.rimGeometry, material }], object: level(lod.rimGeometry, 'near patch rim'), countKey: 'terrain:rims',
    notes: ['one instance a side of a patch on a plate\'s edge that hangs a skirt (30 m down)'] });
  const far = createFlatFar(1);
  writeFarPatch(far, 0, 0, 0, () => 0);
  farIndexInto(far, [{ slot: 0, rim: [false, false, false, false] }]);
  const farMesh = new Mesh(far.geometry, sheetMaterial(material, far.geometry));
  farMesh.name = 'flat-world-far';
  add({ group: 'Terrain', name: 'far patch', variation: 'one plate, its four skirts', origin: 'kit', source: 'src/render/flatAtlas.ts (createFlatFar, writeFarPatch, farIndexInto)', build: 'merged',
    pieces: [{ label: 'far patch', geometry: far.geometry, material }], object: farMesh, countKey: 'terrain:far-patches' });
  const wall = wallMaterial(16);
  const slab = new Mesh(slabGeometry(-TERRAIN_HALF, TERRAIN_HALF, -TERRAIN_HALF, TERRAIN_HALF, PLATE_SIZE / 32, () => TERRAIN_BASE), sheetMaterial(wall, new BufferGeometryClass()));
  slab.name = 'flat-world-slab';
  add({ group: 'Terrain', name: 'edge slab', variation: 'round one plate', origin: 'kit', source: 'src/render/terrain.ts (slabGeometry)', build: 'individual',
    pieces: [{ label: 'slab', geometry: slab.geometry, material: wall }], object: slab, countKey: 'one',
    notes: ['the cut sides round the map\'s far ring, from the land down to the bedrock; in the game it runs round the whole map'] });
}
