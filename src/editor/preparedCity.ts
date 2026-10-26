import { type SerializedDoc, landscapeRecord, lotRecord } from '@world/doc';
import { RecordTable, TableWriter, encodeRecords } from '@world/buildings/recordTable';
import { SharedMembers } from '@world/buildings/intern';
import { migrateBuilding } from '@world/buildings/serialize';
import { type Building, settleBuilding } from '@world/buildings/types';
import type { LandscapeItem } from '@world/landscape';
import { isLot, lotCentre, type Lot } from '@world/lots';

/** A WHOLE CITY MADE OFF THE PAGE (`cityGen.worker.ts`), ITS BUILDINGS, ITS LANDSCAPING AND ITS LOTS EACH ONE SHARED TABLE (the buildings' as a tile's, `tileStore.ts` prepareTile): each building migrated and settled where it is made (`settleBuilding`: made plain, its members interned), the page reading every record from its table when asked, each knowing its row. DO NOT post a city's items of landscaping or its lots as objects: 228,000 and 111,000 of them stood on the page of a 10 km city (2026-10-26). */

/** A city's document without its buildings, landscaping and lots, and their tables (`prepareCity`, `PreparedCityWriter`); null: none of the kind. */
export interface PreparedCity {
  readonly data: SerializedDoc;
  readonly buildings: ArrayBufferLike;
  readonly landscape: ArrayBufferLike | null;
  readonly lots: ArrayBufferLike | null;
}

/** DO NOT post a city's buildings as objects: the page held the message's clone and its migrated copy, walked and interned every record again on adopting it, and made a table of its own for each building the first time a job or a write asked for it (`refOf`): ~1.3 GB allocated opening the large city, 2026-10-20. */
// DO NOT `intern` a whole map's records in one synchronous pass (`settleBuilding` interning): every member got a WeakRef, a finalizer and
// a freeze, held until the task ended - reopening a saved city of 8,102 buildings spent 0.85 s of the page in it (`npm run diagnose`,
// 2026-10-22). Written as a generated city's are (`PreparedCityWriter`, the members shared a batch at a time): the same table.
const PREPARE_BATCH = 2000;

export function prepareCity(data: SerializedDoc): PreparedCity {
  const shared = new SharedMembers();
  const writer = new PreparedCityWriter(shared);
  const all = (data.buildings ?? []) as readonly Building[];
  for (let i = 0; i < all.length; i += PREPARE_BATCH) {
    writer.add(all.slice(i, i + PREPARE_BATCH));
    shared.end();
    writer.endBatch();
  }
  const buildings = writer.finish();
  // The landscaping and the lots as `RoadDoc.fromJSON` would read them (a malformed record dropped, a lot's building only while it stands), each kind one table; their lists left empty in their places.
  const items: LandscapeItem[] = [];
  for (const raw of data.landscape ?? []) { const item = landscapeRecord(raw, false); if (item) items.push(item); }
  const standing = new RecordTable(buildings);
  const seen = new Set<number>();
  const lots: Lot[] = [];
  for (const lot of data.lots ?? []) {
    if (!isLot(lot) || seen.has(lot.id)) continue;
    seen.add(lot.id);
    lots.push(lotRecord(lot, (id) => standing.row(id) >= 0));
  }
  return {
    data: { ...data, buildings: [], ...(data.landscape ? { landscape: [] } : {}), ...(data.lots ? { lots: [] } : {}) },
    buildings,
    landscape: items.length ? encodeRecords(items).buffer : null,
    lots: lots.length ? encodeRecords(lots, lotCentre).buffer : null,
  };
}

/**
 * A CITY'S BUILDINGS PREPARED AS `prepareCity` PREPARES THEM, A BATCH AT A TIME AS THEY ARE MADE (`smallCityMap.ts` buildCityTable): each
 * migrated, the first of an id kept, settled and written to the page's table (`TableWriter`), the records let go. The same records as
 * `prepareCity`'s table (the members a building shares with others written once a batch, not once a city: the same values).
 */
export class PreparedCityWriter {
  private readonly table = new TableWriter(true);
  private readonly ids = new Set<number>();

  /** `shared`: the members the city's buildings have alike, kept across batches (`SharedMembers`): each written once while it is met, as `prepareCity`'s interned members were. The growth's table shares it (`SpilledItems`): a member its records made canonical is found here by identity, not hashed again. Each batch ended by its owner (`endBatch`). */
  constructor(private readonly shared: SharedMembers) {}

  /** The batch of members shared ended (`SharedMembers.end`): the table keeps as nodes only the members kept. */
  endBatch(): void {
    this.table.keepOnly((node) => this.shared.keeps(node));
  }

  /** The next records of the city, in its order. */
  add(batch: readonly Building[]): void {
    const settled = new WeakSet<object>(), rows: Building[] = [];
    for (const raw of batch) {
      const b = migrateBuilding(raw);
      if (!b || this.ids.has(b.id)) continue;
      this.ids.add(b.id);
      rows.push(settleBuilding(b, settled, undefined, false));
    }
    // What the records have alike written once (`SharedMembers`). DO NOT `intern` them: its `WeakRef`s hold every member of every record until the generation's task ends.
    this.shared.share(rows);
    this.table.add(rows);
  }

  /** The table of every record added. */
  finish(): ArrayBufferLike {
    return this.table.finish().buffer;
  }
}

/** The tables a city opens with (`restoreInto`): its buildings', its landscaping's and its lots' (null: those records in the data, or none). */
export interface OpenedTables {
  readonly buildings: ArrayBufferLike | null;
  readonly landscape: ArrayBufferLike | null;
  readonly lots: ArrayBufferLike | null;
}

/** A city as the page opens it; `table`: its buildings' table (`prepareCity`), the document's source of truth as it is, null: its buildings are in `data`; `landscape`, `lots`: their tables likewise. */
export interface OpenedCity extends OpenedTables {
  readonly data: SerializedDoc;
  readonly table: ArrayBufferLike | null;
}

/** A prepared city as the page opens it: DO NOT decode its tables here (every record an object, ~8 KB of heap a building): the document reads a row when asked. */
export function preparedCity(data: SerializedDoc, table: ArrayBufferLike, landscape: ArrayBufferLike | null = null, lots: ArrayBufferLike | null = null): OpenedCity {
  return { data: { ...data, buildings: [] }, table, buildings: table, landscape, lots };
}

/** The tables of an opened city, as `restoreInto` takes them. */
export function openedTables(city: OpenedCity): OpenedTables {
  return { buildings: city.table, landscape: city.landscape, lots: city.lots };
}

/** Whether `tables` is the set of an opened city's tables (`OpenedTables`) rather than one buildings' table. */
export function isOpenedTables(tables: OpenedTables | ArrayBufferLike): tables is OpenedTables {
  return !(tables instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && tables instanceof SharedArrayBuffer);
}

/** How many buildings an opened city has, in its data or its table. */
export function openedBuildings(city: OpenedCity): number {
  return (city.data.buildings?.length ?? 0) + (city.table ? new RecordTable(city.table).rows : 0);
}
