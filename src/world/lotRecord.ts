import type { Vec2 } from '@core/vec2';
import { type ZoneDensity, type ZoneUse, zoneDensityName, zoneUseName } from './zones';

/* A lot's record, the test of a point in it (`lots.ts` re-exports both) and the record as a store keeps it (`lotRecord`). */

export interface Lot {
  readonly id: number;
  /** The boundary, counter-clockwise (the inside on the left of each side): any polygon */
  readonly corners: readonly Vec2[];
  readonly use?: ZoneUse;
  readonly density?: ZoneDensity;
  /** The building that grew on it, while it stands. */
  readonly building?: number;
}

/** A stored lot as the document keeps it: its corners its own (a stored record is never changed in place, and the data read may be), its zoning by name, its building only while it stands (`RoadDoc.fromJSON`; `editor/preparedCity.ts` and `LotStore.tableOf` write a city's lots into their table through it). */
export function lotRecord(lot: Lot, standing: (id: number) => boolean): Lot {
  const { building: _gone, ...free } = { ...lot, corners: lot.corners.map((q) => ({ x: q.x, y: q.y })),
    ...(lot.use !== undefined ? { use: zoneUseName(lot.use) } : {}), ...(lot.density !== undefined ? { density: zoneDensityName(lot.density) } : {}) };
  return lot.building !== undefined && standing(lot.building) ? { ...free, building: lot.building } : free;
}

export function insideLot(point: Vec2, l: Pick<Lot, 'corners'>): boolean {
  let inside = false;
  const q = l.corners;
  if (!q.length) return false;
  const p = point;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!, b = q[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
