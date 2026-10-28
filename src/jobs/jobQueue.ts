import type { JobService } from './jobScope';

/** THE JOB POOL'S QUEUE (`jobPool.ts`): the jobs asked of it, waiting for a worker, by their rank. */

/** A job of the central queue (Cidade's job pool, `submit`): its message written when a worker takes it, answered once. */
export interface JobSpec {
  readonly service: JobService;
  /** A newer job with the same key replaces this one: never sent if still waiting, its answer dropped if begun. */
  readonly key: string | null;
  /** Lower first: the job's distance to the eye (`focusDistance`), in metres, or below it for what must come first; with `at`, its band (what comes before the distance, the same for a kind of job). */
  readonly priority: number;
  /** Where on the map the job's work stands: its rank is `priority` plus its distance to where the view looks NOW, re-ranked as the view moves (`setJobFocus`), not where it looked when the job was asked. */
  readonly at?: readonly [number, number];
  /** The message, written only when a worker takes the job (a job waiting its turn holds no copy of it); `to`, the worker taking it. */
  readonly write: (to: JobTaker) => { readonly data: unknown; readonly transfer: Transferable[] };
  /** Fit for a worker in a desktop job process (`processWorker.ts`): its message holds only what the job reads (`cellPool.ts` the ground's plates around it), copied there. Without it the job waits for the page's own workers. */
  readonly crosses?: boolean;
  /** What the job's worker keeps for the next job of the same affinity (`cellWork.ts` the buildings' programs, a worker's own heap): the job goes
   *  to the worker that ran the last one (`owners`) while it is free, the jobs after it in the queue run first while it is busy (`AFFINITY_LOOK`). */
  readonly affinity?: string;
  readonly done: (answer: unknown) => void;
  /** Its worker failed, or none can run it: the asker does it another way. */
  readonly failed: (message: string) => void;
}

/** The worker a job's message is written for: whether it shares the page's memory (a worker of the page), or every shared buffer of the message is copied to it (a desktop job process's, `processWorker.ts` unshared). */
interface JobTaker { readonly sharesMemory: boolean }

/** A job in the queue: waiting, running on a worker, or over (answered, cancelled or replaced by a newer one of its key). */
export interface Queued { readonly seq: number; readonly spec: JobSpec; state: 'waiting' | 'running' | 'over'; rank: number }

const less = (a: Queued, b: Queued): boolean => a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq);

/** A binary min-heap of queued jobs by (rank, order asked); a job replaced or cancelled is left in it and skipped when popped. */
class JobHeap {
  readonly items: Queued[] = [];

  /** The waiting job at its top, those over popped first; null when none waits. */
  top(): Queued | null {
    while (this.items.length > 0 && this.items[0]!.state !== 'waiting') this.pop();
    return this.items[0] ?? null;
  }

  /** The heap made again of its waiting jobs alone (Floyd's build-heap, O(n)), each ranked again first by `rank` when given. */
  compact(rank: ((spec: JobSpec) => number) | null): void {
    const a = this.items;
    let n = 0;
    for (const job of a) {
      if (job.state !== 'waiting') continue;
      if (rank) job.rank = rank(job.spec);
      a[n++] = job;
    }
    a.length = n;
    for (let i = (n >> 1) - 1; i >= 0; i--) this.sink(i);
  }

  push(job: Queued): void {
    const a = this.items;
    a.push(job);
    let i = a.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!less(a[i]!, a[up]!)) break;
      [a[i], a[up]] = [a[up]!, a[i]!];
      i = up;
    }
  }

  pop(): Queued | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (top === undefined || last === undefined || a.length === 0) return top;
    a[0] = last;
    this.sink(0);
    return top;
  }

  /** The job at `i` moved down until both children are after it. */
  private sink(i: number): void {
    const a = this.items;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < a.length && less(a[l]!, a[m]!)) m = l;
      if (r < a.length && less(a[r]!, a[m]!)) m = r;
      if (m === i) return;
      [a[i], a[m]] = [a[m]!, a[i]!];
      i = m;
    }
  }
}

/**
 * ONE PRIORITY QUEUE FOR EVERY WORKER, by (priority, order asked), kept as two heaps: the jobs only the page's own threads run, and those fit
 * to cross to a job process (`JobSpec.crosses`). The first in rank of both runs first; while no worker can take it, the first of those fit to
 * cross goes to a job process that stands free (`awayTop`, `dispatch`). DO NOT keep them in one heap read from its top alone: the 10 km city's
 * street furniture (fit to cross) waited behind the cover's and the gardens' cells, which only the page's one free short worker could run,
 * while 18 job processes stood idle - 241 jobs waiting, the furniture never drawn (2026-10-27).
 */
export class JobQueue {
  private readonly page = new JobHeap();
  private readonly away = new JobHeap();
  /** Each key's newest job, while it is not over. */
  private readonly newest = new Map<string, Queued>();
  private seq = 0;
  private count = 0;

  /** `rankOf`: a job's place now (`jobPool.ts`: its band and its distance to where the view looks). */
  constructor(private readonly rankOf: (spec: JobSpec) => number) {}

  /** Jobs waiting for a worker. */
  get waiting(): number {
    return this.count;
  }

  /** The waiting jobs by service, and how many of each are fit to cross (read only: the debugging lab). */
  waitingBy(): Record<string, { readonly page: number; readonly away: number }> {
    const out: Record<string, { page: number; away: number }> = {};
    for (const [heap, side] of [[this.page, 'page'], [this.away, 'away']] as const) {
      for (const job of heap.items) if (job.state === 'waiting') (out[job.spec.service] ??= { page: 0, away: 0 })[side]++;
    }
    return out;
  }

  /** Jobs ever asked of the queue (read only: the debugging lab). */
  get submitted(): number {
    return this.seq;
  }

  submit(spec: JobSpec): Queued {
    const job: Queued = { seq: ++this.seq, spec, state: 'waiting', rank: this.rankOf(spec) };
    if (spec.key !== null) {
      const older = this.newest.get(spec.key);
      if (older) this.end(older);
      this.newest.set(spec.key, job);
    }
    this.count++;
    this.heapOf(job).push(job);
    // DO NOT let the jobs over (replaced or cancelled) pile up in the heaps: they are left in them and skipped when popped, and a camera moving replaces thousands a second (the far nodes and the cells asked again under their keys), each dispatch popping them one by one (500 ms of a 16 s drag, 2026-10-16); compacted once they outnumber the waiting.
    if (this.page.items.length + this.away.items.length > this.count * 2 + 64) {
      this.page.compact(null);
      this.away.compact(null);
    }
    return job;
  }

  /** Every waiting job placed by where the view looks now (`setJobFocus`), the heaps made again. */
  rerank(): void {
    this.page.compact(this.rankOf);
    this.away.compact(this.rankOf);
  }

  /** The waiting job that would run next, left waiting; null when none waits. */
  peek(): Queued | null {
    const a = this.page.top(), b = this.away.top();
    return a && b ? (less(a, b) ? a : b) : a ?? b;
  }

  /** The first in rank of the waiting jobs fit to cross to a job process, left waiting; null when none waits. */
  awayTop(): Queued | null {
    return this.away.top();
  }

  /** Of the first `look` entries of each heap (their top levels), the first in rank of the waiting jobs `fits` takes; null when none. */
  near(look: number, fits: (job: Queued) => boolean): Queued | null {
    let best: Queued | null = null;
    for (const heap of [this.page.items, this.away.items]) {
      for (let i = 0; i < heap.length && i < look; i++) {
        const job = heap[i]!;
        if (job.state === 'waiting' && (best === null || less(job, best)) && fits(job)) best = job;
      }
    }
    return best;
  }

  /** A waiting job marked running out of its turn (`near`, `awayTop`): left in its heap, skipped when popped (as one replaced). */
  takeThis(job: Queued): void {
    if (job.state !== 'waiting') return;
    this.count--;
    job.state = 'running';
  }

  /** The waiting job to run next, marked running; null when none waits. */
  take(): Queued | null {
    const job = this.peek();
    if (!job) return null;
    this.heapOf(job).pop();
    this.count--;
    job.state = 'running';
    return job;
  }

  cancel(job: Queued): void {
    this.end(job);
  }

  /** A running job's answer, handed to its asker if it is still wanted. */
  answer(job: Queued, data: unknown): void {
    if (this.end(job) === 'running') job.spec.done(data);
  }

  /** A running job that failed, said to its asker if it is still wanted. */
  fail(job: Queued, message: string): void {
    if (this.end(job) === 'running') job.spec.failed(message);
  }

  /** Every waiting job failed: no worker can run them. */
  failAll(message: string): void {
    for (let job = this.take(); job; job = this.take()) this.fail(job, message);
  }

  private heapOf(job: Queued): JobHeap {
    return job.spec.crosses === true ? this.away : this.page;
  }

  /** The job over; what it was. */
  private end(job: Queued): Queued['state'] {
    const was = job.state;
    if (was === 'waiting') this.count--;
    job.state = 'over';
    if (job.spec.key !== null && this.newest.get(job.spec.key) === job) this.newest.delete(job.spec.key);
    return was;
  }
}
