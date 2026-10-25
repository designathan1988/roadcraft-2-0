import { vi } from 'vitest';

import type { CellJob } from '@render/buildings/cellWork';
import type { ToJob } from '@/jobs/jobScope';

type CellWorkModule = typeof import('@render/buildings/cellWork');

/** A stand-in for a module worker that runs the cells' jobs as `cell.worker.ts` does, with a `cellWork.ts` of its own (its own heap: its own
 *  programs kept, `keptPrograms`). Stubbed as the global `Worker` (`vi.stubGlobal`); its jobs run when the test drains it. */
export class CellWorker {
  static made: CellWorker[] = [];
  readonly waiting: ToJob[] = [];
  /** The jobs it ran: their kind and cell. */
  readonly ran: string[] = [];
  /** The jobs it ran as sent. */
  readonly jobs: CellJob[] = [];
  work: CellWorkModule | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() { CellWorker.made.push(this); }
  postMessage(message: ToJob): void { this.waiting.push(message); }
  terminate(): void {}
  /** Its jobs run through and answered, one at a time as a worker does. */
  async drain(): Promise<void> {
    if (!this.work) {
      // A module graph of its own: its programs are this worker's alone.
      vi.resetModules();
      this.work = await import('@render/buildings/cellWork');
    }
    while (this.waiting.length) {
      const message = this.waiting.shift()!;
      // Its message as a worker gets it: a copy (structured clone), nothing shared with the page's objects.
      const job = structuredClone(message.data) as CellJob;
      this.ran.push(`${job.kind} ${job.cell}`);
      this.jobs.push(job);
      const reply = this.work.runCellJob(job, this.work.workerReads(job));
      this.onmessage!({ data: { port: message.port, data: reply, seq: message.seq } });
    }
  }

  /** Every worker's jobs run, the page's promises let run between (a level asked looks its slices up first, `cellPool.ts` send), till none waits. */
  static async drainAll(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      await new Promise((go) => setTimeout(go, 0));
      if (!CellWorker.made.some((w) => w.waiting.length)) {
        await new Promise((go) => setTimeout(go, 0));
        if (!CellWorker.made.some((w) => w.waiting.length)) return;
      }
      for (const w of CellWorker.made) await w.drain();
    }
    throw new Error('the cell workers never ran dry');
  }
}
