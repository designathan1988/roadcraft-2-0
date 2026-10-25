import type { JobScope } from '../../jobs/jobScope';
import { MeshoptSimplifier } from 'meshoptimizer';
import { levelBuffers, partLevelArrays, type PartArrays, type Weld } from '../partLevelsWork';

/** A vehicle part's levels made whole here (`partLevelsWork.ts`): welded, simplified, creased. */
export interface PartRequest { readonly id: number; readonly kind: 'part'; readonly part: PartArrays; readonly weld: Weld }

/** The levels' service of the job system (`job.worker.ts`): each vehicle part's request answered off the page. (The people's levels are in
 *  their own ready files, `public/models/citizens/people`: nothing of a person is simplified in play.) */
export function serve(self: JobScope): void {
  self.onmessage = async (e: MessageEvent<PartRequest>) => {
    const req = e.data;
    // Every request answered, a failure too (`lodPool.ts` rejects it)
    try {
      await MeshoptSimplifier.ready;
      const part = partLevelArrays(req.part, req.weld);
      self.postMessage({ id: req.id, part }, levelBuffers(part));
    } catch (error) {
      console.error('[lod worker]', error);
      self.postMessage({ id: req.id, error: String(error) }, []);
    }
  };
}
