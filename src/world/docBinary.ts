import { EMPTY_SECTIONS, type TableSections, sectionsBytes } from './buildings/sections';
import { type TableBase, baseBuffers, baseOrder } from './buildings/tableRows';

/** THE MAP AS BINARY SECTIONS, NEVER ONE TEXT (report "Arquitetura para cidades grandes", "A conta de memória": V8 strings stop near 512 MiB; region files of offsets and lengths, each section read on its own): each part of the map's JSON one short UTF-8 section (a long list cut in runs), the records of each kind kept in a table (`DOC_TABLES`) their table and what was written over it (`TableSections`). An undo of a whole map keeps the same image unpacked (`DocImage`), the tables shared with the map it was, never copied. */

/** A part of the map as `RoadDoc.toJSON` writes it: one key's value, or a run of a long list's items; its JSON in UTF-8. */
interface DocPart {
  readonly name: string;
  /** Of a list cut in runs: this run's items, appended to the runs before it of the same name. */
  readonly run: boolean;
  readonly bytes: Uint8Array;
}

/** The kinds of record a map keeps in tables (the document reads one when asked, never holding the whole map's as objects): the buildings', the landscaping's, the lots', the poles' and the wires' (`poleSpans`). In the order of their section kinds (`firstKind`). */
export const DOC_TABLES = ['buildings', 'landscape', 'lots', 'poles', 'spans'] as const;
export type DocTable = (typeof DOC_TABLES)[number];
/** Each kind's records as buffers. */
export type DocTables = Readonly<Record<DocTable, TableSections>>;

/** The map unpacked: its parts in `toJSON`'s order, and its tables (`TableSections`: their tables shared, the records written over them encoded). */
export interface DocImage {
  readonly parts: readonly DocPart[];
  readonly tables: DocTables;
}

/** The items of a list written in one section: a run's text stays far below the string ceiling whatever the map's size. */
const RUN = 20_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Every kind's sections, those not given empty. */
export function docTables(given: Partial<DocTables>): DocTables {
  const out = {} as Record<DocTable, TableSections>;
  for (const name of DOC_TABLES) out[name] = given[name] ?? EMPTY_SECTIONS;
  return out;
}

/** The map's JSON (no buildings; the records of the other tables as empty lists where they go as tables) and its tables as an image: each key's JSON on its own, a long list in runs. */
export function imageOf(data: object, tables: Partial<DocTables>): DocImage {
  const parts: DocPart[] = [];
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined || name === 'buildings') continue;
    if (Array.isArray(value) && value.length > RUN) {
      for (let i = 0; i < value.length; i += RUN) parts.push({ name, run: true, bytes: encoder.encode(JSON.stringify(value.slice(i, i + RUN))) });
    } else {
      parts.push({ name, run: false, bytes: encoder.encode(JSON.stringify(value)) });
    }
  }
  return { parts, tables: docTables(tables) };
}

/** The map's JSON (no buildings) read back from an image: the keys in their order, the runs of a list joined. */
export function dataOf(image: DocImage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of image.parts) {
    const value: unknown = JSON.parse(decoder.decode(part.bytes));
    if (part.run && Array.isArray(out[part.name])) { for (const item of value as unknown[]) (out[part.name] as unknown[]).push(item); continue; }
    out[part.name] = value;
  }
  return out;
}

/** What an image holds, bytes. */
export function imageBytes(image: DocImage): number {
  let bytes = 0;
  for (const name of DOC_TABLES) bytes += sectionsBytes(image.tables[name]);
  for (const part of image.parts) bytes += part.bytes.byteLength;
  return bytes;
}

// ------------------------------------------------------------------ the file

const MAGIC = 0x42444352; // 'RCDB'
/** 2 (2026-10-27): a table's base as several tables (a map's squares', `TableBase`), each a base section in its rows' order, and the order of
 *  the store's rows (`S_ORDERS`); a file of format 1 (one table a base) is still read. */
const FORMAT = 2;
const FIRST_FORMAT = 1;
/** Section kinds: the parts, then each table's four (base, gone, replaced, added) from its first kind on (`firstKind`): the buildings' from 3, the landscaping's from 7, the lots' from 11, the poles' from 15, the wires' from 19 (2026-10-26; a file without a table's sections holds those records in its parts). */
const S_PART = 1, S_RUN = 2, S_TABLES = 3;
const K_BASE = 0, K_GONE = 1, K_REPLACED = 2, K_ADDED = 3, KINDS_A_TABLE = 4;
const firstKind = (name: DocTable): number => S_TABLES + DOC_TABLES.indexOf(name) * KINDS_A_TABLE;
/** A table's field written over its rows (`TableSections.field`: its name the section's, its (id, value) pairs the body), after every table's four: the buildings' 23, the landscaping's 24, and on (2026-10-26). */
const S_FIELDS = S_TABLES + DOC_TABLES.length * KINDS_A_TABLE;
/** The order of a table's rows over its base's tables (`TableBase` order), after every table's field: the buildings' 28, the landscaping's 29, and on (format 2). */
const S_ORDERS = S_FIELDS + DOC_TABLES.length;
/** Header words: magic, format, sections; then per section: kind, name length, offset, length. */
const HEAD = 3, ENTRY = 4;
const align8 = (n: number): number => Math.ceil(n / 8) * 8;

/** Whether bytes are a map in this binary form (the stores also keep texts: a save before it). */
export function isDocBinary(bytes: ArrayBufferLike): boolean {
  if (bytes.byteLength < HEAD * 4) return false;
  const head = new Uint32Array(bytes, 0, 2);
  return head[0] === MAGIC && head[1]! >= FIRST_FORMAT && head[1]! <= FORMAT;
}

/** An image packed in one buffer: a directory of sections (kind, name, offset, length), each section 8-byte aligned. Deterministic: the same image, the same bytes. */
export function packImage(image: DocImage): ArrayBuffer {
  const sections: { kind: number; name: Uint8Array; bytes: Uint8Array }[] = [];
  const none = new Uint8Array(0);
  for (const part of image.parts) sections.push({ kind: part.run ? S_RUN : S_PART, name: encoder.encode(part.name), bytes: part.bytes });
  const add = (kind: number, buffer: ArrayBufferLike | null): void => { if (buffer) sections.push({ kind, name: none, bytes: new Uint8Array(buffer) }); };
  for (const name of DOC_TABLES) {
    const first = firstKind(name), s = image.tables[name];
    // Its base's tables in their rows' order, each a section, and the store's order of their rows.
    if (s.base) for (const buffer of baseBuffers(s.base)) add(first + K_BASE, buffer);
    const order = s.base ? baseOrder(s.base) : null;
    if (order) sections.push({ kind: S_ORDERS + DOC_TABLES.indexOf(name), name: none, bytes: new Uint8Array(order.buffer, order.byteOffset, order.byteLength) });
    if (s.gone.length) sections.push({ kind: first + K_GONE, name: none, bytes: new Uint8Array(s.gone.buffer, s.gone.byteOffset, s.gone.byteLength) });
    add(first + K_REPLACED, s.replaced);
    add(first + K_ADDED, s.added);
    if (s.field) sections.push({ kind: S_FIELDS + DOC_TABLES.indexOf(name), name: encoder.encode(s.field.name), bytes: new Uint8Array(s.field.pairs.buffer, s.field.pairs.byteOffset, s.field.pairs.byteLength) });
  }
  let at = align8((HEAD + sections.length * ENTRY) * 4);
  const places = sections.map((s) => {
    const name = at; at = align8(at + s.name.byteLength);
    const body = at; at = align8(at + s.bytes.byteLength);
    return { name, body };
  });
  const out = new ArrayBuffer(at);
  const words = new Uint32Array(out, 0, HEAD + sections.length * ENTRY);
  const bytes = new Uint8Array(out);
  words[0] = MAGIC; words[1] = FORMAT; words[2] = sections.length;
  sections.forEach((s, i) => {
    const w = HEAD + i * ENTRY;
    words[w] = s.kind; words[w + 1] = s.name.byteLength; words[w + 2] = places[i]!.name; words[w + 3] = s.bytes.byteLength;
    bytes.set(s.name, places[i]!.name);
    bytes.set(s.bytes, places[i]!.body);
  });
  return out;
}

/** An image read back from its buffer: each section its own copy (the tables in buffers of their own, as the store keeps them). */
export function unpackImage(buffer: ArrayBufferLike, own: (bytes: Uint8Array) => ArrayBufferLike = (bytes) => bytes.slice().buffer): DocImage {
  if (!isDocBinary(buffer)) throw new Error('[save] not a map in binary sections of this format');
  const words = new Uint32Array(buffer, 0, HEAD);
  const count = words[2]!;
  const dir = new Uint32Array(buffer, 0, HEAD + count * ENTRY);
  const parts: DocPart[] = [];
  interface Read { bases: ArrayBufferLike[]; order: Uint32Array | null; gone: Float64Array; replaced: ArrayBufferLike | null; added: ArrayBufferLike | null; field?: { name: string; pairs: Float64Array } }
  const tables = {} as Record<DocTable, Read>;
  for (const name of DOC_TABLES) tables[name] = { bases: [], order: null, gone: new Float64Array(0), replaced: null, added: null };
  for (let i = 0; i < count; i++) {
    const w = HEAD + i * ENTRY;
    const kind = dir[w]!, nameLength = dir[w + 1]!, nameAt = dir[w + 2]!, length = dir[w + 3]!;
    const bodyAt = align8(nameAt + nameLength);
    const body = new Uint8Array(buffer, bodyAt, length);
    if (kind === S_PART || kind === S_RUN) {
      parts.push({ name: decoder.decode(new Uint8Array(buffer, nameAt, nameLength).slice()), run: kind === S_RUN, bytes: body.slice() });
      continue;
    }
    if (kind >= S_ORDERS) {
      const owner = DOC_TABLES[kind - S_ORDERS];
      if (!owner) throw new Error(`[save] a map in binary sections holds an unknown section ${kind}`);
      tables[owner].order = new Uint32Array(body.slice().buffer);
      continue;
    }
    if (kind >= S_FIELDS) {
      const owner = DOC_TABLES[kind - S_FIELDS];
      if (!owner) throw new Error(`[save] a map in binary sections holds an unknown section ${kind}`);
      tables[owner].field = { name: decoder.decode(new Uint8Array(buffer, nameAt, nameLength).slice()), pairs: new Float64Array(body.slice().buffer) };
      continue;
    }
    const name = DOC_TABLES[Math.floor((kind - S_TABLES) / KINDS_A_TABLE)];
    if (kind < S_TABLES || !name) throw new Error(`[save] a map in binary sections holds an unknown section ${kind}`);
    const table = tables[name];
    switch ((kind - S_TABLES) % KINDS_A_TABLE) {
      case K_BASE: table.bases.push(own(body)); break;
      case K_GONE: table.gone = new Float64Array(body.slice().buffer); break;
      case K_REPLACED: table.replaced = own(body); break;
      case K_ADDED: table.added = own(body); break;
    }
  }
  const sections = {} as Record<DocTable, TableSections>;
  for (const name of DOC_TABLES) {
    const { bases, order, ...rest } = tables[name];
    const base: TableBase | null = bases.length === 0 ? null : bases.length === 1 && !order ? bases[0]! : { tables: bases, order };
    sections[name] = { base, ...rest };
  }
  return { parts, tables: sections };
}
