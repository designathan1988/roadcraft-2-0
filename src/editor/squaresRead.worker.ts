import type { JobScope } from '../jobs/jobScope';
import { type SquaresRead, type TiledSession, decodeSquares } from './squaresDecode';

/** A SAVED MAP'S SQUARES DECODED OFF THE PAGE (`squaresDecode.ts`, asked by `chunkedSave.ts` readSquares): the map read from its blobs, its tables handed back, not copied. */

export interface SquaresReadAsk { readonly id: number; readonly read: SquaresRead }
export type SquaresReadReply = { readonly id: number; readonly session: TiledSession | null } | { readonly id: number; readonly error: string };

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<SquaresReadAsk>) => {
    const { id, read } = event.data;
    decodeSquares(read).then((session) => {
      const transfer = session ? Object.values(session.tables).filter((b): b is ArrayBuffer => b instanceof ArrayBuffer) : [];
      // The squares written again in this format (`SavedLayout.upgraded`): their frames moved too, never copied.
      for (const square of session?.layout.upgraded ?? []) transfer.push(square.frame);
      scope.postMessage({ id, session } satisfies SquaresReadReply, transfer);
    }, (error: unknown) => {
      console.error('[save] the saved map could not be decoded', error);
      scope.postMessage({ id, error: String((error as Error)?.stack ?? error) } satisfies SquaresReadReply);
    });
  };
}
