import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import type { Finish } from '@world/buildings/materials';
import type { Building } from '@world/buildings/types';
import { type MassShells, emitProgram, massShells } from '@render/buildings/buildingMesh';
import { CELL_DETAIL, type MassDetail, massFloor } from '@render/buildings/massing';

/** A building's masses at a level as the cells' jobs draw them (`cellWork.ts`): its program's mass stage walked on its floor (`known`, else
 *  `massFloor`), then that level's filter in the facade level's format (`massShells`). */
export function massesOf(b: Building, groundAt: GroundAt, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt,
  tone?: Readonly<Record<Finish, readonly [number, number, number]>>, detail: MassDetail = CELL_DETAIL, known?: { readonly floor: number | undefined }): MassShells | null {
  const floor = known ? known.floor : massFloor(b, naturalAt, pavedAt);
  const program = emitProgram(b, groundAt, pavedAt, naturalAt, { near: false, far: false }, { floor: floor ?? null, ...(tone ? { tone } : {}) });
  return massShells(program, detail);
}

/** The corners of a level's triangles (`MassShells`): its shells' and its runs' indices together. */
export function massCorners(m: MassShells): number {
  let n = 0;
  for (const c of [...Object.values(m.shells), ...Object.values(m.runs ?? {})]) if (c) n += c.index.length;
  return n;
}
