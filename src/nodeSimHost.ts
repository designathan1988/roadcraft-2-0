import { parentPort } from 'node:worker_threads';
import { ThreadSelf } from './jobs/threadSelf';

/** THE SIMULATION AS A THREAD OF THE DESKTOP'S SIMULATION PROCESS (`desktop/jobs.cjs` run for `desktop/main.cjs` sim:connect): the page's `sim/sim.worker.ts` as it is, its `self` the thread's port (`jobs/threadSelf.ts`), so the whole map's lane graph, walkways and network of the simulation live in that process's V8 cage, not the page's (V8 pointer compression: one cage a process; the page's workers share the page's). Built for Node beside the job host (`scripts/vite/desktop-jobs.config.ts`). */

if (!parentPort) throw new Error('the simulation host runs as a thread of the simulation process');
(globalThis as unknown as { self: ThreadSelf }).self = new ThreadSelf(parentPort);
await import('./sim/sim.worker');
