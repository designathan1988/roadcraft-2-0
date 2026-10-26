import { EMPTY_SECTIONS, type TableSections, sectionsBytes } from './buildings/sections';

/** THE MAP AS BINARY SECTIONS, NEVER ONE TEXT (report "Arquitetura para cidades grandes", "A conta de memória": V8 strings stop near 512 MiB; region files of offsets and lengths, each section read on its own): each part of the map's JSON one short UTF-8 section (a long list cut in runs), the buildings their table and what was written over it (`BuildingSections`). An undo of a whole map keeps the same image unpacked (`DocImage`), the buildings' table shared with the map it was, never copied. */

/** A part of the map as `RoadDoc.toJSON` writes it: one key's value, or a run of a long list's items; its JSON in UTF-8. */
interface DocPart {
  readonly name: string;
  /** Of a list cut in runs: this run's items, appended to the runs before it of the same name. */
  readonly run: boolean;
  readonly bytes: Uint8Array;
}

/** The map unpacked: its parts in `toJSON`'s order, its buildings, its landscaping and its lots as buffers (`TableSections`: their tables shared, the records written over them encoded). */
export interface DocImage {
  readonly parts: readonly DocPart[];
  readonly buildings: TableSections;
  readonly landscape: TableSections;
  readonly lots: TableSections;
}

/** The items of a list written in one section: a run's text stays far below the string ceiling whatever the map's size. */
const RUN = 20_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The map's JSON (no buildings; the landscaping and the lots as empty lists where they go as tables) and its tables as an image: each key's JSON on its own, a long list in runs. */
export function imageOf(data: object, buildings: TableSections, landscape: TableSections = EMPTY_SECTIONS, lots: TableSections = EMPTY_SECTIONS): DocImage {
  const parts: DocPart[] = [];
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined || name === 'buildings') continue;
    if (Array.isArray(value) && value.length > RUN) {
      for (let i = 0; i < value.length; i += RUN) parts.push({ name, run: true, bytes: encoder.encode(JSON.stringify(value.slice(i, i + RUN))) });
    } else {
      parts.push({ name, run: false, bytes: encoder.encode(JSON.stringify(value)) });
    }
  }
  return { parts, buildings, landscape, lots };
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
  let bytes = sectionsBytes(image.buildings) + sectionsBytes(image.landscape) + sectionsBytes(image.lots);
  for (const part of image.parts) bytes += part.bytes.byteLength;
  return bytes;
}

// ------------------------------------------------------------------ the file

const MAGIC = 0x42444352; // 'RCDB'
const FORMAT = 1;
/** Section kinds: the parts, then each table's four (base, gone, replaced, added) from its first kind on: the buildings' from 3, the landscaping's from 7, the lots' from 11 (a map opened with them in tables, 2026-10-26; a file without them holds those records in its parts). */
const S_PART = 1, S_RUN = 2, S_BASE = 3, S_LAND = 7, S_LOTS = 11;
const K_BASE = 0, K_GONE = 1, K_REPLACED = 2, K_ADDED = 3;
/** Header words: magic, format, sections; then per section: kind, name length, offset, length. */
const HEAD = 3, ENTRY = 4;
const align8 = (n: number): number => Math.ceil(n / 8) * 8;

/** Whether bytes are a map in this binary form (the stores also keep texts: a save before it). */
export function isDocBinary(bytes: ArrayBufferLike): boolean {
  if (bytes.byteLength < HEAD * 4) return false;
  const head = new Uint32Array(bytes, 0, 2);
  return head[0] === MAGIC && head[1] === FORMAT;
}

/** An image packed in one buffer: a directory of sections (kind, name, offset, length), each section 8-byte aligned. Deterministic: the same image, the same bytes. */
export function packImage(image: DocImage): ArrayBuffer {
  const sections: { kind: number; name: Uint8Array; bytes: Uint8Array }[] = [];
  const none = new Uint8Array(0);
  for (const part of image.parts) sections.push({ kind: part.run ? S_RUN : S_PART, name: encoder.encode(part.name), bytes: part.bytes });
  const add = (kind: number, buffer: ArrayBufferLike | null): void => { if (buffer) sections.push({ kind, name: none, bytes: new Uint8Array(buffer) }); };
  const addSections = (first: number, s: TableSections): void => {
    add(first + K_BASE, s.base);
    if (s.gone.length) sections.push({ kind: first + K_GONE, name: none, bytes: new Uint8Array(s.gone.buffer, s.gone.byteOffset, s.gone.byteLength) });
    add(first + K_REPLACED, s.replaced);
    add(first + K_ADDED, s.added);
  };
  addSections(S_BASE, image.buildings);
  addSections(S_LAND, image.landscape);
  addSections(S_LOTS, image.lots);
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

/** An image read back from its buffer: each section its own copy (the buildings' tables in buffers of their own, as the store keeps them). */
export function unpackImage(buffer: ArrayBufferLike, own: (bytes: Uint8Array) => ArrayBufferLike = (bytes) => bytes.slice().buffer): DocImage {
  if (!isDocBinary(buffer)) throw new Error('[save] not a map in binary sections of this format');
  const words = new Uint32Array(buffer, 0, HEAD);
  const count = words[2]!;
  const dir = new Uint32Array(buffer, 0, HEAD + count * ENTRY);
  const parts: DocPart[] = [];
  interface Read { base: ArrayBufferLike | null; gone: Float64Array; replaced: ArrayBufferLike | null; added: ArrayBufferLike | null }
  const fresh = (): Read => ({ base: null, gone: new Float64Array(0), replaced: null, added: null });
  const tables: Record<number, Read> = { [S_BASE]: fresh(), [S_LAND]: fresh(), [S_LOTS]: fresh() };
  for (let i = 0; i < count; i++) {
    const w = HEAD + i * ENTRY;
    const kind = dir[w]!, nameLength = dir[w + 1]!, nameAt = dir[w + 2]!, length = dir[w + 3]!;
    const bodyAt = align8(nameAt + nameLength);
    const body = new Uint8Array(buffer, bodyAt, length);
    if (kind === S_PART || kind === S_RUN) {
      parts.push({ name: decoder.decode(new Uint8Array(buffer, nameAt, nameLength).slice()), run: kind === S_RUN, bytes: body.slice() });
      continue;
    }
    const first = kind >= S_LOTS ? S_LOTS : kind >= S_LAND ? S_LAND : S_BASE;
    const table = tables[first]!;
    switch (kind - first) {
      case K_BASE: table.base = own(body); break;
      case K_GONE: table.gone = new Float64Array(body.slice().buffer); break;
      case K_REPLACED: table.replaced = own(body); break;
      case K_ADDED: table.added = own(body); break;
      default: throw new Error(`[save] a map in binary sections holds an unknown section ${kind}`);
    }
  }
  return { parts, buildings: tables[S_BASE]!, landscape: tables[S_LAND]!, lots: tables[S_LOTS]! };
}
