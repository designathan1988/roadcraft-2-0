import { gunzip } from './saveStore';

/** THE TILES SAVED IN JSON READ BACK (`chunkedSave.ts` manifest 5), AND THE WEARS KEPT BESIDE A SAVE'S BUILDINGS (every format's) */

/** A stored blob of a layer's square: its records (`r`) and, for a list or the lots, their places in the order (`o`). */
export interface SquareBlob { readonly r: readonly unknown[]; readonly o?: readonly number[] }
function isSquareBlob(value: unknown): value is SquareBlob {
  if (typeof value !== 'object' || value === null) return false;
  const { r, o } = value as Record<string, unknown>;
  return Array.isArray(r) && (o === undefined || (Array.isArray(o) && o.length === r.length));
}

/** How a format's blobs are read back. */
export interface SquareCodec {
  square(blob: Blob): Promise<SquareBlob | null>;
  wears(blob: Blob): Promise<Map<number, number> | null>;
  global(blob: Blob): Promise<unknown>;
}

/** The tiles in JSON (manifest 5): gzip texts, the wears plain. */
export const JSON_CODEC: SquareCodec = {
  async square(blob) {
    const value: unknown = JSON.parse(await gunzip(blob));
    return isSquareBlob(value) ? value : null;
  },
  async wears(blob) { return readWears(await blob.text()); },
  async global(blob) { return JSON.parse(await gunzip(blob)) as unknown; },
};

/** Wears read back, by id; null when they cannot be read (the records' own wear stands). */
export function readWears(text: string): Map<number, number> | null {
  const pairs: unknown = JSON.parse(text);
  if (!Array.isArray(pairs) || pairs.length % 2 !== 0 || !pairs.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const out = new Map<number, number>();
  for (let i = 0; i < pairs.length; i += 2) out.set(pairs[i] as number, pairs[i + 1] as number);
  return out;
}

/** A stored record with the wear kept for it laid over (no `decay` when it has none, as a record never worn). */
export function withWear(record: unknown, wears: ReadonlyMap<number, number>): unknown {
  if (typeof record !== 'object' || record === null) return record;
  const r = record as { id?: unknown; decay?: number };
  const decay = typeof r.id === 'number' ? wears.get(r.id) : undefined;
  if (decay === undefined || decay === (r.decay ?? 0)) return record;
  const { decay: _was, ...rest } = r;
  return decay === 0 ? rest : { ...rest, decay };
}
