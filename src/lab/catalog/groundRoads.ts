import { BufferAttribute, BufferGeometry, Group, Mesh, type Material } from 'three';
import { cellDiagonal } from '@world/groundPatch';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, type RoadElevation } from '@world/elevation';
import { ROAD_TYPES } from '@world/roadTypes';
import { m } from '@world/units';
import { createMaterials } from '../../render/materials';
import { createFlatAtlas } from '../../render/flatAtlas';
import { RoadFootprints } from '../../render/roadFootprints';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_SEGMENTS } from '../../render/terrainGrid';
import { LOD_PATCH } from '../../render/terrainLevels';
import { type JoinedSeams, joinSeams, plateSeams } from '../../render/terrainSeams';
import { sheetMaterial, type ItemSpec } from './items';
import { type BatchCache } from './capture';
import { piecesOf, shown, surfacesOf } from './layout';

/** THE GROUND ROUND A ROAD LAYOUT AS THE TERRAIN DRAWS IT NEAR THE EYE: the plate's cells of level 0 (`terrainLod.ts`, every corner of the
 *  plate's grid, `terrainGrid.ts`) over the layout and a margin, each corner shaped to the roads as `terrainShaping.ts` shapeCorners shapes
 *  it, each cell split along the diagonal the terrain draws it with (`groundPatch.ts` cellDiagonal) - but the cells the roads' outline cuts,
 *  drawn by their own mesh, cut along it (`terrainSeams.ts`), as the patches leave them out (`terrainLod.ts` uSeamCells); the roads the engine
 *  builds on it (`layout.ts` surfacesOf), whose footprints the ground is cut along. What the sheets show of the ground and of where the roads
 *  meet it, and count of its triangles. */

type Add = (spec: ItemSpec) => void;

const LEG = m(70);
/** How far past the layout's roads the ground is drawn. */
const MARGIN = m(40);
const N = TERRAIN_SEGMENTS + 1;

/** The layouts, as `layout.ts` lays them (the urban class). */
const LAYOUTS: readonly { readonly name: string; readonly variation: string; lay(doc: RoadDoc, type: number): void }[] = [
  { name: 'straight', variation: `${LEG * 2} m`, lay: (doc, t) => { doc.addSegment(doc.addNode({ x: -LEG, y: 0 }).id, doc.addNode({ x: LEG, y: 0 }).id, t); } },
  {
    name: 'junction', variation: 'four ways',
    lay: (doc, t) => {
      const centre = doc.addNode({ x: 0, y: 0 });
      for (const [x, y] of [[-LEG, 0], [LEG, 0], [0, LEG], [0, -LEG]] as const) doc.addSegment(doc.addNode({ x, y }).id, centre.id, t);
    },
  },
  {
    name: 'bend', variation: 'two roads at a right angle',
    lay: (doc, t) => {
      const centre = doc.addNode({ x: 0, y: 0 });
      for (const [x, y] of [[-LEG, 0], [0, LEG]] as const) doc.addSegment(doc.addNode({ x, y }).id, centre.id, t);
    },
  },
];

/** The plate's corners (the plate centred on the origin), shaped to the roads on level land (height 0, the ground the layout's roads were solved
 *  on) as `shapeCorners` blends them, and the diagonals the terrain draws its cells with. */
function shapedPlate(elevation: Pick<RoadElevation, 'shapeAt'>): { heights: Float64Array; flip: Uint8Array } {
  const heights = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const { height, weight } = elevation.shapeAt(i * TERRAIN_CELL - TERRAIN_HALF, TERRAIN_HALF - j * TERRAIN_CELL, 0);
      // `shapeCorners`' blend and its thresholds.
      const blended = weight <= 0.001 ? 0 : height * weight;
      heights[i + j * N] = Math.abs(blended) < 0.002 ? 0 : blended;
    }
  }
  const flip = new Uint8Array(TERRAIN_SEGMENTS * TERRAIN_SEGMENTS);
  for (let j = 0; j < TERRAIN_SEGMENTS; j++) {
    for (let i = 0; i < TERRAIN_SEGMENTS; i++) flip[i + j * TERRAIN_SEGMENTS] = cellDiagonal(heights[i + j * N]!, heights[i + (j + 1) * N]!, heights[i + 1 + (j + 1) * N]!, heights[i + 1 + j * N]!);
  }
  return { heights, flip };
}

/** The plate's whole cells over [x0, x1] x [y0, y1] (`cut` left out: their own mesh draws them), as level 0 draws them; three's axes (x, height, -y). */
function groundCells(plate: { heights: Float64Array; flip: Uint8Array }, cut: ReadonlySet<number>, x0: number, y0: number, x1: number, y1: number): BufferGeometry {
  const i0 = Math.floor((x0 + TERRAIN_HALF) / TERRAIN_CELL), i1 = Math.ceil((x1 + TERRAIN_HALF) / TERRAIN_CELL);
  const j0 = Math.floor((TERRAIN_HALF - y1) / TERRAIN_CELL), j1 = Math.ceil((TERRAIN_HALF - y0) / TERRAIN_CELL);
  const positions: number[] = [];
  const corner = (i: number, j: number): void => {
    positions.push(i * TERRAIN_CELL - TERRAIN_HALF, plate.heights[i + j * N]!, -(TERRAIN_HALF - j * TERRAIN_CELL));
  };
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      if (cut.has(i + j * TERRAIN_SEGMENTS)) continue;
      // Corners a (i, j), b (i, j + 1), c (i + 1, j + 1), d (i + 1, j) as the terrain names them; its triangles (a, b, c) and (a, c, d) along
      // the a-c diagonal, else (b, c, d) and (b, d, a) (`terrainLod.ts` landVertex).
      const at = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]] as const;
      const order = plate.flip[i + j * TERRAIN_SEGMENTS] ? [0, 1, 2, 0, 2, 3] : [1, 2, 3, 1, 3, 0];
      for (const k of order) corner(at[k]![0], at[k]![1]);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** The cut cells' mesh as level 0 draws it, unmorphed (`terrainLod.ts` seamVertex: a corner at its grid height, an edge's point at its own). */
function seamGeometry(joined: JoinedSeams): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(joined.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(joined.normals, 3));
  geometry.setIndex(new BufferAttribute(joined.index, 1));
  return geometry;
}

/** The ground round each urban layout and its roads, each one object. */
export async function groundRoadItems(add: Add): Promise<void> {
  const materials = createMaterials(16);
  const terrain = createFlatAtlas(16);
  const cache: BatchCache = new Map();
  const type = ROAD_TYPES.findIndex((t) => t.id === 'urban');
  for (const layout of LAYOUTS) {
    const doc = new RoadDoc();
    layout.lay(doc, type);
    const net = new Network(doc);
    net.rebuild();
    const footprints = new RoadFootprints();
    const roads = await surfacesOf(net, materials, terrain.vergeMaterial, footprints);
    const elevation = buildRoadElevation(net, () => 0);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    // @rebuild Walks the whole map: the lab's sheet, never the game's frame.
    for (const n of doc.nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const plate = shapedPlate(elevation);
    // The terrain cut along the roads' footprints, as the plate is (`terrain.ts` setSeams): the plate centred on the origin, so its frame is the world's.
    const seams = joinSeams(plateSeams({ n: N, cell: TERRAIN_CELL, half: TERRAIN_HALF, corner: (i) => plate.heights[i]!, diagonal: (c) => plate.flip[c]! },
      { hard: footprints.meeting([-TERRAIN_HALF, -TERRAIN_HALF, TERRAIN_HALF, TERRAIN_HALF]), soft: [] }, LOD_PATCH), { n: N, cell: TERRAIN_CELL, half: TERRAIN_HALF });
    const cells = groundCells(plate, new Set(seams.cells), x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN);
    const cut = seamGeometry(seams);
    const ground = new Mesh(cells, sheetMaterial(terrain.meshMaterial as Material, cells));
    ground.name = 'ground';
    const seamMesh = new Mesh(cut, sheetMaterial(terrain.meshMaterial as Material, cut));
    seamMesh.name = 'ground cut along the roads';
    const object = new Group();
    object.add(ground, seamMesh, shown(roads, cache));
    add({
      group: 'Ground round roads', name: `urban ${layout.name}`, variation: layout.variation, origin: 'kit',
      source: 'src/lab/catalog/groundRoads.ts (groundCells: the terrain\'s level 0) + src/render/terrainSeams.ts (plateSeams) + src/render/roadSurfaces.ts (roadSurfaceSteps)', build: 'merged',
      pieces: [{ label: 'ground', geometry: cells, material: terrain.meshMaterial }, { label: 'ground cut', geometry: cut, material: terrain.meshMaterial }, ...piecesOf(roads)],
      object, countKey: `ground-roads:${layout.name}`,
      notes: [`the ground as the terrain draws it at level 0 near the eye (cells of ${TERRAIN_CELL} m), shaped to the roads on level land; the ${seams.cells.length} cells the roads' outline cuts drawn cut along it (terrainSeams.ts); the roads as the engine builds them on it`],
    });
  }
}
