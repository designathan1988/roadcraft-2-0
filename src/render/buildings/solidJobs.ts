import type { SolidsAsk } from '@world/buildings/cameraSolids';
import { canQueueJobs, submitJob } from '../../jobs/jobPool';
import type { CameraSolidAsk, CameraSolidReply } from './cameraSolid.worker';
import { TIER_SPAN } from './cellPool';
import type { BuildingLayer } from './layerApi';
import { rowCopier, rowRefs } from './rowRefs';

/** The queue matches each answer to its job (`submitJob`'s own number): an ask's id is not read. */
const UNNUMBERED = 0;
/** The solids' band in the queue (`cellPool.ts` cellPriority): with the view's detail (0), nearest the view first - what the camera's floor and the
 *  canyon light ask next, a cell the eye is about to come to. */
const SOLID_BAND = 0.5;
/** How far past its buildings' rectangle a job's paving is handed (`cellPool.ts` PAVING_REACH): what a floor reads round a footprint. */
const PAVING_REACH = 64;

/**
 * THE CAMERA'S SOLIDS ASKED OF THE PAGE'S JOB THREADS (`cameraSolid.worker.ts`): the buildings named read where the map's table holds them, the
 * written ones encoded (`rowRefs.ts`), each building's floor measured there on the ground and paving the cells' jobs read (`groundOf`, the
 * buildings' layer `jobGround`). Null without a job queue (every cell filled on the page, `cameraSolids.ts` fill).
 * DO NOT leave the floors to the page: a view come to a district not seen yet had the floors of the canyon light's 2 km worked out there, about
 * a second of its frames, the masses' jobs measuring only the cells they draw (2026-10-27).
 */
export function solidsJobAsk(groundOf: () => ReturnType<BuildingLayer['jobGround']>): SolidsAsk | null {
  if (!canQueueJobs()) return null;
  const copied = rowCopier();
  return (ids, buildings, at, rect) => new Promise((done, fail) => {
    submitJob({
      // The page's own threads alone (no `crosses`): they read the map's table and the ground where they stand.
      service: 'cameraSolids', key: null, priority: SOLID_BAND * TIER_SPAN, at,
      write: () => {
        const rows = rowRefs(ids, buildings) ?? { table: copied(ids, buildings) };
        const ground = groundOf();
        const paving = ground?.paved ? ground.pack([rect[0] - PAVING_REACH, rect[1] - PAVING_REACH, rect[2] + PAVING_REACH, rect[3] + PAVING_REACH]) : null;
        // The floors measured only where every read they need can be handed: the ground shared, and the paving packed where there is paving.
        const floors = ground && (!ground.paved || paving) ? { ground: ground.ground, naturalIsGround: ground.naturalIsGround, ...(paving ? { paving: paving.data } : {}) } : null;
        const data: CameraSolidAsk = { id: UNNUMBERED, ...rows, ...(floors ? { floors } : {}) };
        return { data, transfer: [...(rows.table ? [rows.table] : []), ...(paving?.transfer ?? [])] };
      },
      done: (answer) => {
        const reply = answer as CameraSolidReply;
        if ('error' in reply) fail(new Error(reply.error)); else done(reply.buildings);
      },
      failed: (message) => fail(new Error(message)),
    });
  });
}
