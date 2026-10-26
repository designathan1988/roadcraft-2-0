/** What a thread's owner uses of a worker (a page's `Worker`, or one in another process over a port, `jobs/processWorker.ts`): the job pool's and the simulation's workers are written for this shape. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}
