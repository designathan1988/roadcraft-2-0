import { type SerializedDoc, landscapeRecord, lotRecord, poleRecord, spanPlace } from '@world/doc';
import type { TableBase } from '@world/buildings/tableRows';
import { DOC_TABLES, type DocTable } from '@world/docBinary';
import type { FieldWrites } from '@world/buildings/items';
import { RecordTable, TableWriter, encodeRecords } from '@world/buildings/recordTable';
import { buildingSummaryColumns } from '@world/buildings/summary';
import { buildingBounds } from '@world/buildings/geometry';
import { SharedMembers } from '@world/buildings/intern';
import { migrateBuilding } from '@world/buildings/serialize';
import { type Building, settleBuilding } from '@world/buildings/types';
import type { LandscapeItem } from '@world/landscape';
import { isLot, lotBounds, lotCentre, type Lot } from '@world/lots';
import { lotSummaryColumns } from '@world/lotSummary';
import { asPoleId, asSpanId } from '@world/ids';
import type { UtilityPole, UtilitySpan } from '@world/utilities';

/** A WHOLE CITY MADE OFF THE PAGE (`cityGen.worker.ts`), EACH KIND OF RECORD KEPT IN A TABLE (`DOC_TABLES`: its buildings, landscaping, lots, poles and wires) ONE SHARED TABLE (the buildings' as a tile's, `tileStore.ts` prepareTile): each building migrated and settled where it is made (`settleBuilding`: made plain, its members interned), the page reading every record from its table when asked, each knowing its row. DO NOT post a city's items of landscaping, lots, poles or wires as objects: 228,000, 111,000 and ~90,000 of them stood on the page of a 10 km city (2026-10-26). */

/** The tables beside the buildings' (`DOC_TABLES` but the buildings'). */
export const CITY_TABLES = DOC_TABLES.filter((name): name is CityTable => name !== 'buildings');
export type CityTable = Exclude<DocTable, 'buildings'>;
/** Each kind's table beside the buildings'; null: none of the kind, or its records in the data. */
export type CityTables = Readonly<Record<CityTable, ArrayBufferLike | null>>;

/** A city's document without the records kept in tables, and their tables (`prepareCity`, `PreparedCityWriter`). */
export interface PreparedCity extends CityTables {
  readonly data: SerializedDoc;
  readonly buildings: ArrayBufferLike;
}

/** DO NOT post a city's buildings as objects: the page held the message's clone and its migrated copy, walked and interned every record again on adopting it, and made a table of its own for each building the first time a job or a write asked for it (`refOf`): ~1.3 GB allocated opening the large city, 2026-10-20. */
// DO NOT `intern` a whole map's records in one synchronous pass (`settleBuilding` interning): every member got a WeakRef, a finalizer and
// a freeze, held until the task ended - reopening a saved city of 8,102 buildings spent 0.85 s of the page in it (`npm run diagnose`,
// 2026-10-22). Written as a generated city's are (`PreparedCityWriter`, the members shared a batch at a time): the same table.
const PREPARE_BATCH = 2000;

/** `repair`: the records stood on the world as `RoadDoc.fromJSON` repairs a file's (false for a city this build made). */
export function prepareCity(data: SerializedDoc, repair = false): PreparedCity {
  const shared = new SharedMembers();
  const writer = new PreparedCityWriter(shared);
  const all = (data.buildings ?? []) as readonly Building[];
  for (let i = 0; i < all.length; i += PREPARE_BATCH) {
    writer.add(all.slice(i, i + PREPARE_BATCH));
    shared.end();
    writer.endBatch();
  }
  const buildings = writer.finish();
  // The other kinds as `RoadDoc.fromJSON` would read them (a malformed record dropped, a lot's building only while it stands, a wire only between poles that stand), each kind one table; their lists left empty in their places.
  const items: LandscapeItem[] = [];
  for (const raw of data.landscape ?? []) { const item = landscapeRecord(raw, repair); if (item) items.push(item); }
  const standing = new RecordTable(buildings);
  const seen = new Set<number>();
  const lots: Lot[] = [];
  for (const lot of data.lots ?? []) {
    if (!isLot(lot) || seen.has(lot.id)) continue;
    seen.add(lot.id);
    lots.push(lotRecord(lot, (id) => standing.row(id) >= 0));
  }
  const poles: UtilityPole[] = (data.poles ?? []).map((p) => poleRecord(p, repair));
  const poleIds = new Set<number>(poles.map((p) => p.id));
  const spans: UtilitySpan[] = [];
  for (const s of data.poleSpans ?? []) if (poleIds.has(s.a) && poleIds.has(s.b)) spans.push({ id: asSpanId(s.id), a: asPoleId(s.a), b: asPoleId(s.b) });
  const table = <T extends { readonly id: number }>(records: readonly T[], place: ((row: T) => { x: number; y: number }) | null = null): ArrayBufferLike | null => (records.length ? encodeRecords(records, place).buffer : null);
  return {
    data: {
      ...data, buildings: [],
      ...(data.landscape ? { landscape: [] } : {}), ...(data.lots ? { lots: [] } : {}),
      ...(data.poles ? { poles: [] } : {}), ...(data.poleSpans ? { poleSpans: [] } : {}),
    },
    buildings,
    landscape: table(items),
    // The lots with their box and summary columns (`lotSummary.ts`), as the store's own table holds them (`LotStore.tableOf`).
    lots: lots.length ? encodeRecords(lots, lotCentre, lotBounds, lotSummaryColumns()).buffer : null,
    poles: table(poles),
    spans: table(spans, spanPlace),
  };
}

/**
 * A CITY'S BUILDINGS PREPARED AS `prepareCity` PREPARES THEM, A BATCH AT A TIME AS THEY ARE MADE (`smallCityMap.ts` buildCityTable): each
 * migrated, the first of an id kept, settled and written to the page's table (`TableWriter`), the records let go. The same records as
 * `prepareCity`'s table (the members a building shares with others written once a batch, not once a city: the same values).
 */
export class PreparedCityWriter {
  /** Each row's box on the ground in its columns (`RowBox`): the page files the city by place from them, no record decoded (`BuildingStore` grid). */
  private readonly table = new TableWriter<Building>(true, null, (b) => buildingBounds(b), buildingSummaryColumns());
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

/** The tables a city opens with (`restoreInto`): its buildings' and the other kinds' (null: those records in the data, or none), each one table or a map's squares' (`TableBase`). */
export interface OpenedTables extends Readonly<Record<CityTable, TableBase | null>> {
  readonly buildings: TableBase | null;
  /** The field written over a table's rows (the buildings' wears saved since their squares): its records the table's (`TableSections.field`). */
  readonly fields?: Partial<Record<DocTable, FieldWrites>>;
}

/** A city as the page opens it; `table`: its buildings' table (`prepareCity`), the document's source of truth as it is, null: its buildings are in `data`; the other kinds' tables likewise. */
export interface OpenedCity extends OpenedTables {
  readonly data: SerializedDoc;
  readonly table: ArrayBufferLike | null;
}

/** No table of any kind beside the buildings'. */
export function noCityTables(): CityTables {
  const out = {} as Record<CityTable, ArrayBufferLike | null>;
  for (const name of CITY_TABLES) out[name] = null;
  return out;
}

/** A prepared city as the page opens it; `beside`: the other kinds' tables, those not given none. DO NOT decode its tables here (every record an object, ~8 KB of heap a building): the document reads a row when asked. */
export function preparedCity(data: SerializedDoc, table: ArrayBufferLike, beside: Partial<CityTables> = {}): OpenedCity {
  return { data: { ...data, buildings: [] }, table, buildings: table, ...noCityTables(), ...beside };
}

/** The tables of an opened city, as `restoreInto` takes them. */
export function openedTables(city: OpenedCity): OpenedTables {
  const out = { buildings: city.table } as Record<DocTable, TableBase | null>;
  for (const name of CITY_TABLES) out[name] = city[name];
  return out;
}

/** Whether `tables` is the set of an opened city's tables (`OpenedTables`) rather than one buildings' table. */
export function isOpenedTables(tables: OpenedTables | ArrayBufferLike): tables is OpenedTables {
  return !(tables instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && tables instanceof SharedArrayBuffer);
}

/** How many buildings an opened city has, in its data or its table. */
export function openedBuildings(city: OpenedCity): number {
  return (city.data.buildings?.length ?? 0) + (city.table ? new RecordTable(city.table).rows : 0);
}
