import { tableRecords } from '@world/buildings/recordTable';
import {
  GLOBAL_MAGIC, MANIFEST_MAGIC, SQUARE_MAGIC, WEAR_MAGIC, f64Bytes, f64Of, gunzipBytes, inflated, jsonBytes, jsonOf, packFrame, readFrame,
} from './saveBinary';

/** THE FRAMES OF A MAP SAVED AS BINARY REGIONS (`chunkedSave.ts` manifests 6 to 8): a square's records (a kind kept in a table its record table, cut from the map's without decoding; a kind kept as objects its records' JSON) and their places in the order as doubles, a square's wears as doubles, a part kept outside the squares and the manifest as JSON - each one frame known by its magic word (`saveBinary.ts`) */

/** The sections: records as JSON or as a record table, their places in the order; a value's JSON; numbers in pairs. */
const K_JSON = 1, K_TABLE = 2, K_ORDERS = 3, K_PAIRS = 1;

/** A stored square: its records (`r`) and, for a list or the lots, their places in the order (`o`). */
export interface SquareRecords { readonly r: readonly unknown[]; readonly o?: readonly number[] }

/** A stored square as its bytes: its records as a record table (`table`, a kind kept in a table) or as their JSON (`json`), and their places in the order. */
export interface SquareSections { readonly table: Uint8Array | null; readonly json: Uint8Array | null; readonly orders: Float64Array | null }

/** A square's frame: `records` a record table's buffer (no text of them, nothing decoded), or a list of records as their JSON; the order as doubles. */
export function squareFrame(records: ArrayBufferLike | readonly unknown[], orders: readonly number[] | null | undefined): ArrayBuffer {
  const body = Array.isArray(records)
    ? { kind: K_JSON, bytes: jsonBytes(records) }
    : { kind: K_TABLE, bytes: new Uint8Array(records as ArrayBufferLike) };
  return packFrame(SQUARE_MAGIC, orders ? [body, { kind: K_ORDERS, bytes: f64Bytes(orders) }] : [body]);
}

/** A square's frame as its sections, nothing decoded (a table joined into the map's, `chunkedSave.ts` readSquares); null when the bytes are not one. */
export function readSquareSections(bytes: Uint8Array): SquareSections | null {
  const frame = readFrame(bytes, SQUARE_MAGIC);
  if (!frame) return null;
  const table = frame.get(K_TABLE) ?? null, json = frame.get(K_JSON) ?? null, orders = frame.get(K_ORDERS);
  if (!table && !json) return null;
  const o = orders ? f64Of(orders) : null;
  if (orders && !o) return null;
  return { table, json, orders: o };
}

/** A square's frame read back as records (`squareFrame`), a table's decoded; null when the bytes are not one. */
export function readSquareFrame(bytes: Uint8Array): SquareRecords | null {
  const sections = readSquareSections(bytes);
  if (!sections) return null;
  // The table in a buffer of its own: its columns are read from offset 0 (`RecordTable`).
  const r: unknown = sections.table ? tableRecords(sections.table.slice().buffer) : jsonOf(sections.json!);
  const o = sections.orders;
  if (!Array.isArray(r) || (o && o.length !== r.length)) return null;
  return o ? { r, o: Array.from(o) } : { r };
}

/** A square's wears: each building's id and decay (0: none), as doubles in pairs (`pairs`: id, decay, id, decay...). */
export function wearFrame(pairs: readonly number[]): ArrayBuffer {
  return packFrame(WEAR_MAGIC, [{ kind: K_PAIRS, bytes: f64Bytes(pairs) }]);
}

/** Wears read back, by id; null when the bytes are not a wears' frame. */
function readWearFrame(bytes: ArrayBuffer): Map<number, number> | null {
  const pairs = readFrame(bytes, WEAR_MAGIC)?.get(K_PAIRS);
  const values = pairs ? f64Of(pairs) : null;
  if (!values || values.length % 2 !== 0) return null;
  const out = new Map<number, number>();
  for (let i = 0; i < values.length; i += 2) out.set(values[i]!, values[i + 1]!);
  return out;
}

/** A small value (a part kept outside the squares, the manifest) as a frame of its JSON. */
export const valueFrame = (magic: typeof GLOBAL_MAGIC | typeof MANIFEST_MAGIC, value: unknown): ArrayBuffer =>
  packFrame(magic, [{ kind: K_JSON, bytes: jsonBytes(value) }]);
/** A value's frame read back; null when the bytes are not one of `magic`. */
export function readValueFrame(bytes: ArrayBufferLike | Uint8Array, magic: typeof GLOBAL_MAGIC | typeof MANIFEST_MAGIC): unknown {
  const body = readFrame(bytes, magic)?.get(K_JSON);
  return body ? jsonOf(body) : null;
}

/** How a stored square, wears and part of the binary regions are read back from their blobs (the squares and parts compressed by the writer). */
export const REGION_CODEC = {
  square: async (blob: Blob): Promise<SquareSections | null> => readSquareSections(await gunzipBytes(blob)),
  /** A square's sections from its stored bytes already read (`squaresDecode.ts`: the read, the decompression and the frame timed apart). */
  squareOf: async (raw: Uint8Array): Promise<SquareSections | null> => readSquareSections(await inflated(raw)),
  wears: async (blob: Blob): Promise<Map<number, number> | null> => readWearFrame(await blob.arrayBuffer()),
  global: async (blob: Blob): Promise<unknown> => readValueFrame(await gunzipBytes(blob), GLOBAL_MAGIC),
};

export { GLOBAL_MAGIC, MANIFEST_MAGIC };
