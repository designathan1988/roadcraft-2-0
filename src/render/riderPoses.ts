import { Box3, Bone, Matrix4, Object3D, Quaternion, SkinnedMesh, Vector3 } from 'three';

/** Poses for people sitting in and on vehicles, built on the citizens' own skeleton by inverse kinematics. */

export type RiderClipKey =
  | 'carDrive' | 'carDriveMirror' | 'carDriveRight' | 'carDead' | 'cabDead'
  | 'carRide' | 'carRideLeft' | 'carRideRight'
  | 'carRearRide' | 'carRearLeft' | 'carRearRight'
  | 'cabDrive' | 'cabDriveMirror' | 'cabDriveRight'
  | 'cabRide' | 'cabRideLeft' | 'cabRideRight'
  | 'chairSit' | 'chairSitLeft' | 'chairSitRight' | 'chairSitPhone'
  | 'motoRide' | 'motoLeft' | 'motoRight' | 'motoStop'
  | 'bikePedal' | 'bikeLeft' | 'bikeRight' | 'bikeStop';

export interface RiderClip {
  readonly key: RiderClipKey;
  /** Seconds of the baked clip. A pedalling clip is one crank revolution. */
  readonly duration: number;
  readonly loop: boolean;
  /** Poses the rig at `time`; the rig starts from its rest pose each frame. */
  pose(rig: Object3D, time: number): void;
}

/** Targets for one pose, in metres in the pelvis frame. */
interface Targets {
  /** Forward lean of the trunk, radians (negative reclines). */
  readonly lean: number;
  /** Twist of the trunk towards the left, radians. */
  readonly twist?: number;
  readonly leftFoot: V3;
  readonly rightFoot: V3;
  readonly leftHand: V3;
  readonly rightHand: V3;
  /** Pole the knees bend towards (forward and up for a seated person). */
  readonly kneePole?: V3;
  /** Pole the elbows bend towards (down and out). */
  readonly elbowPole?: V3;
  /** Head pitch to keep the eyes on the road, radians (positive looks down). */
  readonly look?: number;
  /** Head turn, radians, positive to the left; shared between the neck and the head. */
  readonly turn?: number;
  /** The hands hold the bars: a body whose arms do not reach them from where the trunk put its shoulders leans on until they do (`reachForBars`).
   *  Never in a seat, whose hands rest where they fall. */
  readonly reach?: true;
}

type V3 = readonly [number, number, number];

/** Seconds of a seated person's idle loop (`occupants.ts` plays it from each person's own point). */
export const SEATED_IDLE = 6;

// ---------------------------------------------------------------- steering wheels

/** A steering wheel, from the hip point, metres: its centre ahead and above, the tilt of its rim from vertical */
export interface WheelSpec {
  readonly forward: number;
  readonly up: number;
  readonly tilt: number;
  readonly radius: number;
}

/** A car's wheel, per the vehicle spec */
export const DRIVER_WHEEL: WheelSpec = { forward: 0.46, up: 0.36, tilt: 0.45, radius: 0.185 };

/** A bus's or a truck's wheel: large, laid back towards flat */
export const CAB_WHEEL: WheelSpec = { forward: 0.42, up: 0.13, tilt: 1.0, radius: 0.22 };

/** A point on the rim of a wheel, pelvis frame (+X left, +Y up, +Z forward) */
function rimPoint(clock: number, wheel: WheelSpec = DRIVER_WHEEL): V3 {
  const { forward, up, tilt, radius } = wheel;
  const across = Math.sin(clock) * radius;
  const along = Math.cos(clock) * radius;
  return [across, up + along * Math.cos(tilt), forward - along * Math.sin(tilt)];
}

// ---------------------------------------------------------------- two-wheelers

/** Where a rider sits on a two-wheeler and what they hold and stand on, metres. */
export interface TwoWheelerFit {
  /** Height of the pelvis bone over the road. */
  readonly pelvisY: number;
  /** How far the pelvis bone sits above the saddle's top: the seat of the trousers. */
  readonly saddleDrop: number;
  /** The centre of each grip. */
  readonly grip: { readonly side: number; readonly up: number; readonly forward: number };
  /** The steering axis, ahead of the pelvis: the bars turn about it. */
  readonly steerAxis: number;
  /** A motorcycle's footpegs. */
  readonly peg?: { readonly side: number; readonly up: number; readonly forward: number };
  /** A bicycle's bottom bracket, and its cranks. */
  readonly bracket?: { readonly up: number; readonly forward: number };
  readonly crank?: number;
  /** Pedal centres either side of the frame. */
  readonly pedalSide?: number;
  /** Stopped, the machine tilts this far towards the rider's left foot, which is down. */
  readonly stopTilt: number;
  /** Where that foot is put down: out from the centre line, and a little ahead of the pelvis. */
  readonly footDown: { readonly side: number; readonly forward: number };
}

export const MOTO_FIT: TwoWheelerFit = {
  pelvisY: 0.96,
  saddleDrop: 0.1,
  grip: { side: 0.31, up: 0.2, forward: 0.52 },
  steerAxis: 0.8,
  peg: { side: 0.24, up: -0.6, forward: 0.1 },
  stopTilt: 0.14,
  footDown: { side: 0.42, forward: 0.12 },
};

export const BIKE_FIT: TwoWheelerFit = {
  pelvisY: 0.98,
  saddleDrop: 0.08,
  grip: { side: 0.27, up: 0.1, forward: 0.52 },
  steerAxis: 0.72,
  bracket: { up: -0.68, forward: 0.22 },
  crank: 0.17,
  pedalSide: 0.13,
  stopTilt: 0.16,
  footDown: { side: 0.34, forward: 0.1 },
};

/** Largest steering angle a steered pose is baked at; the renderer blends towards it. */
export const STEER_FULL = 0.3;

/** Where a hand holds a grip: the wrist a little behind and above the grip's centre, and 2 cm in towards the stem */
const WRIST_ON_GRIP: V3 = [0.02, 0.03, -0.06];
/** Where the ankle is over a peg or a pedal under the ball of the foot. */
const ANKLE_OVER_PEDAL: V3 = [0, 0.07, -0.08];

/** A grip's centre in the pelvis frame, the bars turned by `steer` (radians, left positive). */
export function gripPoint(fit: TwoWheelerFit, side: 1 | -1, steer = 0): V3 {
  // Relative to the steering axis, turned about it.
  const x = side * fit.grip.side;
  const z = fit.grip.forward - fit.steerAxis;
  const c = Math.cos(steer);
  const s = Math.sin(steer);
  return [x * c + z * s, fit.grip.up, -x * s + z * c + fit.steerAxis];
}

const offset = (p: V3, d: V3, side: 1 | -1): V3 => [p[0] + d[0] * side, p[1] + d[1], p[2] + d[2]];

/** A pedal's centre in the pelvis frame: `angle` round the bracket, `side` 1 for the left. */
export function pedalPoint(fit: TwoWheelerFit, angle: number, side: 1 | -1): V3 {
  const b = fit.bracket ?? { up: -0.68, forward: 0.22 };
  const crank = fit.crank ?? 0.17;
  return [side * (fit.pedalSide ?? 0.13), b.up + Math.sin(angle) * crank, b.forward + Math.cos(angle) * crank];
}

/** The ankle target for a foot put down on the road beside a machine tilted by `tilt` (`fit.stopTilt`, or a short rider's own, `stopTiltFor`) */
function footDownTarget(fit: TwoWheelerFit, tilt = fit.stopTilt): V3 {
  const t = tilt;
  const ankle = 0.08;
  const x = fit.footDown.side * Math.cos(t) - ankle * Math.sin(t);
  const h = fit.footDown.side * Math.sin(t) + ankle * Math.cos(t);
  return [x, h - fit.pelvisY, fit.footDown.forward];
}

function hands(fit: TwoWheelerFit, steer = 0): Pick<Targets, 'leftHand' | 'rightHand'> {
  return {
    leftHand: offset(gripPoint(fit, 1, steer), WRIST_ON_GRIP, -1),
    rightHand: offset(gripPoint(fit, -1, steer), WRIST_ON_GRIP, 1),
  };
}

// ---------------------------------------------------------------- the poses

/** A car seat: reclined a little, thighs near level, feet forward on the pedals or the floor */
const CAR_DRIVE: Targets = {
  // The rest pose already stoops about 0.2 rad forward
  lean: -0.45,
  // Heels on the floor (the ankle 8 cm over it, the hip point 0.28 m up) and 0.8 m ahead of the hip, on the pedals.
  leftFoot: [0.17, -0.08, 0.62],
  rightFoot: [-0.14, -0.08, 0.64],
  leftHand: rimPoint(1.05),
  rightHand: rimPoint(-1.05),
  kneePole: [0, 1, 1],
  elbowPole: [0, -1, 0.2],
  look: -0.12,
};
const CAR_RIDE: Targets = {
  lean: -0.45,
  // Legs out, the knees a little over the hips
  leftFoot: [0.16, -0.08, 0.61],
  rightFoot: [-0.16, -0.08, 0.61],
  leftHand: [0.13, 0.06, 0.3],
  rightHand: [-0.13, 0.06, 0.3],
  kneePole: [0, 1, 1],
  elbowPole: [0.3, -1, 0],
  look: -0.1,
};

/** A rear passenger folds their knees into the footwell beneath the front seat. */
const CAR_REAR_RIDE: Targets = {
  ...CAR_RIDE,
  lean: -0.38,
  leftFoot: [0.15, -0.13, 0.43],
  rightFoot: [-0.15, -0.13, 0.44],
  leftHand: [0.14, 0.04, 0.23],
  rightHand: [-0.14, 0.04, 0.23],
};

/** The driver's seat of a bus or a truck cab */
const CAB_DRIVE: Targets = {
  lean: -0.42,
  leftFoot: [0.16, -0.37, 0.4],
  rightFoot: [-0.15, -0.37, 0.43],
  leftHand: rimPoint(1.15, CAB_WHEEL),
  rightHand: rimPoint(-1.15, CAB_WHEEL),
  kneePole: [0, 1, 1],
  elbowPole: [0, -1, 0.1],
  look: -0.05,
};
const CAB_RIDE: Targets = {
  lean: -0.42,
  leftFoot: [0.16, -0.37, 0.38],
  rightFoot: [-0.16, -0.37, 0.38],
  leftHand: [0.13, 0.02, 0.27],
  rightHand: [-0.13, 0.02, 0.27],
  kneePole: [0, 1, 1],
  elbowPole: [0.3, -1, 0],
  look: 0,
};

/** A bus seat: upright, thighs level, shins down to the floor 0.55 m below the hip, hands resting on the thighs. */
const CHAIR_SIT: Targets = {
  lean: -0.3,
  leftFoot: [0.12, -0.46, 0.4],
  rightFoot: [-0.12, -0.46, 0.4],
  leftHand: [0.12, 0.03, 0.27],
  rightHand: [-0.12, 0.03, 0.27],
  kneePole: [0, 1, 1],
  elbowPole: [0.3, -1, 0],
  look: 0.05,
};

/** A driver shot dead at the wheel, as GTA V draws one */
const dead = (t: Targets, lean: number): Targets => ({
  ...t, lean, twist: 0.12, turn: 0.55, look: 0.75,
  // Fallen into the lap, as the other: hanging 0.2 m down beside the seat, the hand
  leftHand: [0.08, 0.02, 0.3],
  rightHand: [-0.06, 0.02, 0.3],
  // The elbows hang down at the sides (mirrored per arm, as the driving poses' are)
  elbowPole: [0, -1, -0.3],
});

/** A head turned, and the shoulders a little with it. */
const turned = (t: Targets, turn: number, look = t.look ?? 0): Targets => ({ ...t, turn, look, twist: (t.twist ?? 0) + turn * 0.15 });

/** Astride a motorcycle: leaning into the tank, hands on the grips, feet on the pegs (`MOTO_FIT`). */
const MOTO: Targets = {
  lean: 0.28,
  reach: true,
  ...hands(MOTO_FIT),
  leftFoot: offset([MOTO_FIT.peg!.side, MOTO_FIT.peg!.up, MOTO_FIT.peg!.forward], ANKLE_OVER_PEDAL, 1),
  rightFoot: offset([-MOTO_FIT.peg!.side, MOTO_FIT.peg!.up, MOTO_FIT.peg!.forward], ANKLE_OVER_PEDAL, -1),
  kneePole: [0.5, 0.1, 1],
  elbowPole: [0.6, -1, 0],
  look: -0.12,
};
/** Stopped: the machine tilted onto the left foot (as far as this body's leg asks, `stopTiltFor`), the right on its peg. */
const MOTO_STOP: Omit<Targets, 'leftFoot'> = { ...MOTO, lean: 0.12 };

/** On a bicycle: a forward reach to the bars and the feet on the pedals, which turn round the bottom bracket (`BIKE_FIT`). */
const BIKE: Omit<Targets, 'leftFoot' | 'rightFoot'> = {
  lean: 0.32,
  reach: true,
  ...hands(BIKE_FIT),
  kneePole: [0.1, 0.2, 1],
  elbowPole: [0.4, -1, 0],
  look: -0.2,
};
const pedalFoot = (angle: number, side: 1 | -1): V3 => offset(pedalPoint(BIKE_FIT, angle, side), ANKLE_OVER_PEDAL, side);

/** Steering: the bars turned by `STEER_FULL`, the hands with them, the trunk following a little. */
function steered<T extends Omit<Targets, 'leftFoot' | 'rightFoot'>>(t: T, fit: TwoWheelerFit, direction: 1 | -1): T {
  return { ...t, twist: direction * 0.15, ...hands(fit, direction * STEER_FULL) };
}

export const RIDER_CLIPS: readonly RiderClip[] = [
  seated('carDrive', CAR_DRIVE),
  seated('carDriveMirror', turned(CAR_DRIVE, 0.45, -0.05)),
  seated('carDriveRight', turned(CAR_DRIVE, -0.45)),
  still('carDead', dead(CAR_DRIVE, 0.4)),
  still('cabDead', dead(CAB_DRIVE, 0.45)),
  seated('carRide', CAR_RIDE),
  seated('carRideLeft', turned(CAR_RIDE, 0.45)),
  seated('carRideRight', turned(CAR_RIDE, -0.45)),
  seated('carRearRide', CAR_REAR_RIDE),
  seated('carRearLeft', turned(CAR_REAR_RIDE, 0.45)),
  seated('carRearRight', turned(CAR_REAR_RIDE, -0.45)),
  seated('cabDrive', CAB_DRIVE),
  seated('cabDriveMirror', turned(CAB_DRIVE, 0.6, 0)),
  seated('cabDriveRight', turned(CAB_DRIVE, -0.5, 0)),
  seated('cabRide', CAB_RIDE),
  seated('cabRideLeft', turned(CAB_RIDE, 0.55)),
  seated('cabRideRight', turned(CAB_RIDE, -0.6)),
  seated('chairSit', CHAIR_SIT),
  seated('chairSitLeft', turned(CHAIR_SIT, 0.65)),
  seated('chairSitRight', turned(CHAIR_SIT, -0.65)),
  seated('chairSitPhone', { ...CHAIR_SIT, leftHand: [0.05, 0.14, 0.3], rightHand: [-0.05, 0.14, 0.3], elbowPole: [0.6, -1, -0.2], look: 0.55 }),
  still('motoRide', MOTO),
  still('motoLeft', steered(MOTO, MOTO_FIT, 1)),
  still('motoRight', steered(MOTO, MOTO_FIT, -1)),
  stopped('motoStop', MOTO_FIT, MOTO_STOP),
  {
    key: 'bikePedal',
    duration: 1,
    loop: true,
    pose(rig, time) {
      const angle = time * Math.PI * 2;
      apply(rig, { ...BIKE, leftFoot: pedalFoot(angle, 1), rightFoot: pedalFoot(angle + Math.PI, -1) });
    },
  },
  still('bikeLeft', { ...steered(BIKE, BIKE_FIT, 1), leftFoot: pedalFoot(0, 1), rightFoot: pedalFoot(Math.PI, -1) }),
  still('bikeRight', { ...steered(BIKE, BIKE_FIT, -1), leftFoot: pedalFoot(0, 1), rightFoot: pedalFoot(Math.PI, -1) }),
  // Stopped: tilted onto the left foot, the right on its pedal at the top of the stroke, ready to push off.
  stopped('bikeStop', BIKE_FIT, { ...BIKE, lean: 0.18, rightFoot: pedalFoot(Math.PI * 0.6, -1) }),
];

// ---------------------------------------------------------------- helmets

/** Bodies whose hair no helmet of a helmet's size holds - buns, big curls, a ponytail high on the crown: none of the cast (every rider's head
 *  measured, `tests/render/riderFit.spec.ts`). */
export const NO_HELMET: ReadonlySet<string> = new Set();

/** Segments round a helmet shell: its flat facets sit this close to the true ellipsoid. */
export const HELMET_SEGMENTS = { width: 24, height: 16 } as const;

/** Up in a head bone's own frame: the cast's bones rest in the model's axes (Y up, Z forward), in metres (`people/cookedPerson.ts`). */
export const HEAD_UP = new Vector3(0, 1, 0);
/** Room between a head and its helmet's shell, metres. */
const HELMET_PAD = 0.012;

/** A helmet made for one body: an ellipsoid in the head bone's own frame that encloses every point of the head above the head bone's joint
 *  (`headPoints`) */
export function helmetShape(rig: Object3D): Matrix4 | null {
  rig.updateMatrixWorld(true);
  const head = rig.getObjectByName(BONES.head);
  if (!head) return null;
  const points = headPoints(rig, head);
  if (points.length < 8) return null;
  const box = new Box3().setFromPoints(points);
  const centre = box.getCenter(new Vector3());
  const half = box.getSize(new Vector3()).multiplyScalar(0.5);
  let k = 0;
  for (const p of points) {
    k = Math.max(k, Math.hypot((p.x - centre.x) / half.x, (p.y - centre.y) / half.y, (p.z - centre.z) / half.z));
  }
  // Room between the head and the shell, and for the shell's flat facets lying inside the ellipsoid through their corners.
  const facet = 1 / (Math.cos(Math.PI / HELMET_SEGMENTS.height) * Math.cos(Math.PI / HELMET_SEGMENTS.width));
  const pad = HELMET_PAD;
  const radius = half.multiplyScalar(k * facet).addScalar(pad);
  return new Matrix4().compose(centre, new Quaternion(), radius.multiplyScalar(2));
}

/** The points of a posed head a helmet must hold, in the head bone's frame: those above its joint (`HEAD_UP`) */
export function headPoints(rig: Object3D, head: Object3D): Vector3[] {
  const out: Vector3[] = [];
  const v = new Vector3();
  // Mesh to head in one matrix, inverted once per mesh: inverting the head's world matrix for every vertex
  const fromWorld = head.matrixWorld.clone().invert();
  const toHead = new Matrix4();
  rig.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    const bone = o.skeleton.bones.indexOf(head as Bone);
    if (bone < 0) return;
    o.skeleton.update();
    toHead.multiplyMatrices(fromWorld, o.matrixWorld);
    const index = o.geometry.getAttribute('skinIndex');
    const weight = o.geometry.getAttribute('skinWeight');
    const count = o.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      let w = 0;
      for (let c = 0; c < 4; c++) if (index.getComponent(i, c) === bone) w += weight.getComponent(i, c);
      if (w < 0.5) continue;
      o.getVertexPosition(i, v);
      v.applyMatrix4(toHead);
      if (v.dot(HEAD_UP) > 0) out.push(v.clone());
    }
  });
  return out;
}

/** Seconds a still pose is baked over: two frames, the same pose. */
function still(key: RiderClipKey, targets: Targets): RiderClip {
  return { key, duration: 1, loop: true, pose: (rig) => apply(rig, targets) };
}

/** A stopped rider's still pose: the left foot put down on the road beside the machine tilted as far as this body's leg asks (`stopTiltFor`). */
function stopped(key: RiderClipKey, fit: TwoWheelerFit, targets: Omit<Targets, 'leftFoot'>): RiderClip {
  return { key, duration: 1, loop: true, pose: (rig) => apply(rig, { ...targets, leftFoot: footDownTarget(fit, stopTiltFor(rig, fit)) }) };
}

/** The most a stopped machine tilts onto its rider's foot: a short rider's, on a machine made for the average one. */
export const STOP_TILT_MOST = 0.4;
/** Of a leg's length, the most its foot-down target may stand from the hip: as far as the limbs reach (`limb`). */
const LEG_REACH = 0.999;

/**
 * How far a stopped machine tilts onto this body's left foot (radians): the machine's own tilt (`fit.stopTilt`) where the leg reaches the road from the
 * saddle, else the least tilt that brings the road to the foot (a short rider leans the machine further onto the foot, as one does), up to
 * `STOP_TILT_MOST`. Read off the rig at rest: the same number the pose is baked with and the machine is drawn at (`agents.ts`).
 */
export function stopTiltFor(rig: Object3D, fit: TwoWheelerFit): number {
  rig.updateMatrixWorld(true);
  const pelvis = rig.getObjectByName(BONES.pelvis);
  const [thigh, calf, foot] = BONES.leftLeg.map((name) => rig.getObjectByName(name));
  if (!pelvis || !thigh || !calf || !foot) return fit.stopTilt;
  const origin = pelvis.getWorldPosition(new Vector3());
  const hip = thigh.getWorldPosition(new Vector3()).sub(origin);
  const leg = thigh.getWorldPosition(tmpA).distanceTo(calf.getWorldPosition(tmpB)) + calf.getWorldPosition(tmpA).distanceTo(foot.getWorldPosition(tmpB));
  const reaches = (tilt: number): boolean => { const [x, y, z] = footDownTarget(fit, tilt); return hip.distanceTo(tmpC.set(x, y, z)) <= leg * LEG_REACH; };
  if (reaches(fit.stopTilt)) return fit.stopTilt;
  if (!reaches(STOP_TILT_MOST)) return STOP_TILT_MOST;
  // The target comes nearer the hip the further the machine tilts: the least tilt that reaches, to a thousandth of a radian.
  let lo = fit.stopTilt, hi = STOP_TILT_MOST;
  while (hi - lo > 1e-3) { const mid = (lo + hi) / 2; if (reaches(mid)) hi = mid; else lo = mid; }
  return hi;
}

/** A seated pose that lives: breathing in the trunk, the head turning a little and nodding */
function seated(key: RiderClipKey, targets: Targets): RiderClip {
  return {
    key, duration: SEATED_IDLE, loop: true,
    pose: (rig, time) => {
      const a = (time / SEATED_IDLE) * Math.PI * 2;
      // The floor the targets stand the feet on: the ankle `SOLE` over it.
      const floor = Math.min(targets.leftFoot[1], targets.rightFoot[1]) - SOLE;
      const sway: Targets = {
        ...targets,
        lean: targets.lean + 0.03 * Math.sin(a * 2),
        turn: (targets.turn ?? 0) + 0.14 * Math.sin(a + 1.3),
        look: (targets.look ?? 0) + 0.05 * Math.sin(a * 3 + 0.4),
      };
      const lift = soleLift(rig, key, floor, sway);
      apply(rig, lift === 0 ? sway : {
        ...sway,
        leftFoot: [sway.leftFoot[0], sway.leftFoot[1] + lift, sway.leftFoot[2]],
        rightFoot: [sway.rightFoot[0], sway.rightFoot[1] + lift, sway.rightFoot[2]],
      });
    },
  };
}

/** The ankle 8 cm over the floor, as the seated targets put it, is where an average shoe's sole meets the floor */
const SOLE = 0.08;
const soleLifts = new WeakMap<Object3D, Map<RiderClipKey, number>>();
function soleLift(rig: Object3D, key: RiderClipKey, floor: number, targets: Targets): number {
  let lifts = soleLifts.get(rig);
  const known = lifts?.get(key);
  if (known !== undefined) return known;
  // Solved once as it is, measured, and put back to where it was.
  const bones: [Object3D, Vector3, Quaternion, Vector3][] = [];
  rig.traverse((o) => { if (o instanceof Bone) bones.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
  apply(rig, targets);
  const lowest = lowestFoot(rig);
  for (const [b, position, quaternion, scale] of bones) { b.position.copy(position); b.quaternion.copy(quaternion); b.scale.copy(scale); }
  rig.updateMatrixWorld(true);
  const lift = lowest === null ? 0 : floor - lowest;
  if (!lifts) soleLifts.set(rig, lifts = new Map());
  lifts.set(key, lift);
  return lift;
}

/** The lowest point the feet carry (vertices half or more on a foot or toe bone), metres from the pelvis; null without feet. */
function lowestFoot(rig: Object3D): number | null {
  const pelvis = rig.getObjectByName(BONES.pelvis);
  if (!pelvis) return null;
  const carried = new Set<Object3D>();
  for (const name of [BONES.leftLeg[2], BONES.rightLeg[2]]) rig.getObjectByName(name)?.traverse((b) => { carried.add(b); });
  const base = pelvis.getWorldPosition(new Vector3()).y;
  const v = new Vector3();
  let low = Infinity;
  rig.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    const on = new Set<number>();
    o.skeleton.bones.forEach((b, i) => { if (carried.has(b)) on.add(i); });
    if (!on.size) return;
    o.skeleton.update();
    const index = o.geometry.getAttribute('skinIndex');
    const weight = o.geometry.getAttribute('skinWeight');
    const count = o.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      let w = 0;
      for (let c = 0; c < 4; c++) if (on.has(index.getComponent(i, c))) w += weight.getComponent(i, c);
      if (w < 0.5) continue;
      o.getVertexPosition(i, v);
      v.applyMatrix4(o.matrixWorld);
      low = Math.min(low, v.y - base);
    }
  });
  return low === Infinity ? null : low;
}

// ---------------------------------------------------------------- solving

const BONES = {
  pelvis: 'Bip01_Pelvis',
  spine: ['Bip01_Spine', 'Bip01_Spine1', 'Bip01_Spine2'],
  neck: 'Bip01_Neck',
  head: 'Bip01_Head',
  leftLeg: ['Bip01_L_Thigh', 'Bip01_L_Calf', 'Bip01_L_Foot'],
  rightLeg: ['Bip01_R_Thigh', 'Bip01_R_Calf', 'Bip01_R_Foot'],
  leftArm: ['Bip01_L_UpperArm', 'Bip01_L_Forearm', 'Bip01_L_Hand'],
  rightArm: ['Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand'],
} as const;

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpC = new Vector3();
const qa = new Quaternion();
const qb = new Quaternion();
const qc = new Quaternion();

/** Poses the rig so its limbs reach the targets. The rig must be at its rest pose. */
function apply(rig: Object3D, t: Targets): void {
  const find = (name: string): Object3D | undefined => rig.getObjectByName(name);
  const pelvis = find(BONES.pelvis);
  if (!pelvis) return;
  rig.updateMatrixWorld(true);
  // The pelvis frame in world: its position, and the MODEL's axes
  const origin = pelvis.getWorldPosition(new Vector3());
  const worldOf = (v: V3): Vector3 => new Vector3(v[0], v[1], v[2]).add(origin);

  // Trunk: lean and twist shared over the three spine bones.
  const thigh = find(BONES.leftLeg[0]);
  const spine = BONES.spine.map(find).filter((b): b is Object3D => !!b && !isAncestor(b, thigh));
  for (const bone of spine) {
    rotateWorld(bone, new Vector3(1, 0, 0), t.lean / spine.length);
    if (t.twist) rotateWorld(bone, new Vector3(0, 1, 0), t.twist / spine.length);
  }
  const neck = find(BONES.neck);
  const head = find(BONES.head);
  // A turn of the head less the part the shoulders already took.
  const turn = (t.turn ?? 0) - (t.twist ?? 0);
  // Most of a turn or a nod in the neck, the rest in the head.
  if (neck && turn) rotateWorld(neck, new Vector3(0, 1, 0), turn * 0.7);
  if (head && turn) rotateWorld(head, new Vector3(0, 1, 0), turn * 0.3);
  const nod = t.look ? t.look - t.lean * 0.6 : 0;
  if (neck && nod) rotateWorld(neck, new Vector3(1, 0, 0), nod * 0.6);
  if (head && nod) rotateWorld(head, new Vector3(1, 0, 0), nod * 0.4);
  rig.updateMatrixWorld(true);
  if (t.reach) reachForBars(rig, spine, worldOf(t.leftHand), worldOf(t.rightHand));

  limb(rig, BONES.leftLeg, worldOf(t.leftFoot), t.kneePole ?? [0, 0, 1]);
  limb(rig, BONES.rightLeg, worldOf(t.rightFoot), mirrorPole(t.kneePole ?? [0, 0, 1], -1));
  limb(rig, BONES.leftArm, worldOf(t.leftHand), mirrorPole(t.elbowPole ?? [0, -1, 0], 1));
  limb(rig, BONES.rightArm, worldOf(t.rightHand), mirrorPole(t.elbowPole ?? [0, -1, 0], -1));
  // Feet flat-ish: the sole points forward and a little down.
  for (const name of [BONES.leftLeg[2], BONES.rightLeg[2]]) {
    const foot = find(name);
    if (foot) levelFoot(foot);
  }
  rig.updateMatrixWorld(true);
}

/** A step of the trunk's turn towards hands out of reach (`reachForBars`), and the most it leans and twists on past its pose. */
const REACH_STEP = 0.01;
const REACH_LEAN_MOST = 0.5;
const REACH_TWIST_MOST = 0.5;

/**
 * Turns the trunk, a step at a time, while a hand's target lies past its arm's reach from its shoulder (a short body on a machine made for the
 * average one: the steered bars' far grip), as a rider reaches for the bars: each step the one of leaning forward or twisting either way that
 * brings the hands nearest, until both reach, until no step brings them nearer, or as far as `REACH_LEAN_MOST` and `REACH_TWIST_MOST` allow.
 * A body whose arms reach is left as its pose put it.
 */
function reachForBars(rig: Object3D, spine: readonly Object3D[], left: Vector3, right: Vector3): void {
  const arms = [[BONES.leftArm, left], [BONES.rightArm, right]] as const;
  const reaches = arms.map(([names, target]) => {
    const [root, mid, end] = names.map((n) => rig.getObjectByName(n));
    if (!root || !mid || !end || spine.length === 0) return null;
    const length = root.getWorldPosition(tmpA).distanceTo(mid.getWorldPosition(tmpB)) + mid.getWorldPosition(tmpA).distanceTo(end.getWorldPosition(tmpB));
    return { root, length, target };
  });
  const short = (): number => {
    let most = 0;
    for (const arm of reaches) if (arm) most = Math.max(most, arm.root.getWorldPosition(tmpA).distanceTo(arm.target) - arm.length * 0.999);
    return most;
  };
  /** A turn of the trunk about a world axis, shared over its bones; undone by the same with `-angle` (turns about one axis: in either order). */
  const turn = (axis: Vector3, angle: number): void => {
    for (const bone of spine) rotateWorld(bone, axis, angle / spine.length);
  };
  const LEAN = new Vector3(1, 0, 0), TWIST = new Vector3(0, 1, 0);
  let deficit = short(), leant = 0, twisted = 0;
  while (deficit > 0) {
    let best: { axis: Vector3; angle: number; next: number } | null = null;
    for (const [axis, angle, room] of [[LEAN, REACH_STEP, REACH_LEAN_MOST - leant], [TWIST, REACH_STEP, REACH_TWIST_MOST - twisted], [TWIST, -REACH_STEP, REACH_TWIST_MOST + twisted]] as const) {
      if (room < REACH_STEP) continue;
      turn(axis, angle);
      const next = short();
      turn(axis, -angle);
      if (next < deficit && (!best || next < best.next)) best = { axis, angle, next };
    }
    if (!best) break;
    turn(best.axis, best.angle);
    if (best.axis === LEAN) leant += best.angle; else twisted += best.angle;
    deficit = best.next;
  }
}

function isAncestor(bone: Object3D, of: Object3D | undefined): boolean {
  for (let o = of?.parent ?? null; o; o = o.parent) if (o === bone) return true;
  return false;
}

/** A pole given for the left limb, mirrored to the right. */
const mirrorPole = (p: V3, side: 1 | -1): V3 => [p[0] * side, p[1], p[2]];

/** Rotates a bone by `angle` about a WORLD axis, keeping its parent. */
function rotateWorld(bone: Object3D, axis: Vector3, angle: number): void {
  bone.updateMatrixWorld(true);
  const parent = bone.parent;
  const world = bone.getWorldQuaternion(qa);
  qb.setFromAxisAngle(axis, angle);
  const next = qb.multiply(world);
  const parentWorld = parent ? parent.getWorldQuaternion(qc) : qc.identity();
  bone.quaternion.copy(parentWorld.invert().multiply(next));
  bone.updateMatrixWorld(true);
}

/** Turns `bone` so the direction to `child` points at `target`, both in world. */
function aim(bone: Object3D, child: Vector3, target: Vector3): void {
  const from = bone.getWorldPosition(tmpA);
  const current = tmpB.copy(child).sub(from).normalize();
  const wanted = tmpC.copy(target).sub(from).normalize();
  if (current.lengthSq() < 1e-10 || wanted.lengthSq() < 1e-10) return;
  const delta = new Quaternion().setFromUnitVectors(current, wanted);
  const world = bone.getWorldQuaternion(qa);
  const next = delta.multiply(world);
  const parentWorld = bone.parent ? bone.parent.getWorldQuaternion(qc) : qc.identity();
  bone.quaternion.copy(parentWorld.invert().multiply(next));
  bone.updateMatrixWorld(true);
}

/** Two-bone IK: the root bone, the middle joint and the end effector, reaching for `target` */
function limb(rig: Object3D, names: readonly string[], target: Vector3, pole: V3): void {
  const [root, mid, end] = names.map((n) => rig.getObjectByName(n));
  if (!(root instanceof Object3D) || !(mid instanceof Object3D) || !(end instanceof Object3D)) return;
  const a0 = root.getWorldPosition(new Vector3());
  const b0 = mid.getWorldPosition(new Vector3());
  const c0 = end.getWorldPosition(new Vector3());
  const upper = a0.distanceTo(b0);
  const lower = b0.distanceTo(c0);
  const toTarget = target.clone().sub(a0);
  const reach = Math.min((upper + lower) * 0.999, Math.max(Math.abs(upper - lower) * 1.001 + 1e-4, toTarget.length()));
  const d = toTarget.normalize();
  const p = new Vector3(pole[0], pole[1], pole[2]);
  p.sub(d.clone().multiplyScalar(p.dot(d)));
  if (p.lengthSq() < 1e-8) p.set(0, 0, 1);
  p.normalize();
  const cos = Math.min(1, Math.max(-1, (upper * upper + reach * reach - lower * lower) / (2 * upper * reach)));
  const sin = Math.sqrt(1 - cos * cos);
  const joint = a0.clone().add(d.clone().multiplyScalar(upper * cos)).add(p.multiplyScalar(upper * sin));
  aim(root, b0, joint);
  const goal = a0.clone().add(d.multiplyScalar(reach));
  aim(mid, end.getWorldPosition(new Vector3()), goal);
}

/** Levels a foot so its sole runs forward rather than hanging from the ankle. */
function levelFoot(foot: Object3D): void {
  const toe = foot.children.find((c) => c instanceof Bone);
  if (!toe) return;
  const at = foot.getWorldPosition(new Vector3());
  const tip = toe.getWorldPosition(new Vector3());
  const length = at.distanceTo(tip);
  if (length < 1e-4) return;
  aim(foot, tip, at.clone().add(new Vector3(0, -0.35, 1).normalize().multiplyScalar(length)));
}
