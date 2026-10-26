import { Heap } from '@core/heap';
import { IdSlots, grown } from '@core/idSlots';
import type { RoadDoc } from '../doc';
import { JournalCursor } from '../derived';
import { SUMMARY_BUILT_AT } from './summary';
import { type Building, type BuildingId, DECAY_GRACE, DECAY_SPAN, decayOf } from './types';

/** DO NOT read `change.ids ?? []`: after a load the new town never ran down and the old one stayed due. */
export function createDecayWatch(doc: RoadDoc, wear: (id: BuildingId, decay: number) => void): (now: number) => boolean {
  /** Each built record's next tenth, city minutes, in a column by its id's slot; no slot: fully run down or gone. DO NOT keep a `Map` entry a building: the whole city is filed here. */
  const slots = new IdSlots(1024);
  let dueAt = new Float64Array(16);
  slots.onGrow = (n) => { dueAt = grown(dueAt, n); };
  const dueOf = (id: BuildingId): number | undefined => { const slot = slots.get(id); return slot < 0 ? undefined : dueAt[slot]; };
  const queue = new Heap();
  const seen = new JournalCursor(['buildings'], true);
  let lastNow = -Infinity;
  /** The next tenth of a building built at `builtAt` (undefined: never built, it does not run down). */
  const nextTenth = (builtAt: number | undefined, now: number): number => {
    if (builtAt === undefined) return Infinity;
    const decay = decayOf(builtAt, now);
    // `decayOf` rounds (now - builtAt - grace) / span to tenths: the next tenth at the half past this one.
    return decay >= 1 ? Infinity : builtAt + DECAY_GRACE + (DECAY_SPAN * (decay * 10 + 0.5)) / 10;
  };
  const fileAt = (builtAt: number | undefined, id: BuildingId, now: number): void => {
    const at = nextTenth(builtAt, now);
    if (at === Infinity) { slots.delete(id); return; }
    // The slot taken first: taking it may grow the column (`onGrow`), and the column read before it would be the old one.
    const slot = slots.take(id);
    dueAt[slot] = at;
    queue.push(id, at);
  };
  const file = (b: Building | undefined, id: BuildingId, now: number): void => fileAt(b?.builtAt, id, now);
  /** One look at city minute `now`; true when a building's decay changed. */
  return (now: number): boolean => {
    // A clock that went back reads the town again, as a diary that forgot does.
    if (now < lastNow) seen.reset();
    const changes = seen.read(doc.changes);
    lastNow = now;
    if (changes === null) {
      // @rebuild The diary forgot, or the clock went back: every building filed again, a row of the table from its `builtAt` column (`summary.ts`), nothing decoded. DO NOT decode the town for it: the 10 km city's 249,122 buildings at its first minute (2026-10-26).
      slots.clear();
      queue.clear();
      doc.buildings.eachSummarised((id, table, at) => {
        const builtAt = table.summary![SUMMARY_BUILT_AT * table.rows + at]!;
        fileAt(Number.isNaN(builtAt) ? undefined : builtAt, id, now);
      }, (b) => file(b, b.id, now));
    } else {
      for (const change of changes) for (const id of change.ids!) file(doc.buildings.get(id as BuildingId), id as BuildingId, now);
    }
    let changed = false;
    while (queue.peekKey() <= now) {
      const at = queue.peekKey();
      const id = queue.pop() as BuildingId;
      if (dueOf(id) !== at) continue; // superseded by a later filing, or gone
      if (!doc.buildings.has(id)) { slots.delete(id); continue; }
      // Its clock and its wear read without its record where it is a row of the table (`builtAtOf`, `decayOf`): DO NOT decode a building each tenth of its wear.
      const builtAt = doc.buildings.builtAtOf(id);
      const decay = decayOf(builtAt, now);
      if (decay !== doc.buildings.decayOf(id)) { wear(id, decay); changed = true; }
      fileAt(builtAt, id, now);
    }
    return changed;
  };
}
