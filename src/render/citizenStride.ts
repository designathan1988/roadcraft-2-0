import { Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { clipTransferFor, type LibraryClip, type NeutralWalk, type WalkAmplitude } from './citizenWalk';

/** Bake-time stride warping. */
export function directionalWalkFor(rig: Object3D, mesh: SkinnedMesh, clip: LibraryClip,
  amplitude: WalkAmplitude, angle: number): NeutralWalk & { readonly strideScale: number } {
  const walk = clipTransferFor(rig, mesh, clip, amplitude);
  const legs = ['L', 'R'].map(side => {
    const bones = ['Thigh', 'Calf', 'Foot'].map(part => rig.getObjectByName(`Bip01_${side}_${part}`));
    if (bones.some(bone => !bone)) throw new Error(`Citizen has no ${side} leg for stride warping`);
    return { thigh: bones[0]!, calf: bones[1]!, foot: bones[2]!, mean: new Vector3() };
  });
  // Use the source sample count so both feet's centres are independent of the animation phase at which a particular body
  const samples = clip.source.file.frames.length;
  const feet: Vector3[][] = [];
  const soles = footVertices(rig);
  // How far each drawn foot reaches inward of its own bone, the most over the clip: a sole is not centred on its ankle, and it turns.
  const inward = [0, 0];
  for (let i = 0; i < samples; i++) {
    walk.pose(i * clip.duration / samples);
    const positions = legs.map(leg => leg.foot.getWorldPosition(new Vector3()));
    positions.forEach((p, j) => legs[j]!.mean.add(p));
    feet.push(positions);
    const reach = inwardReach(soles, positions[0]!.x, positions[1]!.x);
    inward[0] = Math.max(inward[0]!, reach[0]); inward[1] = Math.max(inward[1]!, reach[1]);
  }
  for (const leg of legs) leg.mean.multiplyScalar(1 / samples);
  const sin = Math.sin(angle), cos = Math.cos(angle);
  const origins = legs.map(leg => leg.mean.clone());
  let strideScale = 1;
  if (Math.abs(sin) > Math.abs(cos)) {
    const clearance = inward[0]! + inward[1]!;
    walk.pose(0);
    const hips = Math.abs(legs[0]!.thigh.getWorldPosition(new Vector3()).x - legs[1]!.thigh.getWorldPosition(new Vector3()).x);
    const centre = (origins[0]!.x + origins[1]!.x) / 2;
    // A side step needs room for the following foot.
    const stance = Math.max(origins[0]!.x - origins[1]!.x, hips + clearance);
    legs[0]!.mean.x = centre + stance / 2;
    legs[1]!.mean.x = centre - stance / 2;
    let closing = 0;
    for (const pair of feet) {
      const dx = (pair[1]!.x - origins[1]!.x) - (pair[0]!.x - origins[0]!.x);
      const dz = (pair[1]!.z - origins[1]!.z) - (pair[0]!.z - origins[0]!.z);
      closing = Math.max(closing, dx * cos + dz * sin);
    }
    if (closing > 0) strideScale = Math.min(1, Math.max(0, (stance - clearance) / closing));
  }
  return {
    scale: walk.scale,
    lowestAt: walk.lowestAt,
    strideScale,
    pose(time) {
      walk.pose(time);
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i]!, origin = origins[i]!;
        const at = leg.foot.getWorldPosition(new Vector3());
        const orientation = leg.foot.getWorldQuaternion(new Quaternion());
        const dx = at.x - origin.x, dz = at.z - origin.z;
        const target = new Vector3(leg.mean.x + (dx * cos + dz * sin) * strideScale, at.y,
          leg.mean.z + (-dx * sin + dz * cos) * strideScale);
        reach(leg.thigh, leg.calf, leg.foot, target);
        const parent = leg.foot.parent!.getWorldQuaternion(new Quaternion());
        leg.foot.quaternion.copy(parent.invert().multiply(orientation));
        leg.foot.updateMatrixWorld(true);
      }
    },
  };
}

/** The drawn feet's vertices, shoe meshes included: each weighted more than half to a foot or its toes, and its side (0 left, 1 right). */
interface Soles { readonly meshes: readonly { readonly mesh: SkinnedMesh; readonly vertices: readonly number[]; readonly sides: readonly number[] }[] }

function footVertices(rig: Object3D): Soles {
  const meshes: { mesh: SkinnedMesh; vertices: number[]; sides: number[] }[] = [];
  rig.traverse(o => {
    if (!(o instanceof SkinnedMesh)) return;
    const skin = o.geometry.attributes['skinIndex'], weight = o.geometry.attributes['skinWeight'];
    if (!skin || !weight) return;
    const sides = o.skeleton.bones.map(b => /Bip01_L_(Foot|Toe)/.test(b.name) ? 0 : /Bip01_R_(Foot|Toe)/.test(b.name) ? 1 : -1);
    const found = { mesh: o, vertices: [] as number[], sides: [] as number[] };
    for (let i = 0; i < skin.count; i++) {
      const shares = [0, 0];
      for (let k = 0; k < 4; k++) {
        const side = sides[skin.getComponent(i, k)] ?? -1;
        if (side >= 0) shares[side]! += weight.getComponent(i, k);
      }
      const side = shares[0]! > 0.5 ? 0 : shares[1]! > 0.5 ? 1 : -1;
      if (side >= 0) { found.vertices.push(i); found.sides.push(side); }
    }
    meshes.push(found);
  });
  if (![0, 1].every(side => meshes.some(m => m.sides.includes(side)))) throw new Error('Citizen has no weighted foot surface for lateral stride');
  return { meshes };
}

/** How far each drawn foot reaches past its own bone towards the other foot across x, in the posed rig: the left sole's least x under
 *  the left foot bone's, the right sole's greatest x over the right one's. DO NOT halve the feet's widths instead: a sole is not centred
 *  on its ankle, and the side step put the two shoes 0.5 mm into each other. */
function inwardReach(soles: Soles, leftFootX: number, rightFootX: number): [number, number] {
  const reach: [number, number] = [-Infinity, -Infinity];
  const point = new Vector3();
  for (const { mesh, vertices, sides } of soles.meshes) {
    mesh.skeleton.update();
    vertices.forEach((v, i) => {
      mesh.getVertexPosition(v, point); mesh.localToWorld(point);
      if (sides[i] === 0) reach[0] = Math.max(reach[0], leftFootX - point.x);
      else reach[1] = Math.max(reach[1], point.x - rightFootX);
    });
  }
  return reach;
}

function aim(bone: Object3D, child: Vector3, target: Vector3): void {
  const origin = bone.getWorldPosition(new Vector3());
  const from = child.clone().sub(origin).normalize(), to = target.clone().sub(origin).normalize();
  const rotation = new Quaternion().setFromUnitVectors(from, to).multiply(bone.getWorldQuaternion(new Quaternion()));
  const parent = bone.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
  bone.quaternion.copy(parent.invert().multiply(rotation));
  bone.updateMatrixWorld(true);
}

function reach(thigh: Object3D, calf: Object3D, foot: Object3D, target: Vector3): void {
  const hip = thigh.getWorldPosition(new Vector3()), knee = calf.getWorldPosition(new Vector3()), ankle = foot.getWorldPosition(new Vector3());
  const upper = hip.distanceTo(knee), lower = knee.distanceTo(ankle);
  const direction = target.clone().sub(hip);
  const distance = Math.min(upper + lower - 1e-6, Math.max(Math.abs(upper - lower) + 1e-6, direction.length()));
  direction.normalize();
  const bend = new Vector3(0, 0, 1).addScaledVector(direction, -direction.z).normalize();
  const along = (upper * upper + distance * distance - lower * lower) / (2 * distance);
  const across = Math.sqrt(Math.max(0, upper * upper - along * along));
  const joint = hip.clone().addScaledVector(direction, along).addScaledVector(bend, across);
  aim(thigh, knee, joint);
  aim(calf, foot.getWorldPosition(new Vector3()), hip.clone().addScaledVector(direction, distance));
}
