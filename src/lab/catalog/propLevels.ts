import { BufferAttribute, BufferGeometry, type Material } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { BARRIER_KINDS } from '@world/barriers';
import { barrierModel } from '../../render/barriers';
import { PROP_PICTURES, sceneryPictures, type PlantImpostors } from '../../render/plantImpostors';
import { BUSH_KINDS, TREE_SPECIES } from '../../render/propGeometry';
import { createSceneryKit } from '../../render/scenery';
import { signalHeadModel } from '../../render/signals';
import { propLadder } from '../../render/streetFurnitureLayer';
import type { ItemSpec, PieceSpec } from './items';

/**
 * THE STREET PROPS' LEVELS, ONE ITEM A LEVEL (`scripts/optimization-sheet.mjs --only="street prop levels"`): every street prop, the traffic
 * signal's head, every barrier and every street tree and bush, each level it is drawn at its own item, so the sheet draws each one rendered and
 * as a wireframe. The levels as the street furniture draws them (`streetFurnitureLayer.ts` furnitureStores, `propLevels.ts`): level 0 its model
 * (from 48 px across), level 1 its simplified model (from 16 px; the model itself where simplifying sheds under a tenth), level 2 its picture's
 * card (`plantImpostors.ts`, two triangles facing the eye, from 1.5 px). The plants: their model, their picture's card from `PICTURE_PX`.
 * The same keys are made from the checkout before a change, with its own levels, so each level is measured against what it was.
 */

type Add = (spec: ItemSpec) => void;

const GROUP = 'Prop levels';
const LEVELS = ['level 0 (near)', 'level 1 (middle)', 'level 2 (far)'] as const;

/** A picture's card as the sheet can draw it: its four corners at the size and place its shader puts them (`plantImpostors.ts` vertexMain:
 *  `aSphere` centre and twice its radius), facing +z; its two triangles. */
function cardOf(set: PlantImpostors, at: number): BufferGeometry {
  const quad = set.quads[at]!;
  const sphere = quad.getAttribute('aSphere');
  const centre = [sphere.getX(0), sphere.getY(0), sphere.getZ(0)] as const, across = 2 * sphere.getW(0);
  const corners = quad.getAttribute('position');
  const position = new Float32Array(corners.count * 3);
  for (let v = 0; v < corners.count; v++) {
    position[v * 3] = centre[0] + corners.getX(v) * across;
    position[v * 3 + 1] = centre[1] + corners.getY(v) * across;
    position[v * 3 + 2] = centre[2];
  }
  const card = new BufferGeometry();
  card.setAttribute('position', new BufferAttribute(position, 3));
  card.setAttribute('normal', quad.getAttribute('normal'));
  card.setIndex(quad.index);
  return card;
}

export async function propLevelItems(add: Add): Promise<void> {
  const kit = createSceneryKit();
  const ladder = propLadder(kit);
  await MeshoptSimplifier.ready;
  const item = (name: string, level: number, pieces: PieceSpec[], notes: string[]): void =>
    add({ group: GROUP, name, variation: LEVELS[level]!, origin: 'kit', source: 'src/render/streetFurnitureLayer.ts (furnitureStores)', build: 'instanced', pieces, notes });
  const models: Record<(typeof PROP_PICTURES)[number], BufferGeometry> = { ...kit.furniture, treePit: kit.treePit };
  for (const prop of PROP_PICTURES) {
    const model = models[prop];
    const mid = ladder.mid[prop];
    mid.make();
    item(prop, 0, [{ label: prop, geometry: model, material: kit.props }], ['drawn from 48 px across']);
    item(prop, 1, [{ label: prop, geometry: mid.ready() ? mid.geometry : model, material: kit.props }],
      [mid.ready() ? 'its simplified model, drawn from 16 px across' : 'the model itself (simplifying shed under a tenth), drawn from 16 px across']);
    item(prop, 2, [{ label: prop, geometry: cardOf(ladder.pictures.set, ladder.pictures.at(prop)), material: null }],
      ['its picture on a card facing the eye (64 directions), drawn from 1.5 px across, nothing under it']);
  }
  // The lamp's lit parts: one level each, drawn at any size.
  const lit: [string, BufferGeometry, Material][] = [['lamp lens', kit.lampLens, kit.glow], ['lamp light pool', kit.pool, kit.poolGlow], ['lamp light beam', kit.beam, kit.beamGlow]];
  for (const [name, geometry, material] of lit) item(name, 0, [{ label: name, geometry, material }], ['one level, drawn at any size']);
  item('signal head', 0, [{ label: 'signal head (red lit)', geometry: signalHeadModel('red'), material: null }], ['one level (`signals.ts`), drawn at any size']);
  for (const kind of BARRIER_KINDS) item(`barrier ${kind}`, 0, [{ label: kind, geometry: barrierModel(kind, 4), material: null }], ['4 m run; one level (`barriers.ts`)']);
  const plants = sceneryPictures(kit);
  const plant = (name: string, body: BufferGeometry, bodyMaterial: Material, cards: BufferGeometry | undefined, cardMaterial: Material, at: number): void => {
    item(name, 0, [{ label: 'body', geometry: body, material: bodyMaterial }, ...(cards ? [{ label: 'foliage cards', geometry: cards, material: cardMaterial }] : [])], ['drawn from 48 px across (PICTURE_PX)']);
    item(name, 2, [{ label: 'picture card', geometry: cardOf(plants.set, at), material: null }], ['its picture on a card facing the eye, under 48 px across, thinned under 2 px']);
  };
  for (const s of TREE_SPECIES) plant(`street tree ${s}`, kit.trees[s], kit.foliage, kit.cards[s], kit.treeCards, plants.treeAt(s));
  for (const k of BUSH_KINDS) plant(`street bush ${k}`, kit.bushes[k], kit.shrubs, kit.cards[k], kit.shrubCards, plants.bushAt(k));
}
