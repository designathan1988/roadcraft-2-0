import type { Group, Texture } from 'three';
import FILES from 'virtual:model-urls/citizens/people?ext=bin,ktx2';
import { uncookInWorker } from '../bakePool';
import { readKtx2 } from '../ktx2Texture';
import { assemblePerson, decodeCookedPerson, type CookedHeader } from './cookedPerson';

/** THE CAST'S PEOPLE, READ (`cookedPerson.ts`): the sixteen ready files of `public/models/citizens/people`, a body (`<id>.bin`, its levels
 *  in it) and its atlas (`<id>.ktx2`) each, served as they are and read on demand, the body in a worker, the atlas as a KTX2 texture. */

/** A file of the folder (`model-urls-plugin.ts`): a build gives it a URL named by its bytes' hash, so a changed file is never read from a stale cache. */
function fileUrl(name: string): string {
  const url = FILES[name];
  if (!url) throw new Error(`public/models/citizens/people/${name} is not in this build`);
  return new URL(url, location.href).href;
}

/** A person as read: the scene with its bones and skinned mesh, what the file says of it, and its atlas. */
export interface CookedPersonLoaded {
  readonly scene: Group;
  readonly header: CookedHeader;
  readonly atlas: Texture;
}

/** Person `id` of the cast, read. */
export async function loadCookedPerson(id: string): Promise<CookedPersonLoaded> {
  const url = fileUrl(`${id}.bin`);
  // Read in a worker, its arrays moved here; read here only where no worker can.
  const decoded = await uncookInWorker(url) ?? await (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return decodeCookedPerson(await response.arrayBuffer()).person;
  })();
  const header = decoded.header;
  const atlasResponse = await fetch(fileUrl(header.atlas.file));
  if (!atlasResponse.ok) throw new Error(`${header.atlas.file}: ${atlasResponse.status}`);
  const atlas = await readKtx2(await atlasResponse.arrayBuffer(), header.atlas.codec, 'color');
  atlas.name = `person-atlas-${id}`;
  return { scene: assemblePerson(decoded), header, atlas };
}
