import { Group, type Frustum, type Matrix4 } from 'three';
import type { Network } from '@world/network';
import type { RoadElevation } from '@world/elevation';
import { kindOf } from '../render/instanceRuns';
import { sceneryPictures } from '../render/plantImpostors';
import { createPropLayer, type PropLayer } from '../render/propCells';
import { SHADOW_REACH, type SceneryKit } from '../render/scenery';
import { furnitureAbout, furnitureStores, propLadder, type FurnitureSource } from '../render/streetFurnitureLayer';

/**
 * THE STREET FURNITURE AS ITS MODELS, AT EVERY SIZE (`propLadderSheet.ts` reference): the layer's own stores and placing (`streetFurnitureLayer.ts`),
 * every kind drawn by its near meshes alone - no level, no picture, near cells and far blocks alike. What a prop's ladder is measured against:
 * the mesh at the size it is drawn at. A sheet's yardstick, never drawn by the game.
 */

export interface ReferenceFurniture {
  readonly group: Group;
  readonly grass: Group;
  readonly layer: PropLayer;
  readonly meshes: PropLayer['meshes'];
  sync(net: Network, elevation: RoadElevation, groundAt: (x: number, y: number) => number, minutes: number): void;
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

export function referenceFurniture(kit: SceneryKit): ReferenceFurniture {
  const pictures = sceneryPictures(kit);
  const ladder = propLadder(kit);
  // Each store's near mesh and its cards: its levels and every coarser mesh left out.
  const stores = furnitureStores(kit, pictures, ladder).map((store) => {
    const { levels: _levels, with: drawnWith, ...rest } = store;
    void _levels;
    return { ...rest, with: (drawnWith ?? []).filter((mesh) => !mesh.far && !mesh.mid) };
  });
  let source: FurnitureSource | null = null;
  let now = 0;
  const layer = createPropLayer({
    name: 'street-furniture-reference', version: 1, kinds: stores.map(kindOf), margin: SHADOW_REACH,
    changes: ['landscape', 'roads', 'elevation'], pad: 0,
    pictures: null, pictureOf: stores.map(() => null),
    place: (rect) => (source ? furnitureAbout(source, stores, kit.lens, now, rect) : { packs: new Map(), growing: false }),
  });
  return {
    group: layer.group,
    grass: new Group(),
    layer,
    get meshes() { return layer.meshes; },
    sync(net, elevation, groundAt, minutes) {
      source = { changes: net.doc.changes, net, elevation, groundAt };
      now = minutes;
      layer.follow(net.doc.changes);
    },
    cull(frustum, view) { layer.cull(frustum, view); },
    dispose() {
      layer.dispose();
      pictures.release();
      ladder.release();
    },
  };
}
