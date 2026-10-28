import { RecordTable, type TableReader, TableWriter, type RowBox, type RowPlace, type RowSummary, type TableRow, tableIn, tableRecords } from '@world/buildings/recordTable';
import type { TableBase } from '@world/buildings/tableRows';
import type { FieldWrites } from '@world/buildings/items';
import type { DocTable } from '@world/docBinary';
import type { GlobalPart, SavedGlobals, SerializedDoc } from '@world/doc';
import { REGION_CODEC, type SquareSections, squareFrame } from './regionFrames';
import { JSON_CODEC, type SquareBlob, type SquareCodec, withWear } from './tileCodec';
import { KEYED, KEYED_NAMES, type KeyedName, type LayerName, type ListName, type RetiredName } from './saveLayers';

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
  /** An old save's squares of the lists the game no longer has (`RETIRED_LISTS`) too: never read. */
  readonly squares: Partial<Record<LayerName | RetiredName, readonly string[]>>;
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
  /** The keys of an old save's squares of the lists the game no longer has (`RETIRED_LISTS`), in this format: removed by the next save. */
  readonly retired?: readonly string[];
  /** The squares of a kind kept in a table stored before its box or summary columns, as this format writes them (`upgraded`): stored again when the map is adopted (`TiledSaves.adopt`), so the next opening copies their rows as they are. */
  readonly upgraded?: readonly UpgradedSquare[];
}

/** A square stored before its kind's columns, written again in this format: its layer, its key and its frame (`squareFrame`). */
export interface UpgradedSquare {
  readonly layer: KeyedName;
  readonly square: string;
  readonly frame: ArrayBuffer;
}

/** The tables a map read back from its squares holds its records in (the kinds kept in tables): each kind's squares' tables and their rows' order (`TableBase`), nothing joined; a kind absent has its records in the document (a save before manifest 8). */
export type SavedTables = Partial<Record<DocTable, TableBase>>;

/** The numeric field written over a kind's joined rows (`TableSections.field`): the buildings' stored wears, their rows copied as they are. */
export type SavedFields = Partial<Record<DocTable, FieldWrites>>;

/** What a tiled save reads back. */
export interface TiledSession {
  readonly document: SerializedDoc;
  readonly tables: SavedTables;
  /** The field written over a table's rows where its stored value differs from the row's own (a building's wear saved since its square). */
  readonly fields?: SavedFields;
  /** How long its parts of the read took off the page, ms: the squares decompressed and read, the kinds' tables joined. */
  readonly timing?: { readonly squares: number; readonly join: number; readonly read: number; readonly inflate: number; readonly parse: number; readonly mb: number };
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
 * A kind's squares as the map's tables (`TableBase`): each square's table as it was read, in shared memory (`tableIn`: the page's workers read
 * its rows where they stand), and the order of the store's rows over them - by id (the lots in their stored order, then by id), as the map
 * read as records always held them. A building whose stored wear differs from its row's stands as its row, its wear the field written over
 * it (`field`, `TableItems.writeField`). DO NOT join them into one table: the 10 km city's buildings were 687 MB copied row by row at every
 * opening (~7 s), the squares' tables and the copy held at once (2026-10-27); nor decode and write again a building for its wear (its
 * 249,122 buildings were, the day before).
 */
function joined(name: KeyedName, squares: readonly { table: RecordTable; orders: Float64Array | null; square: string }[], wears: ReadonlyMap<number, number>): { base: TableBase; field: FieldWrites | null } {
  const starts = new Uint32Array(squares.length + 1);
  squares.forEach(({ table }, t) => { starts[t + 1] = starts[t]! + table.rows; });
  const n = starts[squares.length]!;
  // Each row's id and stored order, by its number over the squares' tables.
  const ids = new Float64Array(n), orders = new Float64Array(n);
  squares.forEach(({ table, orders: own }, t) => {
    ids.set(table.ids, starts[t]!);
    if (own) orders.set(own, starts[t]!);
  });
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort(name === 'lots' ? (a, b) => orders[a]! - orders[b]! || ids[a]! - ids[b]! : (a, b) => ids[a]! - ids[b]!);
  /** The wears that differ from their rows', as (id, decay) pairs: the field over the tables. */
  const worn: number[] = [];
  if (name === 'buildings' && wears.size) {
    for (const { table } of squares) {
      let reader: TableReader | null = null;
      for (let row = 0; row < table.rows; row++) {
        const id = table.ids[row]!;
        const wear = wears.get(id);
        if (wear === undefined) continue;
        const decay = (reader ??= table.reader()).field(row, 'decay');
        if ((typeof decay === 'number' ? decay : 0) !== wear) worn.push(id, wear);
      }
    }
  }
  // One square: its table alone, the order its own where its rows stand in it.
  let ordered = true;
  for (let i = 0; i < n && ordered; i++) ordered = order[i] === i;
  const tables = squares.map(({ table }) => tableIn(table.buffer));
  const base: TableBase = tables.length === 1 && ordered ? tables[0]! : { tables, order: ordered ? null : order };
  return { base, field: worn.length ? { name: 'decay', pairs: Float64Array.from(worn) } : null };
}

/** The map of `read`'s blobs (see the file's comment), or null when a blob is missing or unreadable. */
export async function decodeSquares(read: SquaresRead): Promise<TiledSession | null> {
  const { manifest, squares: blobs, wearSquares, got, old } = read;
  const started = performance.now();
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
  const tableRead = new Map<KeyedName, { table: RecordTable; orders: Float64Array | null; square: string }[]>();
  const listRead = new Map<ListName, { item: unknown; ord: number; square: string }[]>();
  /** Wall time of each phase of the squares, ms, and the bytes stored: their blobs read, decompressed, their frames and records read. */
  const phase = { read: 0, inflate: 0, parse: 0, bytes: 0 };
  // DO NOT wait for each square's decompression before starting the next (EDT-03: hundreds, one after the other, at the opening): a batch at a time in flight, read in the same order.
  for (let i = 0; i < blobs.length; i += GUNZIP_BATCH) {
    const batch: Blob[] = [];
    for (let k = i; k < Math.min(blobs.length, i + GUNZIP_BATCH); k++) {
      const blob = got[k];
      if (!blob) return null;
      batch.push(blob);
    }
    let values: (SquareBlob | SquareSections | null)[];
    if (read.codec === 'region') {
      let at = performance.now();
      const raws = await Promise.all(batch.map(async (blob) => new Uint8Array(await blob.arrayBuffer())));
      phase.read += performance.now() - at;
      for (const raw of raws) phase.bytes += raw.byteLength;
      at = performance.now();
      values = await Promise.all(raws.map((raw) => REGION_CODEC.squareOf(raw)));
      phase.inflate += performance.now() - at;
    } else values = await Promise.all(batch.map((blob) => codec.square(blob)));
    const parsed = performance.now();
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
          list.push({ table: new RecordTable(value.table.slice().buffer), orders: value.orders, square });
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
    phase.parse += performance.now() - parsed;
  }
  const squaresMs = performance.now() - started;
  // A kind with a square in JSON beside its tables (a save of two formats): every record of it as an object, the tables decoded too.
  const tables: SavedTables = {};
  const fields: SavedFields = {};
  const upgraded: UpgradedSquare[] = [];
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
    // A square stored before its kind's box or summary columns: its rows copied into a table of this format (what it lacks worked out once, here), joined from it, and handed back to be stored so.
    const box = spec.box as RowBox<TableRow> | undefined;
    const summary = (spec.summary?.() ?? null) as RowSummary<TableRow> | null;
    for (const entry of squares) {
      if (!((box && !entry.table.boxes) || (summary && entry.table.summaryWidth !== summary.width))) continue;
      const writer = new TableWriter<TableRow>(false, spec.columns as RowPlace<TableRow> | undefined ?? null, box ?? null, summary);
      writer.copyRows(entry.table, Array.from({ length: entry.table.rows }, (_, row) => row));
      const buffer = writer.finish().buffer as ArrayBuffer;
      entry.table = new RecordTable(buffer);
      upgraded.push({ layer: name, square: entry.square, frame: squareFrame(buffer, entry.orders ? Array.from(entry.orders) : null) });
    }
    const made = joined(name, squares, wears);
    tables[spec.table!] = made.base;
    if (made.field) fields[spec.table!] = made.field;
  }
  const timing = { squares: squaresMs, join: performance.now() - started - squaresMs, read: phase.read, inflate: phase.inflate, parse: phase.parse, mb: phase.bytes / 1048576 };
  for (const [name, out] of keyedRead) out.sort(name === 'lots' ? (a, b) => a.order - b.order || a.id - b.id : (a, b) => a.id - b.id);
  for (const out of listRead.values()) out.sort((a, b) => a.ord - b.ord);
  const records = (name: KeyedName): unknown[] => (keyedRead.get(name) ?? []).map((e) => e.record);
  const items = (name: ListName): unknown[] => (listRead.get(name) ?? []).map((e) => e.item);
  // An old save's fog settings (the painted fog left the game, MISSION.md item 4): dropped.
  const { fogSettings: _fog, gullyAuto, ...rest } = globals as SavedGlobals & Record<string, unknown>;
  const document = {
    ...rest,
    nodes: records('nodes'), segments: records('segments'), terrain: items('stamps'), paint: items('paint'),
    gullies: { dabs: items('gullies'), ...(gullyAuto !== undefined ? { auto: gullyAuto } : {}) },
    elements: items('elements'), trees: items('trees'), treeClearings: items('clearings'),
    poles: records('poles'), poleSpans: records('spans'), landscape: records('landscape'), barriers: records('barriers'),
    buildings: records('buildings'), zones: items('zones'), zoneMarks: items('zoneMarks'), lots: records('lots'), lotKeys: rest.lotKeys ?? [],
  } as unknown as SerializedDoc;
  // A format before this one: nothing of it is this format's layout, the next save writes every square.
  if (old) return { document, tables, fields, timing, settings: manifest.settings, savedAt: manifest.savedAt, layout: { old, squares: {}, globals: [], lists: {} } };
  const lists: Partial<Record<ListName, { ords: number[]; squares: string[] }>> = {};
  for (const [name, out] of listRead) lists[name] = { ords: out.map((e) => e.ord), squares: out.map((e) => e.square) };
  return {
    document, tables, fields, timing, settings: manifest.settings, savedAt: manifest.savedAt,
    layout: { old: null, squares: manifest.squares, globals: manifest.globals, lists, ...(upgraded.length ? { upgraded } : {}) },
  };
}
