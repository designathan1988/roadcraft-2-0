import { RecordTable, type TableReader, TableWriter, type RowBox, type RowPlace, type TableRow, tableRecords } from '@world/buildings/recordTable';
import type { DocTable } from '@world/docBinary';
import type { GlobalPart, SavedGlobals, SerializedDoc } from '@world/doc';
import { REGION_CODEC, type SquareSections } from './regionFrames';
import { JSON_CODEC, type SquareBlob, type SquareCodec, withWear } from './tileCodec';
import { KEYED, KEYED_NAMES, type KeyedName, type LayerName, type ListName } from './saveLayers';

/**
 * A MAP SAVED BY SQUARES DECODED FROM ITS BLOBS (`chunkedSave.ts` readSquares): the squares decompressed and read, a kind kept in a table
 * joined into one table of the map row by row (`joined`), the rest as the document's records. A pure function of the blobs, run OFF THE
 * PAGE (`squaresRead.worker.ts`), the tables handed back by transfer. DO NOT decode a saved map on the page's thread: a 10 km city's
 * squares held it 18 s at every reopening, decompressed, read and joined there (2026-10-26).
 */

/** How many saved squares are decompressed at once. */
const GUNZIP_BATCH = 32;

/** A format by squares: version 5 (the tiles in JSON), 6 (binary regions of the tiles of 1,024 m), 7 (binary regions of the tiles of 1,000 m and the cells of 250 m), 8 (the same squares, every kind kept in a table as tables cut from the map's), each layer's squares by key, the parts kept outside the tiles. */
export interface TiledManifest {
  readonly version: 5 | 6 | 7 | 8;
  readonly savedAt: number;
  readonly settings: unknown;
  readonly squares: Partial<Record<LayerName, readonly string[]>>;
  readonly globals: readonly GlobalPart[];
}

/** How the map just read was stored: what `adopt` needs so the next save writes only what changes. */
export interface SavedLayout {
  /** The keys of a map saved in a format before this one (kept for an older build; the next save writes the map whole in this one); null: saved in this format. */
  readonly old: readonly string[] | null;
  readonly squares: Partial<Record<LayerName, readonly string[]>>;
  readonly globals: readonly GlobalPart[];
  /** Each list's places in the order and squares, in the order read. */
  readonly lists: Partial<Record<ListName, { readonly ords: readonly number[]; readonly squares: readonly string[] }>>;
}

/** The tables a map read back from its squares holds its records in (the kinds kept in tables), each joined from its squares without decoding; a kind absent has its records in the document (a save before manifest 8). */
export type SavedTables = Partial<Record<DocTable, ArrayBufferLike>>;

/** What a tiled save reads back. */
export interface TiledSession {
  readonly document: SerializedDoc;
  readonly tables: SavedTables;
  readonly settings: unknown;
  readonly savedAt: number;
  readonly layout: SavedLayout;
}

/** The blobs of a map by squares as the store gave them, what `decodeSquares` reads: the squares' (in `squares` order), then their wears, then the parts kept outside them. */
export interface SquaresRead {
  readonly manifest: TiledManifest;
  readonly squares: readonly { readonly layer: LayerName; readonly square: string }[];
  readonly wearSquares: readonly string[];
  readonly got: readonly (Blob | null)[];
  /** The squares' codec: binary regions, or the tiles in JSON (manifest 5). */
  readonly codec: 'region' | 'json';
  /** The keys of a format before this one (the next save writes the map whole), null: this format. */
  readonly old: readonly string[] | null;
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function idOf(record: unknown): number {
  const id = isObject(record) ? record['id'] : undefined;
  return typeof id === 'number' ? id : Number.NaN;
}

/** A square's records from what its codec read: the records themselves, or a table's decoded (a square read as records). */
function squareRecords(value: SquareBlob | SquareSections): SquareBlob | null {
  if (!('table' in value)) return value;
  const r: unknown = value.table ? tableRecords(value.table.slice().buffer) : value.json ? JSON.parse(new TextDecoder().decode(value.json)) : null;
  if (!Array.isArray(r) || (value.orders && value.orders.length !== r.length)) return null;
  return value.orders ? { r, o: Array.from(value.orders) } : { r };
}

/**
 * A kind's squares joined into one table of the map, row by row without decoding (`TableWriter.copyRows`), in id order (the lots in their
 * stored order, then by id) as the map read as records always held them; decoded and written again, a building whose stored wear differs
 * from its row's (given its wear), and a row of a square written before its kind had box columns (the lots' before 2026-10-26: their box
 * written now, `KEYED.box`, so the map reads their places from the columns, `TableItems.eachBox`).
 */
function joined(name: KeyedName, squares: readonly { table: RecordTable; orders: Float64Array | null }[], wears: ReadonlyMap<number, number>): ArrayBufferLike {
  const rows: { t: number; row: number; id: number; order: number }[] = [];
  squares.forEach(({ table, orders }, t) => { for (let row = 0; row < table.rows; row++) rows.push({ t, row, id: table.ids[row]!, order: orders?.[row] ?? 0 }); });
  rows.sort(name === 'lots' ? (a, b) => a.order - b.order || a.id - b.id : (a, b) => a.id - b.id);
  const box = KEYED[name].box as RowBox<TableRow> | undefined;
  const writer = new TableWriter<TableRow>(false, KEYED[name].columns as RowPlace<TableRow> | undefined ?? null, box ?? null);
  const readers = new Map<number, TableReader>();
  const readerOf = (t: number): TableReader => { let reader = readers.get(t); if (!reader) readers.set(t, reader = squares[t]!.table.reader()); return reader; };
  for (const { t, row, id } of rows) {
    const table = squares[t]!.table;
    if (name === 'buildings' && wears.has(id)) {
      const reader = readerOf(t);
      const decay = reader.field(row, 'decay');
      if ((typeof decay === 'number' ? decay : 0) !== wears.get(id)) { writer.add([withWear(reader.record(row), wears) as TableRow]); continue; }
    }
    if (box && !table.boxes) { writer.add([readerOf(t).record(row)]); continue; }
    writer.copyRows(table, [row]);
  }
  return writer.finish().buffer;
}

/** The map of `read`'s blobs (see the file's comment), or null when a blob is missing or unreadable. */
export async function decodeSquares(read: SquaresRead): Promise<TiledSession | null> {
  const { manifest, squares: blobs, wearSquares, got, old } = read;
  const codec: SquareCodec = read.codec === 'region' ? REGION_CODEC : JSON_CODEC;
  const globals: Record<string, unknown> = {};
  for (let i = 0; i < manifest.globals.length; i++) {
    const blob = got[blobs.length + wearSquares.length + i];
    if (!blob) return null;
    const part = await codec.global(blob);
    if (!isObject(part)) return null;
    Object.assign(globals, part);
  }
  if (globals['version'] !== 1) return null;
  // Each square's wears, where kept: laid over the records stored before them.
  const wears = new Map<number, number>();
  for (let i = 0; i < wearSquares.length; i++) {
    const blob = got[blobs.length + i];
    const worn = blob ? await codec.wears(blob) : null;
    if (worn) for (const [id, decay] of worn) wears.set(id, decay);
  }
  const keyedRead = new Map<KeyedName, { record: unknown; id: number; order: number; square: string }[]>();
  /** A kind kept in a table: each square's table and the order of its rows, joined once every square is read (`joined`). */
  const tableRead = new Map<KeyedName, { table: RecordTable; orders: Float64Array | null }[]>();
  const listRead = new Map<ListName, { item: unknown; ord: number; square: string }[]>();
  // DO NOT wait for each square's decompression before starting the next (EDT-03: hundreds, one after the other, at the opening): a batch at a time in flight, read in the same order.
  for (let i = 0; i < blobs.length; i += GUNZIP_BATCH) {
    const batch: Promise<SquareBlob | SquareSections | null>[] = [];
    for (let k = i; k < Math.min(blobs.length, i + GUNZIP_BATCH); k++) {
      const blob = got[k];
      if (!blob) return null;
      batch.push(codec.square(blob));
    }
    const values = await Promise.all(batch);
    for (let k = 0; k < values.length; k++) {
      const value = values[k];
      if (!value) return null;
      const { layer, square } = blobs[i + k]!;
      if ((KEYED_NAMES as readonly LayerName[]).includes(layer)) {
        const name = layer as KeyedName;
        if ('table' in value && value.table && KEYED[name].table) {
          // The table in a buffer of its own: its columns are read from offset 0 (`RecordTable`).
          const list = tableRead.get(name) ?? [];
          tableRead.set(name, list);
          list.push({ table: new RecordTable(value.table.slice().buffer), orders: value.orders });
          continue;
        }
        const records = squareRecords(value);
        if (!records) return null;
        const out = keyedRead.get(name) ?? [];
        keyedRead.set(name, out);
        records.r.forEach((record, j) => out.push({
          record: name === 'buildings' ? withWear(record, wears) : record, id: idOf(record), order: records.o?.[j] ?? 0, square,
        }));
      } else {
        const name = layer as ListName;
        const records = squareRecords(value);
        if (!records?.o) return null;
        const out = listRead.get(name) ?? [];
        listRead.set(name, out);
        records.r.forEach((item, j) => out.push({ item, ord: records.o![j]!, square }));
      }
    }
  }
  // A kind with a square in JSON beside its tables (a save of two formats): every record of it as an object, the tables decoded too.
  const tables: SavedTables = {};
  for (const [name, squares] of tableRead) {
    const spec = KEYED[name];
    if (keyedRead.has(name)) {
      const out = keyedRead.get(name)!;
      for (const { table, orders } of squares) {
        const records = tableRecords(table.buffer);
        records.forEach((record, j) => out.push({ record: name === 'buildings' ? withWear(record, wears) : record, id: table.ids[j]!, order: orders?.[j] ?? 0, square: '' }));
      }
      continue;
    }
    tables[spec.table!] = joined(name, squares, wears);
  }
  for (const [name, out] of keyedRead) out.sort(name === 'lots' ? (a, b) => a.order - b.order || a.id - b.id : (a, b) => a.id - b.id);
  for (const out of listRead.values()) out.sort((a, b) => a.ord - b.ord);
  const records = (name: KeyedName): unknown[] => (keyedRead.get(name) ?? []).map((e) => e.record);
  const items = (name: ListName): unknown[] => (listRead.get(name) ?? []).map((e) => e.item);
  const { fogSettings, gullyAuto, ...rest } = globals as SavedGlobals & Record<string, unknown>;
  const document = {
    ...rest,
    nodes: records('nodes'), segments: records('segments'), terrain: items('stamps'), paint: items('paint'),
    fog: { dabs: items('fog'), ...(fogSettings !== undefined ? { settings: fogSettings } : {}) },
    gullies: { dabs: items('gullies'), ...(gullyAuto !== undefined ? { auto: gullyAuto } : {}) },
    clouds: items('clouds'), elements: items('elements'), trees: items('trees'), treeClearings: items('clearings'),
    poles: records('poles'), poleSpans: records('spans'), landscape: records('landscape'), barriers: records('barriers'),
    buildings: records('buildings'), zones: items('zones'), zoneMarks: items('zoneMarks'), lots: records('lots'), lotKeys: rest.lotKeys ?? [],
  } as unknown as SerializedDoc;
  // A format before this one: nothing of it is this format's layout, the next save writes every square.
  if (old) return { document, tables, settings: manifest.settings, savedAt: manifest.savedAt, layout: { old, squares: {}, globals: [], lists: {} } };
  const lists: Partial<Record<ListName, { ords: number[]; squares: string[] }>> = {};
  for (const [name, out] of listRead) lists[name] = { ords: out.map((e) => e.ord), squares: out.map((e) => e.square) };
  return {
    document, tables, settings: manifest.settings, savedAt: manifest.savedAt,
    layout: { old: null, squares: manifest.squares, globals: manifest.globals, lists },
  };
}
