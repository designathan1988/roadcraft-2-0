import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vector3, type Object3D } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { assemblePerson, decodeCookedPerson } from '@render/people/cookedPerson';

/** The cast's bodies, read in node from their files (`public/models/citizens/people/<id>.bin`) as the game reads them (`cookedLoad.ts`). */

const people = new Map<string, Object3D>();

/** Body `name` of the cast as its file holds it: its bones and its skinned mesh, at the bind. */
function personScene(name: string): Object3D {
  const bytes = readFileSync(resolve('public/models/citizens/people', `${name}.bin`));
  const { person } = decodeCookedPerson(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return assemblePerson(person);
}

/** A fresh copy of a body at its rest pose, as `riggedCitizens.restRig` makes one. */
export function citizenRig(name: string): Promise<Object3D> {
  let scene = people.get(name);
  if (!scene) people.set(name, (scene = personScene(name)));
  const rig = clone(scene);
  rig.updateMatrixWorld(true);
  return Promise.resolve(rig);
}

/** World position of a named bone of a posed rig. */
export function bonePosition(rig: Object3D, name: string): Vector3 {
  const bone = rig.getObjectByName(name);
  if (!bone) throw new Error(`no bone ${name}`);
  return bone.getWorldPosition(new Vector3());
}
