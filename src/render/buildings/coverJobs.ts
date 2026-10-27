import type { ChangeRect } from '@world/changes';
import { RecordTable, TableWriter, tableBytes } from '@world/buildings/recordTable';
import type { BuildingStore } from '@world/buildings/store';
import { canQueueJobs, submitJob } from '../../jobs/jobPool';
import type { CoverCellAsk, CoverCellReply } from './coverCell.worker';
import { type CoverAsk, type CoverCell, coverReach, unpackCover } from './layerCells';

/** The queue matches each answer to its job (`submitJob`'s own number): an ask's id is not read. */
const UNNUMBERED = 0;

/**
 * THE BUILDINGS' COVER ASKED OF THE JOB THREADS, A CELL A JOB (`coverCell.worker.ts`): the buildings the store files near the cell
 * (`BuildingStore.nearIds`), their rows copied into a table of their own without decoding (`TableWriter.copyRows`: fit for a job process,
 * never the map's table copied there), a record written on the page encoded; null without a job queue (the cells derived on the page).
 */
export function coverJobAsk(): CoverAsk | null {
  if (!canQueueJobs()) return null;
  const rowsNear = coverRows();
  return (rect, buildings) => new Promise<CoverCell>((done, fail) => {
    submitJob({
      service: 'coverCells', key: null, priority: 0, at: [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2], crosses: true,
      // Its rows read when a thread takes it: the buildings as they stand then (an answer asked before a change is let go, `createCoverIndex`).
      write: () => {
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
 * reach (`coverReach`), copied undecoded, a record written on the page encoded. Each table read once (`RecordTable` held by its bytes).
 */
export function coverRows(): (rect: ChangeRect, buildings: BuildingStore) => ArrayBuffer | null {
  const tables = new WeakMap<ArrayBufferLike, RecordTable>();
  const tableOf = (buffer: ArrayBufferLike): RecordTable => {
    let table = tables.get(buffer);
    if (!table) tables.set(buffer, table = new RecordTable(buffer));
    return table;
  };
  return (rect, buildings) => {
    const reach = coverReach(rect);
    const ids = buildings.nearIds(reach[0], reach[1], reach[2], reach[3]);
    if (!ids.length) return null;
    const writer = new TableWriter(false);
    for (const id of ids) {
      // The row as the table holds it: the wear written over it reads no footprint.
      const ref = buildings.tableRef(id);
      if (ref) { writer.copyRows(tableOf(ref.buffer), [ref.row]); continue; }
      const b = buildings.get(id);
      if (b) writer.add([b]);
    }
    return tableBytes(writer.finish().buffer) as ArrayBuffer;
  };
}
