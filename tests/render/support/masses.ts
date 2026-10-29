import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import type { Finish } from '@world/buildings/materials';
import type { Building } from '@world/buildings/types';
import { emitProgram } from '@render/buildings/buildingMesh';
import { CELL_DETAIL, type MassDetail, type MassingChunk, massFloor, massOf } from '@render/buildings/massing';
import { type CellWriter, writeBase } from '@render/buildings/massBase';

/** A building's masses at a level as the cells' jobs draw them (`cellWork.ts`): its program's mass stage walked on its floor (`known`, else
 *  `massFloor`), then that level's filter (`massOf`). */
export function massesOf(b: Building, groundAt: GroundAt, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt,
  tone?: Readonly<Record<Finish, readonly [number, number, number]>>, detail: MassDetail = CELL_DETAIL, known?: { readonly floor: number | undefined }): MassingChunk | null {
  const floor = known ? known.floor : massFloor(b, naturalAt, pavedAt);
  const program = emitProgram(b, groundAt, pavedAt, naturalAt, { near: false, far: false }, { floor: floor ?? null, ...(tone ? { tone } : {}) });
  return massOf(program, detail);
}

/** A building's base into its cell's writer as the base's job draws it (`cellWork.ts`): its program on `floor`, then the base's filter (`writeBase`). */
export function writeBaseOf(w: CellWriter, b: Building, floor: number | undefined, groundAt: GroundAt, tone?: Readonly<Record<Finish, readonly [number, number, number]>>): void {
  const program = emitProgram(b, groundAt, undefined, groundAt, { near: false, far: false }, { floor: floor ?? null, ...(tone ? { tone } : {}) });
  writeBase(w, program);
}
