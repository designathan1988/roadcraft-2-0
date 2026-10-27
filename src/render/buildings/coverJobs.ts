import type { ChangeRect } from '@world/changes';
import type { BuildingStore } from '@world/buildings/store';
import { canQueueJobs, submitJob } from '../../jobs/jobPool';
import type { CoverCellAsk, CoverCellReply } from './coverCell.worker';
import { type CoverAsk, type CoverCell, coverReach, unpackCover } from './layerCells';
import { TIER_SPAN } from './cellPool';
import { rowCopier, rowRefs } from './rowRefs';

/** The queue matches each answer to its job (`submitJob`'s own number): an ask's id is not read. */
const UNNUMBERED = 0;

/**
 * The cover's band in the queue (`cellPool.ts` cellPriority): after the masses and their tiles and plates (2-2.75), before the summaries (3),
 * nearest the view first within it. DO NOT ask it in the detail's band (0): the plants of the whole map ask the cover of every cell of it at
 * the opening, 1,600 cells of a 10 km city, and in that band every one of them went before every mass the curtain waits for.
 */
const COVER_BAND = 2.9;

/**
 * THE BUILDINGS' COVER ASKED OF THE JOB THREADS, A CELL A JOB (`coverCell.worker.ts`): the buildings the store files near the cell
 * (`BuildingStore.nearIds`). A thread of the page reads their rows where the map's table holds them (`RecordRef`, the same memory); a thread of
 * a job process gets them copied into a table of their own without decoding (`TableWriter.copyRows`: fit for another process, never the map's
 * table copied there). A record written on the page is encoded either way. Null without a job queue (the cells derived on the page).
 */
export function coverJobAsk(): CoverAsk | null {
  if (!canQueueJobs()) return null;
  const rowsNear = coverRows();
  return (rect, buildings) => new Promise<CoverCell>((done, fail) => {
    submitJob({
      // The page's own threads alone (no `crosses`): they read the map's table where it stands (`refs`), nothing copied on the page. DO NOT send
      // it to a job process: each of its asks copied the cell's buildings' rows on the page, 0.32 s of 3.3 s of frames of a camera move (2026-10-27).
      service: 'coverCells', key: null, priority: COVER_BAND * TIER_SPAN, at: [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2],
      // Its rows read when a thread takes it: the buildings as they stand then (an answer asked before a change is let go, `createCoverIndex`).
      write: (to) => {
        const reach = coverReach(rect);
        const near = to.sharesMemory ? rowRefs(buildings.nearIds(reach[0], reach[1], reach[2], reach[3]), buildings) : null;
        if (near) return { data: { id: UNNUMBERED, rect, ...near } satisfies CoverCellAsk, transfer: near.table ? [near.table] : [] };
        const table = rowsNear(rect, buildings);
        return { data: { id: UNNUMBERED, rect, table } satisfies CoverCellAsk, transfer: table ? [table] : [] };
      },
      done: (answer) => {
        const reply = answer as CoverCellReply;
        if ('error' in reply) fail(new Error(reply.error)); else done(unpackCover(reply.cover));
      },
      failed: (message) => fail(new Error(message)),
    });
  });
}

/**
 * The rows a cell's cover reads, as a table of their own (null: no building near): those the store files near the cell grown by its
 * reach (`coverReach`), copied undecoded, a record written on the page encoded (`rowRefs.ts` rowCopier).
 */
export function coverRows(): (rect: ChangeRect, buildings: BuildingStore) => ArrayBuffer | null {
  const copied = rowCopier();
  return (rect, buildings) => {
    const reach = coverReach(rect);
    return copied(buildings.nearIds(reach[0], reach[1], reach[2], reach[3]), buildings);
  };
}
