import { parentPort } from 'node:worker_threads';
import { ThreadSelf } from './threadSelf';

/** A JOB WORKER AS A THREAD OF THE DESKTOP'S JOB PROCESS (`desktop/jobs.cjs`): the page's `job.worker.ts` as it is, its `self` the thread's port (`threadSelf.ts`), built for Node (`scripts/vite/desktop-jobs.config.ts`) */

if (!parentPort) throw new Error('the job host runs as a thread of a job process');
(globalThis as unknown as { self: ThreadSelf }).self = new ThreadSelf(parentPort);
await import('../job.worker');
