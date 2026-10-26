import { jobLanes, jobPort } from '../../jobs/jobPool';
import type { PartArrays, PartLevels, Weld } from '../partLevelsWork';

/** The simplifier's lanes (`lodWorker.ts`), started once and shared: a vehicle part's levels, each asked of the lane with the fewest waiting. DO NOT keep them to one lane: the fleet's parts queued 150 deep on it at a 10 km city's opening, and the lane sharing its worker (the terrain's light) waited behind them (2026-10-26). */
export interface LodPool {
  /** A vehicle part's levels, welded, simplified and creased there (`partLevelsWork.ts`). */
  part(part: PartArrays, weld: Weld): Promise<PartLevels>;
}

/** The most lanes the simplifier takes (`jobLanes`: as many as its side may give). */
const LOD_LANES = 4;

let pool: LodPool | null | undefined;

export function lodPool(): LodPool | null {
  if (pool !== undefined) return pool;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return (pool = null);
  type Answer = { id: number; part?: PartLevels; error?: string };
  type Asked = { resolve: (answer: Answer) => void; reject: (error: Error) => void };
  let next = 1;
  const lanes = Array.from({ length: jobLanes(LOD_LANES, 'peopleLod') }, () => {
    const worker = jobPort('peopleLod');
    const waiting = new Map<number, Asked>();
    worker.onmessage = (e: MessageEvent<Answer>) => {
      const ask = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.error !== undefined) {
        console.error(`[lod worker] request ${e.data.id}: ${e.data.error}`);
        ask?.reject(new Error(`lod worker: ${e.data.error}`));
      }
      else ask?.resolve(e.data);
    };
    /** DO NOT leave them pending: a part whose levels never came was never drawn, silently, on every vehicle that has it. */
    const failAll = (why: string): void => {
      console.error(`[lod worker] ${why}`);
      for (const ask of waiting.values()) ask.reject(new Error(`lod worker: ${why}`));
      waiting.clear();
    };
    worker.onerror = (e) => { e.preventDefault(); failAll(e.message || 'error'); };
    worker.onmessageerror = () => failAll('a message could not be read');
    return { worker, waiting };
  });
  const ask = (message: Record<string, unknown>, transfer: Transferable[]): Promise<Answer> => {
    const id = next++;
    const lane = lanes.reduce((a, b) => (b.waiting.size < a.waiting.size ? b : a));
    return new Promise((resolve, reject) => {
      lane.waiting.set(id, { resolve, reject });
      lane.worker.postMessage({ id, ...message }, transfer);
    });
  };
  pool = {
    // The part's arrays are copies made for the request: sent, not copied again.
    async part(part, weld) {
      const transfer = [part.position.array.buffer, ...(part.color ? [part.color.array.buffer] : []), ...(part.normal ? [part.normal.array.buffer] : []),
        ...(part.index ? [part.index.buffer] : [])] as ArrayBuffer[];
      return (await ask({ kind: 'part', part, weld }, transfer)).part!;
    },
  };
  return pool;
}
