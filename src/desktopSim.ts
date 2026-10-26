import { ProcessWorker, type WorkerLike } from './jobs/processWorker';

/** THE DESKTOP'S SIMULATION PROCESS: the simulation's worker as a thread of a utility process of the shell (`desktop/main.cjs` sim:connect, `desktop/jobs.cjs`, `src/nodeSimHost.ts`), a V8 cage of its own, so a 10 km city's lane graph, walkways and network of the simulation no longer fill the page's (V8 pointer compression: one cage a process, the page and its workers sharing it); none in a browser (the page's own `Worker`, `sim/host/simClient.ts`). */

interface SimBridge { connectSim(): void }

/** The window messages the preload hands on (`desktop/preload.cjs`): the thread's port, and the process stopped. */
const PORT_MESSAGE = 'roadcraft:sim-port';
const LOST_MESSAGE = 'roadcraft:sim-lost';

/** What makes the simulation's worker on the desktop (`SimClient.useWorkerMaker`); null where the page has no desktop shell, or one without the simulation process. */
export function desktopSimWorker(): (() => WorkerLike) | null {
  const bridge = (window as unknown as { roadcraftDesktop?: Partial<SimBridge> }).roadcraftDesktop;
  if (!bridge || typeof bridge.connectSim !== 'function') return null;
  const connect = (): void => bridge.connectSim!();
  // Each port asked is handed the next that comes, in order (the shell answers each `connectSim` with one).
  const asked: ((port: MessagePort) => void)[] = [];
  const living = new Set<ProcessWorker>();
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data === PORT_MESSAGE && event.ports[0]) { asked.shift()?.(event.ports[0]); return; }
    // The process stopped: the client's worker fails as a worker does (the game says the simulation failed, `SimClient.failure`).
    if (event.data === LOST_MESSAGE) for (const worker of [...living]) worker.fail('the simulation process stopped');
  });
  return () => {
    let made: ProcessWorker | null = null;
    made = new ProcessWorker(() => new Promise<MessagePort>((resolve) => {
      asked.push((port) => { if (made) living.add(made); resolve(port); });
      connect();
    }));
    return made;
  };
}
