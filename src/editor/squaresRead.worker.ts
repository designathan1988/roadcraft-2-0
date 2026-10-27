import type { JobScope } from '../jobs/jobScope';
import { baseBuffers, baseOrder } from '@world/buildings/tableRows';
import { type SquaresRead, type TiledSession, decodeSquares } from './squaresDecode';

/** A SAVED MAP'S SQUARES DECODED OFF THE PAGE (`squaresDecode.ts`, asked by `chunkedSave.ts` readSquares): the map read from its blobs, its tables handed back, not copied. */

export interface SquaresReadAsk { readonly id: number; readonly read: SquaresRead }
export type SquaresReadReply = { readonly id: number; readonly session: TiledSession | null } | { readonly id: number; readonly error: string };

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<SquaresReadAsk>) => {
    const { id, read } = event.data;
    decodeSquares(read).then((session) => {
      // Each kind's tables (a square's each, `TableBase`) and their order: moved where they are plain buffers (shared ones are shared by the post).
      const transfer: ArrayBuffer[] = [];
      for (const base of Object.values(session?.tables ?? {})) {
        if (!base) continue;
        for (const buffer of baseBuffers(base)) if (buffer instanceof ArrayBuffer) transfer.push(buffer);
        const order = baseOrder(base);
        if (order && order.buffer instanceof ArrayBuffer) transfer.push(order.buffer);
      }
      // The fields over them (the buildings' wears): moved too.
      for (const field of Object.values(session?.fields ?? {})) if (field) transfer.push(field.pairs.buffer as ArrayBuffer);
      // The squares written again in this format (`SavedLayout.upgraded`): their frames moved too, never copied.
      for (const square of session?.layout.upgraded ?? []) transfer.push(square.frame);
      scope.postMessage({ id, session } satisfies SquaresReadReply, transfer);
    }, (error: unknown) => {
      console.error('[save] the saved map could not be decoded', error);
      scope.postMessage({ id, error: String((error as Error)?.stack ?? error) } satisfies SquaresReadReply);
    });
  };
}
