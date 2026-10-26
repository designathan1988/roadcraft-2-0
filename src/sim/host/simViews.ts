import type { RoadDoc, RecordPart } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { type Archetype, archetypeById } from '../vehicles/archetypes';
import type { KerbStop } from '../vehicles/kerbStops';
import type { PersonAgeClass } from '../people/view';
import type { VehicleFrames } from '../pose';

/** THE PAGE'S VIEWS OF THE WORKER'S FLEET, MADE AND WRITTEN (`simClient.ts` readTick): a view made once a vehicle, its pose and frames written in place each tick. */

/** A vehicle as the page draws it: its numbers of the last tick and what it carries (`VehicleRich`). */
export interface VehicleView {
  readonly id: number;
  archetype: Archetype;
  color: string;
  doors: readonly number[];
  kerbStop: KerbStop | null;
  people: readonly number[];
  peopleAge: readonly (PersonAgeClass | undefined)[];
  seats: number;
  slain: boolean;
  age: number;
  v: number;
  readonly prev: { v: number };
  /** Off the road: its pose a tick ago and now, and the lot it stands on; null on a lane. */
  free: { px: number; py: number; pangle: number; x: number; y: number; angle: number; lot: number | null } | null;
  readonly frames: VehicleFrames;
  /** The road its lane belongs to (undefined on a junction's connector), and the road it came from on one. */
  segment: SegmentId | undefined;
  inSegment: SegmentId | undefined;
  indicator: -1 | 0 | 1;
  curvature: number;
  odometer: number;
  /** The client's own: the tick it was last read in (`readTick`), those not read in a tick being gone. */
  tickRead: number;
}

/** A map emptied and filled with the pairs. */
export function fillMap<K, V>(map: Map<K, V>, pairs: readonly (readonly [K, V])[]): Map<K, V> {
  map.clear();
  for (const [k, v] of pairs) map.set(k, v);
  return map;
}

/** A colour as the worker numbers it (0xrrggbb) as its palette writes it. */
export function colourString(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

export function newView(id: number): VehicleView {
  return {
    id, archetype: archetypeById('car'), color: '#888888', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0, prev: { v: 0 },
    free: null, frames: { bx: 0, by: 0, bangle: 0, x: 0, y: 0, angle: 0, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: -1,
  };
}

/** A view off the road: its two poses and its lot, into the pose it already has (DO NOT make one a vehicle a tick). */
export function setFree(view: VehicleView, px: number, py: number, pangle: number, x: number, y: number, angle: number, lot: number | null): void {
  const free = view.free ?? (view.free = { px, py, pangle, x, y, angle, lot });
  free.px = px; free.py = py; free.pangle = pangle; free.x = x; free.y = y; free.angle = angle; free.lot = lot;
}

export function setFrames(f: VehicleFrames, bx: number, by: number, bangle: number, x: number, y: number, angle: number): void {
  f.bx = bx; f.by = by; f.bangle = bangle; f.x = x; f.y = y; f.angle = angle; f.yawBefore = 0; f.yawNow = 0; f.jump = false;
}

/** A record of the map by its part, for the worker's copy (never a building's: `buildingChangesOf`). */
export function recordOf(doc: RoadDoc, part: RecordPart, id: number): unknown {
  switch (part) {
    case 'nodes': return doc.nodes.get(id as NodeId);
    case 'segments': return doc.segments.get(id as SegmentId);
    case 'lots': return doc.lotStore.get(id);
    default: return undefined;
  }
}
