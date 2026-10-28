import { type GroundAt, type PavedAt, floorHeight } from './foundation';
import type { GroundSince, Rect } from './cameraSolids';
import type { BuildingStore } from './store';
import type { TableRows } from './tableRows';
import type { Building } from './types';

/** Nothing is evicted for room: DO NOT cap it. */
export interface BuildingFloors {
  /** The building's ground floor on the ground and the paving as they stand. */
  floorOf(b: Building): number;
  /** The floor kept of a table's row, its record not read; undefined when none is kept. */
  floorKept(table: TableRows, row: number): number | undefined;
  /** Moves whenever a row's floor is kept (`floorOf`): what `floorKept` answers may have changed since. */
  readonly keptVersion: number;
  /** Forgets one building's floor (its site worked out again). */
  forget(b: Building): void;
  /** Forgets every floor (the roads or the land moved everywhere). */
  forgetAll(): void;
  /** Forgets the floors whose reach (`boxOf`) a change of the ground since the last `follow` touches; where the diary cannot say, those the regions the caller is shaping (`shaped`) reach, or every one without them. */
  follow(buildings: BuildingStore, ground: GroundSince, shaped?: readonly Rect[] | null): void;
}

/**
 * `boxOf`: a building's bounds grown by how far its floor reads (`FLOOR_READ_REACH`), `reach` that growth. `standing`: the row of the table a
 * building's record is the store's own record of (`BuildingStore.recordRow`): its floor kept by that row while the row stands. DO NOT keep a
 * table row's floor by its record alone: the table decodes a record when asked and lets it go (`TableRows`, held weakly), the collector took it,
 * and the floor was worked out again with the record at the next ask - the street's props, the gardens and the camera's solids of a 10 km city
 * decoded their buildings and sampled their ground again at every frame of a move (0.55 s of 3.3 s of frames, one profile, 2026-10-27).
 */
/**
 * `measured`: a building's floor as worked out elsewhere on the same ground and paving (the cells' jobs, `layer.ts` knownFloor), taken in place of
 * working it out here for a building whose blocks are its volumes as they stand (none a void, an intersection or an exclusive one: the jobs
 * measure the blocks resolved, `blocks.ts` resolveBlocks, the same building then). DO NOT work out on the page what a job measured: a camera
 * move across a 10 km city worked out the floors of the canyon light's window of 2 km, every building's ground bays, at every frame (2 s of 6.9).
 */
export function buildingFloors(groundAt: GroundAt, pavedAt: PavedAt | undefined, boxOf: (b: Building) => Rect, reach: number,
  standing: ((b: Building) => { readonly table: TableRows; readonly row: number } | null) | null = null,
  measured: ((b: Building) => number | undefined) | null = null): BuildingFloors {
  /** The floor of `b` as measured elsewhere where it is the same building there, else worked out here. */
  const work = (b: Building): number => {
    if (measured && !b.volumes.some((v) => v.mode)) {
      const known = measured(b);
      if (known !== undefined) return known;
    }
    return floorHeight(b, groundAt, pavedAt);
  };
  /** The floors of the records written on the page (held by their store) and of a record not standing as a table's row. */
  let known = new WeakMap<Building, number>();
  /** The floors of a table's rows, by row (NaN: not worked out), while the table is the store's. */
  let rows = new WeakMap<TableRows, Float64Array>();
  let seen = -1;
  /** The row a record stands as, only when it is that row's own record (`BuildingStore.recordRow`: a building edited, or a preview of one, keeps its own floor). */
  const rowOf = (b: Building): { readonly table: TableRows; readonly row: number } | null => standing?.(b) ?? null;
  let keptVersion = 0;
  return {
    get keptVersion() { return keptVersion; },
    floorOf(b) {
      const at = rowOf(b);
      if (at) {
        let column = rows.get(at.table);
        if (!column) rows.set(at.table, column = new Float64Array(at.table.size).fill(Number.NaN));
        let floor = column[at.row]!;
        if (Number.isNaN(floor)) { column[at.row] = floor = work(b); keptVersion++; }
        return floor;
      }
      let floor = known.get(b);
      if (floor === undefined) known.set(b, floor = work(b));
      return floor;
    },
    floorKept(table, row) {
      const floor = rows.get(table)?.[row];
      return floor === undefined || Number.isNaN(floor) ? undefined : floor;
    },
    forget(b) {
      known.delete(b);
      const at = rowOf(b);
      const column = at ? rows.get(at.table) : undefined;
      if (at && column) column[at.row] = Number.NaN;
    },
    forgetAll() {
      known = new WeakMap();
      rows = new WeakMap();
    },
    follow(buildings, ground, shaped) {
      if (ground.version === seen) return;
      // DO NOT forget every floor of the town where the diary cannot say: the regions the caller has just shaped hold the change it follows.
      const rects = seen < 0 ? null : ground.rectsSince(seen) ?? shaped ?? null;
      seen = ground.version;
      if (rects === null) { known = new WeakMap(); rows = new WeakMap(); return; }
      // Every change in one look (`BuildingStore.nearAny`).
      for (const b of buildings.nearAny(rects, reach, (b, r) => {
        const box = boxOf(b);
        return box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1];
      })) this.forget(b);
    },
  };
}
