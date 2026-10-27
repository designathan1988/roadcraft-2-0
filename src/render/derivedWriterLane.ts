import { WriteBudget } from '@core/derivedCache';

/**
 * `value` copied for a write handed to the writer (`DerivedWriterLane.post`): every array's bytes copied into a buffer of its own (a memcpy, the
 * copy's buffer put in `transfer`), everything else as it is - the page keeps using its own arrays, the writer is handed the copies, and the
 * store clones nothing on the page. DO NOT post the value itself: the structured clone serialises it on the page, as `put` there does.
 */
export function transferCopy<T>(value: T, transfer: Transferable[], depth = 0): T {
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayBufferView & { slice?: () => ArrayBufferView };
    if (view instanceof DataView) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
      transfer.push(bytes.buffer);
      return new DataView(bytes.buffer) as unknown as T;
    }
    // A typed array's own copy: its elements in a new buffer (`TypedArray.prototype.slice`), whatever buffer it stood in.
    const copy = view.slice!();
    transfer.push(copy.buffer as ArrayBuffer);
    return copy as unknown as T;
  }
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    transfer.push(copy);
    return copy as unknown as T;
  }
  if (value instanceof Map) {
    const out = new Map();
    for (const [k, v] of value) out.set(k, transferCopy(v, transfer, depth + 1));
    return out as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => transferCopy(v, transfer, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = transferCopy((value as Record<string, unknown>)[key], transfer, depth + 1);
  return out as T;
}

/** THE PAGE'S WRITES TO THE DERIVED CACHE, HANDED TO ITS WRITER (`derivedWriter.worker.ts`) UNDER A CEILING OF BYTES IN FLIGHT: answered on each commit; past the ceiling a write is not kept (made again next time) - DO NOT post without bound, the bytes waited in the writer and the page's next session waited behind them (the V8 cage, the defect that kills the runs) */
export class DerivedWriterLane {
  private readonly budget: WriteBudget;
  private readonly open = new Map<number, (() => void)[]>();
  /** The writes posted in this task, by prefix, sent together at its end (`flush`): one commit for them all. DO NOT send each as a write of its own: a 10 km city's opening kept its road tiles one transaction each, thousands, and the cache's reads (the tiles kept, the buildings' cells) waited behind them in IndexedDB (2026-10-26). */
  private readonly batches = new Map<string, { entries: [string, unknown][]; transfer: Transferable[]; releases: (() => void)[] }>();
  /** Reads asked of the writer (`read`), by id: answered with the entries it found. */
  private readonly reads = new Map<number, (got: Map<string, unknown>) => void>();
  private next = 1;

  constructor(private readonly port: Worker, most: number) {
    this.budget = new WriteBudget(most);
    port.onmessage = (event: MessageEvent<{ readonly done?: number; readonly got?: number; readonly entries?: readonly [string, unknown][] }>) => {
      const got = event.data.got;
      if (got !== undefined) {
        this.reads.get(got)?.(new Map(event.data.entries ?? []));
        this.reads.delete(got);
        return;
      }
      const id = event.data.done;
      if (id === undefined) return;
      for (const release of this.open.get(id) ?? []) release();
      this.open.delete(id);
    };
  }

  /** Bytes posted and not committed yet. */
  get bytes(): number {
    return this.budget.bytes;
  }

  /** The entries of `keys` under `prefix`, read by the writer off the page, their arrays handed over (`derivedWriter.worker.ts`). */
  read<T>(prefix: string, keys: readonly string[]): Promise<Map<string, T>> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.reads.set(id, resolve as (got: Map<string, unknown>) => void);
      this.port.postMessage({ read: id, prefix, keys });
    });
  }

  /** `entries` posted to be kept under `prefix`, `transfer` handed over, with the others posted in this task (`batches`); false when they did not fit (nothing posted). */
  post(prefix: string, entries: readonly [string, unknown][], transfer: Transferable[], bytes: number): boolean {
    const release = this.budget.tryTake(bytes);
    if (!release) return false;
    let batch = this.batches.get(prefix);
    if (!batch) {
      this.batches.set(prefix, batch = { entries: [], transfer: [], releases: [] });
      queueMicrotask(() => this.flush(prefix));
    }
    batch.entries.push(...entries);
    batch.transfer.push(...transfer);
    batch.releases.push(release);
    return true;
  }

  /** A prefix's writes of this task sent as one (`post`), answered on their commit. */
  private flush(prefix: string): void {
    const batch = this.batches.get(prefix);
    if (!batch) return;
    this.batches.delete(prefix);
    const id = this.next++;
    this.open.set(id, batch.releases);
    this.port.postMessage({ id, prefix, entries: batch.entries }, batch.transfer);
  }
}
