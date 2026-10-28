import type { Building } from '@world/buildings/types';
import { CELL } from '@world/cells';
import { type CellMass, type MassSquare, concatMass, massOnGrid } from './cellArrays';

/**
 * THE BUILDINGS' TOP LEVEL (the base, over each plate's square): every building of the square laid as the plate lays it, by the same writer in
 * the facade level's own format and materials (`buildingMesh.ts` massShells at `PLATE_DETAIL`): its own blocks and roofs, its paints and
 * finishes, its walls as the facade level's runs of bays. DO NOT give it a form of its own: its prisms, painted and with a window grid of their
 * own, stood as other buildings than the plate's and the detail's wherever nothing finer had landed (the owner, 2026-10-27: one form at a view).
 * Made first for the plates within a plate of the view and kept while they are (`massCells.ts` BASE_RING): drawn under every cell nothing finer
 * draws, so no view shows a hole in the town.
 * Its triangles run cell by cell (`BaseMass.cells`): the cells a finer level draws are left out of its draw (three's geometry groups), never
 * drawn twice.
 */

/** A square's base: its cells' masses joined, and where each cell's triangles are in them. */
export interface BaseMass {
  /** Its cells' masses joined in the cells' order (`concatMass`), on the square's grid: every cell's shells' triangles, then every cell's
   *  runs' (`CellMass.runs`). Null where none of its buildings stands from afar. */
  readonly mass: CellMass | null;
  /** `BASE_CELL_STRIDE` numbers a cell that has buildings, in the cells' order: its column, its row, its shells' first index and count, its
   *  runs' first index and count (none: none of its buildings stands from afar). */
  readonly cells: Int32Array;
}

/** Numbers a cell's entry holds in `BaseMass.cells`. */
export const BASE_CELL_STRIDE = 6;

/** The cell a building's base is filed in: its position's, as `layer.ts` cellOf files it. */
export const baseCellOf = (b: Building): string => `${Math.floor(b.x / CELL)},${Math.floor(b.y / CELL)}`;

/** A square's base joined from its cells' masses (null: none of a cell's buildings stands from afar), in the cells' order; null with no cell. */
export function joinBase(cells: readonly { readonly cell: string; readonly mass: CellMass | null }[], square: MassSquare): BaseMass | null {
  if (!cells.length) return null;
  const joined = concatMass(cells.flatMap(({ mass }) => (mass ? [mass] : [])));
  const out = new Int32Array(cells.length * BASE_CELL_STRIDE);
  let shells = 0, runs = joined ? joined.runs : 0;
  cells.forEach(({ cell, mass }, k) => {
    const comma = cell.indexOf(',');
    const ownShells = mass ? mass.runs : 0, ownRuns = mass ? mass.index.length - mass.runs : 0;
    out.set([Number(cell.slice(0, comma)), Number(cell.slice(comma + 1)), shells, ownShells, runs, ownRuns], k * BASE_CELL_STRIDE);
    shells += ownShells;
    runs += ownRuns;
  });
  return { mass: joined && massOnGrid(joined, square), cells: out };
}
