import type { SolidsAsk } from '@world/buildings/cameraSolids';
import { canQueueJobs, submitJob } from '../../jobs/jobPool';
import type { CameraSolidAsk, CameraSolidReply } from './cameraSolid.worker';
import { TIER_SPAN } from './cellPool';
import { rowCopier, rowRefs } from './rowRefs';

/** The queue matches each answer to its job (`submitJob`'s own number): an ask's id is not read. */
const UNNUMBERED = 0;
/** The solids' band in the queue (`cellPool.ts` cellPriority): with the view's detail (0), nearest the view first - what the camera's floor and the
 *  canyon light ask next, a cell the eye is about to come to. */
const SOLID_BAND = 0.5;

/**
 * THE CAMERA'S SOLIDS ASKED OF THE PAGE'S JOB THREADS (`cameraSolid.worker.ts`): the buildings named read where the map's table holds them, the
 * written ones encoded (`rowRefs.ts`). Null without a job queue (every cell filled on the page, `cameraSolids.ts` fill).
 */
export function solidsJobAsk(): SolidsAsk | null {
  if (!canQueueJobs()) return null;
  const copied = rowCopier();
  return (ids, buildings, at) => new Promise((done, fail) => {
    submitJob({
      // The page's own threads alone (no `crosses`): they read the map's table where it stands.
      service: 'cameraSolids', key: null, priority: SOLID_BAND * TIER_SPAN, at,
      write: () => {
        const rows = rowRefs(ids, buildings) ?? { table: copied(ids, buildings) };
        return { data: { id: UNNUMBERED, ...rows } satisfies CameraSolidAsk, transfer: rows.table ? [rows.table] : [] };
      },
      done: (answer) => {
        const reply = answer as CameraSolidReply;
        if ('error' in reply) fail(new Error(reply.error)); else done(reply.buildings);
      },
      failed: (message) => fail(new Error(message)),
    });
  });
}
