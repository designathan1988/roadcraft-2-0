import type { RowSummary } from './buildings/recordTable';
import type { Lot } from './lotRecord';

/**
 * WHAT IS READ OF A LOT WITHOUT ITS RECORD, AS ITS TABLE'S SUMMARY COLUMNS (`recordTable.ts` format 3): whether it is zoned, and the building it
 * names (NaN: none). Worked out where the record is written (`LotStore.tableOf`, the city's tiles joined, a square of the save), copied with the
 * row after. The open lots are filed from them (`openLots.ts`). DO NOT decode a map's every lot to find which are open: the 10 km city's
 * 111,000 lots stood decoded on the page from the growth's first look (2026-10-26).
 */

/** The summary columns, in their order: zoned (1) or not (0), the building it names (NaN: none). */
export const LOT_ZONED = 0, LOT_BUILDING = 1;
/** How many summary columns a lot's table holds. */
export const LOT_SUMMARY_WIDTH = 2;

/** A lot's summary columns (`LOT_*`). */
export const lotSummary = (lot: Lot): number[] => [lot.use ? 1 : 0, lot.building ?? Number.NaN];

/** The lots' summary as a table writer takes it (`TableWriter` summary). */
export function lotSummaryColumns(): RowSummary<Lot> {
  return { width: LOT_SUMMARY_WIDTH, of: lotSummary };
}
