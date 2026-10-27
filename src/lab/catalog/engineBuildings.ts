import { Rng } from '@core/rng';
import { BLUEPRINTS, instantiate, type BlueprintBody } from '@world/buildings/blueprints';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { madeToMeasure } from '@world/buildings/procedural';
import { buildingHeight } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { CELL } from '@world/cells';
import { PART_KINDS, type PartKind, createBuildingKit } from '../../render/buildings/kit';
import { assembleBuildingMeshes, buildBuildingMeshes, emitProgram, kitBoxes, massShells } from '../../render/buildings/buildingMesh';
import { CELL_DETAIL, PLATE_DETAIL, TILE_DETAIL, massFloor } from '../../render/buildings/massing';
import { cellArrays, cellMass } from '../../render/buildings/cellArrays';
import { cellMesh } from '../../render/buildings/massCells';
import { FarPartBatch } from '../../render/buildings/farParts';
import { PartCell } from '../../render/buildings/partCells';
import { DETAIL_CELL, fileParts } from '../../render/buildings/partFiling';
import { COARSE_PARTS, DETAIL_PARTS } from '../../render/buildings/layerCells';
import { SHELL_PARTS } from '../../render/buildings/shellParts';
import { Group, type Material } from 'three';
import type { BatchCache } from './capture';
import { piecesOf, shown } from './layout';
import type { ItemSpec } from './items';

/** THE BUILDINGS AS THE ENGINE'S OWN GENERATORS MAKE THEM, no city: every preset (`blueprints.ts`), every building of a function (`cityBuildings.ts`),
 *  and the made-to-measure buildings of every use and density (`procedural.ts` madeToMeasure) on three lots, small, medium and large; each built by
 *  the building builder (`buildingMesh.ts` buildBuildingMeshes) with every part (windows, balconies, railings, units, pots...), drawn with each part
 *  where its pose puts it. Their cut-open interiors and their editor ghost alongside. */

type Add = (spec: ItemSpec) => void;

/** The lots the made-to-measure buildings are made for: width and depth, metres. */
const LOTS = [['small', m(12), m(16)], ['medium', m(24), m(26)], ['large', m(40), m(36)]] as const;
const USES = ['residential', 'commercial', 'industrial'] as const;
const DENSITIES = ['low', 'medium', 'high'] as const;

/** A building's floors: its height over its storey. */
const floorsOf = (b: Building): number => Math.max(1, Math.round(buildingHeight(b) / Math.max(0.5, b.storeyHeight)));

/** The far levels of every building the generators make, each drawn from ONE walk of the building (`buildingMesh.ts` emitProgram), as the
 *  building layer's cells draw them: its facade from afar (L1, the bays laid as runs, the program's `far`), its masses at the cell's, the tile's
 *  and the plate's detail (`buildingMesh.ts` massShells over the program, packed as the GPU takes them by `cellArrays.ts` cellMass, drawn by
 *  `massCells.ts` cellMesh); the base is the plate's level laid cell by cell (`massBase.ts`), no form of its own. */
export async function engineBuildingFarItems(add: Add): Promise<void> {
  const kit = createBuildingKit(16);
  const cache: BatchCache = new Map();
  const ground = (): number => 0;
  // The tower's facade cell through the town's far batch, made with the kit as the layer makes it (`layer.ts`): before the small props' simplified levels are in.
  const batched = FAR_BATCH_SEEN_FROM.map((away) => ({ away, ...farBatchOf(kit, ground) }));
  let id = 1;
  const one = (group: string, name: string, variation: string, body: BlueprintBody, key?: string): void => {
    const b = { ...instantiate(body, { x: 0, y: 0 }, 0, key), id: id++ as BuildingId } as Building;
    const label = `${name} (${variation})`;
    // ONE walk of the building (`emitProgram`): its facade level, its masses at each level and its base all drawn from that program.
    const program = emitProgram(b, ground, undefined, ground, { near: false, far: true }, { floor: massFloor(b, ground) ?? null });
    const facade = assembleBuildingMeshes([program.far!], kit);
    add({ group: 'Buildings: far facade (L1)', name: label, variation: group, origin: 'kit', source: 'src/render/buildings/buildingMesh.ts (emitProgram far, assembleBuildingMeshes)', build: 'merged',
      pieces: piecesOf(facade.group), object: shown(facade.group, cache), countKey: `building-l1:${label}`,
      notes: ['the bays laid as runs, their windows drawn by the facade shader (facadeLevel.ts); what is set into an opening left to the shader'] });
    for (const [level, detail] of [['cell', CELL_DETAIL], ['tile', TILE_DETAIL], ['plate', PLATE_DETAIL]] as const) {
      const chunk = massShells(program, detail);
      const mass = chunk ? cellMass([chunk]) : null;
      if (!mass) continue;
      const mesh = cellMesh(mass, kit);
      add({ group: `Buildings: masses (${level} level)`, name: label, variation: group, origin: 'kit', source: 'src/render/buildings/buildingMesh.ts (massShells over the program) + massCells.ts (cellMesh)', build: 'merged',
        pieces: [{ label: 'masses', geometry: mesh.geometry, material: (mesh.material as Material[])[0]! }], object: shown(mesh, cache), countKey: `building-mass-${level}:${label}`,
        notes: [`left out or laid flat at this level: up to ${detail.drop} m${detail.boxes ? ', pitched roofs as boxes' : ''}; the walls the facade level's runs of bays, drawn by its shader`] });
    }
  };
  for (const bp of BLUEPRINTS) one('preset', bp.key, 'preset', bp.body, bp.key);
  for (const cb of CITY_BUILDINGS) one('function', cb.fn, cb.category, cb.body);
  for (const use of USES) {
    for (const density of DENSITIES) {
      for (const [size, W, D] of LOTS) {
        const made = madeToMeasure(use, density, { W, D }, new Rng(1));
        one('made to measure', `${use} ${density}`, `${size} lot ${W} x ${D} m (${made.fn})`, made.body);
      }
    }
  }
  // Seen once the kit's levels are in: each kind at the level its error on the screen allows from there (`farParts.ts` view), as the layer's
  // cull has the batch choose (`layer.ts` cullDetails).
  await kit.levelsReady;
  for (const { away, group, batch, cell, label } of batched) {
    batch.view(-away, CELL / 2, FAR_BATCH_EYE_Z, FAR_BATCH_PX_AT_METRE, null);
    add({ group: 'Buildings: far facade (L1) as the far batch draws it', name: label, variation: `made to measure, seen from ${away} m`, origin: 'kit',
      source: 'src/render/buildings/farParts.ts (FarPartBatch over the cell job\'s filing) + buildingMesh.ts (emitProgram far, assembleBuildingMeshes)', build: 'instanced',
      pieces: piecesOf(group), object: shown(group, cache), countKey: `building-l1-batch:${label}`,
      notes: [`the facade cell as the town draws it from ${away} m (35° view, 1080 lines): its shell, panes and shell parts (those at their finest), every other part kind from the town's far batch at the level it is drawn at from there (${batch.trianglesOf(cell)} triangles of the batch)`] });
  }
}

/** The distances the far batch's tower is seen from (m, its cell's side on the plan): the facade level's near reach and twice it. */
const FAR_BATCH_SEEN_FROM = [m(300), m(600)] as const;
/** The eye's height over the ground, m. */
const FAR_BATCH_EYE_Z = m(50);
/** A metre's pixels at a metre's distance: 1080 lines under a 35° view (the sheets' own measure, `optimization/sheet.ts`). */
const FAR_BATCH_PX_AT_METRE = 1080 / (2 * Math.tan((35 * Math.PI) / 360));

/** THE TOWER'S FACADE CELL AS THE TOWN DRAWS IT FROM AFAR: its far program's detail parts filed as its cell's job files them (`cellWork.ts`
 *  runCellJob: by sub-cell, `fileParts`), the kinds the facade shader does not draw put in the town's far batch (`farParts.ts`, as `layer.ts`
 *  cullDetails syncs it), its shell, panes and shell parts beside them. The study's tower: the made-to-measure high residential building on the
 *  large lot, 25 floors. */
function farBatchOf(kit: ReturnType<typeof createBuildingKit>, ground: () => number): { readonly group: Group; readonly batch: FarPartBatch; readonly cell: string; readonly label: string } {
  const [size, W, D] = LOTS[2];
  const made = madeToMeasure('residential', 'high', { W, D }, new Rng(1));
  const b = { ...instantiate(made.body, { x: 0, y: 0 }, 0), id: 1 as BuildingId } as Building;
  const label = `residential high (${size} lot ${W} x ${D} m (${made.fn}), ${floorsOf(b)} floors)`;
  const cell = `${Math.floor(b.x / CELL)},${Math.floor(b.y / CELL)}`;
  const far = emitProgram(b, ground, undefined, ground, { near: false, far: true }, { floor: massFloor(b, ground) ?? null }).far!;
  const boxes = kitBoxes(kit);
  const detail = cellArrays([far], { parts: PART_KINDS.filter((k) => DETAIL_PARTS.has(k)), shells: false, furniture: false, ghost: false, dim: false }, boxes);
  const filing = fileParts(cell, [[`${Math.floor(b.x / DETAIL_CELL)},${Math.floor(b.y / DETAIL_CELL)}`, detail]], boxes.bandings!);
  const batch = new FarPartBatch(kit);
  // The cell as the layer holds it (`cellRequests.ts` land): its shell's parts its own, its whole filing read by the batch.
  const parts = new PartCell(cell, { bands: filing.bands.filter((band) => SHELL_PARTS.has(band.kind)) }, kit, filing);
  batch.sync(new Map([[cell, parts]]), () => true);
  // The shell with its panes and furniture (`cellWork.ts` COARSE) and the shell's parts, as they are made beside the batch.
  const facade = assembleBuildingMeshes([far], kit, false, false, { parts: new Set<PartKind>([...COARSE_PARTS, ...SHELL_PARTS]), shells: true, furniture: true });
  const group = new Group();
  group.name = 'building-far-batch';
  group.add(facade.group, batch.group);
  return { group, batch, cell, label };
}

/** Every building the generators make, each built alone. */
export function engineBuildingItems(add: Add): void {
  const kit = createBuildingKit(16);
  const cache: BatchCache = new Map();
  let id = 1;
  let interiors = 0;
  const one = (group: string, name: string, variation: string, source: string, body: BlueprintBody, key?: string): void => {
    const b = { ...instantiate(body, { x: 0, y: 0 }, 0, key), id: id++ as BuildingId } as Building;
    const built = buildBuildingMeshes([b], () => 0, kit);
    const floors = floorsOf(b);
    add({ group, name, variation: `${variation} (${floors} floors)`, origin: 'kit', source, build: 'merged', floors,
      pieces: piecesOf(built.group), object: shown(built.group, cache), countKey: `building:${group}:${name}:${variation}`,
      notes: ['built alone at its detail level (L0) by buildBuildingMeshes, every part with it; its far levels (facade L1, masses) are the building layer\'s cells'] });
    // The Construction tool's cut-open view and the editor's ghost, of one building of each kind of generator.
    if (interiors < 3 && floors >= 3) {
      interiors++;
      const cut = buildBuildingMeshes([{ ...b, cutaway: 1 }], () => 0, kit);
      add({ group: 'Buildings: interiors (cut open)', name, variation: `${floors} floors, cut above level 1`, origin: 'editor preview', preview: true,
        source: 'src/render/buildings/buildingMesh.ts (cutaway)', build: 'merged', pieces: piecesOf(cut.group), object: shown(cut.group, cache),
        notes: ['the Construction tool\'s cut-open view: walls, floors and furniture of the cut level'] });
      const ghost = buildBuildingMeshes([b], () => 0, kit, true);
      add({ group: 'Editor previews', name: 'building ghost', variation: name, origin: 'editor preview', preview: true, source: 'src/render/buildings/buildingMesh.ts (ghost)',
        build: 'merged', pieces: piecesOf(ghost.group), object: shown(ghost.group, cache) });
    }
  };
  for (const bp of BLUEPRINTS) one('Buildings: presets', bp.key, 'preset', 'src/world/buildings/blueprints.ts (BLUEPRINTS, instantiate)', bp.body, bp.key);
  for (const cb of CITY_BUILDINGS) one('Buildings: functions', cb.fn, cb.category, 'src/world/buildings/cityBuildings.ts (CITY_BUILDINGS)', cb.body);
  for (const use of USES) {
    for (const density of DENSITIES) {
      for (const [size, W, D] of LOTS) {
        const made = madeToMeasure(use, density, { W, D }, new Rng(1));
        one('Buildings: made to measure', `${use} ${density}`, `${size} lot ${W} x ${D} m (${made.fn})`, 'src/world/buildings/procedural.ts (madeToMeasure)', made.body);
      }
    }
  }
}
