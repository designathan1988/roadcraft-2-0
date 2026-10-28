import { Color } from 'three';
import { resolveBlocks } from '@world/buildings/blocks';
import { floorHeight, frontFloorHeight, type GroundAt, type PavedAt } from '@world/buildings/foundation';
import { closedBlocks } from '@world/buildings/geometry';
import type { BayComponent, Building, LotSurface } from '@world/buildings/types';
import { m } from '@world/units';

/** A BUILDING FROM AFAR: what each level drawn from afar leaves out (`MassDetail`), the floors it stands on, the colours of its base. Every level is
 *  laid from the building's program (`program.ts`) in the facade level's own format and look (`buildingMesh.ts` massShells), never by a walk of
 *  its own. */

/** WHAT A LEVEL OF THE MASSES LEAVES OUT: the cell's (all of it), a tile's (L2) and a plate's (L3, `massLevels.ts`) */
export interface MassDetail {
  /** The tallest thing left out or laid flat, m: a relief and its cheeks, a parapet, a box on the roof, a machine room. */
  readonly drop: number;
  /** Each block a box: its pitched roof under `drop` laid flat at its eaves (L3). */
  readonly boxes: boolean;
}
export const CELL_DETAIL: MassDetail = { drop: 0, boxes: false };
/** A tile's: under 1.4 m (a parapet, a solar panel, a skylight, a relief); what stands higher on a roof kept (a machine room, `MACHINE_ROOM_H`; a
 *  lift room, a tank, an air handler; an attic, `ATTIC_H`). DO NOT leave the roofs bare: under 3 m it left every roof of a tile flat and empty, half
 *  of the box look of downtown from the Home view (the owner, 2026-10-25). Its error stays the far level's own (`FAR_ERROR`, 1.5 m) at least. */
export const TILE_DETAIL: MassDetail = { drop: m(1.4), boxes: false };
/** A plate's: under 8 m, the pitched roofs of houses and low blocks flattened too. */
export const PLATE_DETAIL: MassDetail = { drop: m(8), boxes: true };

/** Where the wall of a block on the ground starts: below the lowest ground under it, as the detailed plinth does. */
export const BURY = m(1.5);

export function rgbOf(hex: number, shade = 1): [number, number, number] {
  const c = new Color().setHex(hex);
  return [c.r * shade, c.g * shade, c.b * shade];
}

export type Rgb = readonly [number, number, number];
/** Where a window sits in its storey from afar when its bay says nothing of it (a pillar's arcade): shares of the storey height from its floor. */
export const MASS_SILL = 0.3;
export const MASS_HEAD = 0.85;
/** The building's own shade, as the detailed one has it (`buildingMesh.ts` `emitBuilding`). */
export const shadeOf = (b: Building): number => 0.93 + (((b.id * 2654435761) >>> 0) % 1000) / 1000 * 0.12;

/** A building's floor as the detailed one's (`buildingMesh.ts` `emitChunk`, `floorHeight`); undefined with no closed block. */
export function massFloor(b: Building, naturalAt: GroundAt, pavedAt?: PavedAt): number | undefined {
  const resolved = resolveBlocks(b);
  return closedBlocks(resolved.volumes).length > 0 ? floorHeight(resolved, naturalAt, pavedAt) : undefined;
}

/** A building's floor as the levels drawn farthest stand it (the tiles', the plates' and the base's, `cellWork.ts`): its lots' front pavement, no bay laid out (`frontFloorHeight`); undefined with no closed block. Never handed to the finer levels: they stand on `massFloor`. */
export function baseFloor(b: Building, naturalAt: GroundAt, pavedAt?: PavedAt): number | undefined {
  const resolved = resolveBlocks(b);
  return closedBlocks(resolved.volumes).length > 0 ? frontFloorHeight(resolved, naturalAt, pavedAt) : undefined;
}

/** The colours of a lot's surface (`buildingMesh.ts` draws them in their finishes) */
export const LOT_COLOURS: Readonly<Record<LotSurface, number>> = {
  grass: 0x6f9a4c, paving: 0xc4beb2, gravel: 0xa9a294, sand: 0xe2cf9c, water: 0x4f8fb3,
  asphalt: 0x515457, concrete: 0xb9b6ae, pavers: 0x9a958c, tiles: 0xb4785a,
};

/** The share of a bay its window takes across, by what the bay holds where the bay says nothing of its opening (a pillar's arcade). */
export const GLASS_SHARE: Partial<Record<BayComponent, number>> = {
  window: 0.5, sashWindow: 0.5, shutteredWindow: 0.5, brise: 0.5,
  wideWindow: 0.75, ribbon: 0.8, bayWindow: 0.75,
  frenchWindow: 0.6, balcony: 0.6, gourmet: 0.7, loggia: 0.7,
  door: 0.35, doubleDoor: 0.5, shopfront: 0.85, pillar: 0.7,
};
