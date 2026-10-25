import type { BufferGeometry } from 'three';
import { ARCHETYPES, archetypeById } from '@sim/vehicles/archetypes';
import { buildCarModel, carStylesFor } from '../../render/carBody';
import { buildBusModel, buildTruckModel, buildTwoWheelerModel, rimGeometry, spokedRimGeometry, tyreGeometry, type VehicleModel } from '../../render/vehicleModels';
import { windowGlass } from '../../render/vehicleWindows';
import { ERROR_PIXELS, PartLevelMaker, SHED, levelFor, type Weld } from '../../render/vehicleLevels';
import { joinSoups, soupOf } from '../../render/vehicleSeen';
import { withoutHidden } from '../../render/vehicleHidden';
import type { ItemSpec, PieceSpec } from './items';

/** THE VEHICLES AS THEY ARE DRAWN AT EACH SCALE A LEVEL STARTS AT, each body at each scale an object of its own, as `agents.ts` draws them:
 *  each part without the triangles no one sees (`vehicleHidden.ts`), at the level `levelFor` picks there (`vehicleLevels.ts`), the doors shut
 *  and, apart, open (the body in pieces and each leaf in place). The scales are named in pixels a metre (`whole`: the model itself), the same
 *  whatever levels the code has, so two trees' sheets compare object by object (`scripts/optimization-sheet.mjs --only="vehicle levels"
 *  --match="at 40 px/m"`, the distance that scale is drawn at given with `--distance`). */

/** The errors the scales are named by: a level within each is first drawn where it is half a pixel (ERROR_PIXELS). */
const SCALE_ERRORS = [0.00625, 0.0125, 0.025, 0.05, 0.1, 0.2, 0.4] as const;
/** The scales an object is made at: the model whole, then pixels a metre where each error is half a pixel. */
const SCALES: readonly { readonly name: string; readonly level: (levels: number) => number }[] = [
  { name: 'whole', level: () => 0 },
  ...SCALE_ERRORS.map((e) => ({ name: `at ${ERROR_PIXELS / e} px/m`, level: (levels: number) => Math.min(levels - 1, levelFor(ERROR_PIXELS / e)) })),
];

type Add = (spec: ItemSpec) => void;

/** One part of a vehicle as the game draws it: its geometry, how its levels are welded, whether it is opaque, how many a vehicle draws. */
interface Drawn {
  readonly label: string; readonly geometry: BufferGeometry; readonly weld: Weld; readonly opaque: boolean; readonly copies?: number;
  /** What a part that casts no shadow is seen past (`agents.ts` occluders): the shut body's opaque triangles. */
  readonly occluders?: Float64Array;
}

/** Whether the objects are made whole at every scale (the reference the levels are measured against: `vehicleLevelItems` asWhole), and what
 *  makes their levels otherwise. */
interface Made { readonly asWhole: boolean; readonly maker: PartLevelMaker }

/** A part as the game draws it at each scale (`SCALES`; null where it draws nothing there), or whole at each. */
async function levelsOf(part: Drawn, made: Made): Promise<(BufferGeometry | null)[]> {
  const drawn = withoutHidden(part.geometry, part.opaque).geometry;
  const levels = made.asWhole ? [drawn] : await made.maker.levels(drawn, part.weld, part.copies ?? 1, part.occluders ?? null);
  return SCALES.map((scale) => levels[scale.level(levels.length)]!);
}

/** An object a scale for a set of parts drawn together. */
async function addLevels(add: Add, made: Made, name: string, variation: string, source: string, parts: readonly Drawn[]): Promise<void> {
  const all = await Promise.all(parts.map((part) => levelsOf(part, made)));
  SCALES.forEach((scale, k) => {
    const pieces: PieceSpec[] = [];
    parts.forEach((part, i) => { const g = all[i]![k]; if (g) pieces.push({ label: part.label, geometry: g, material: null }); });
    if (pieces.length) add({ group: 'Vehicles: levels', name, variation: `${variation} ${scale.name}`, origin: 'kit', source, build: 'instanced', pieces });
  });
}

/** A door's leaf, glass and card where they hang with the door shut (their own frame is the hinge's). */
const hung = (g: BufferGeometry, x: number, z: number): BufferGeometry => g.clone().translate(x, 0, z);

async function bodyLevels(add: Add, made: Made, name: string, variation: string, source: string, model: VehicleModel): Promise<void> {
  // As `agents.ts` draws them doors shut: the shell, panel, trim and cabin in one body (each part's SHED the body's), the trim and the cabin
  // made of what is seen of them past the body's opaque parts.
  const opaque = [model.shell, model.roof, model.accent, model.trim, model.interior].flatMap((g) => (g ? [soupOf(withoutHidden(g, true).geometry)] : []));
  const occluders = joinSoups(opaque);
  const shut: Drawn[] = [
    { label: 'shell', geometry: model.shell, weld: 'smooth', opaque: true, copies: SHED },
    { label: 'glass', geometry: windowGlass(model), weld: 'smooth', opaque: false },
    { label: 'interior', geometry: model.interior, weld: 'boxes', opaque: true, copies: SHED, occluders },
    { label: 'trim', geometry: model.trim, weld: 'boxes', opaque: true, copies: SHED, occluders },
    ...(model.roof ? [{ label: 'roof', geometry: model.roof, weld: 'smooth', opaque: true, copies: SHED } as const] : []),
    ...(model.accent ? [{ label: 'accent', geometry: model.accent, weld: 'smooth', opaque: true, copies: SHED } as const] : []),
  ];
  await addLevels(add, made, name, `${variation} doors shut`, source, shut);
  // The doors' parts are made apart (each in its hinge's frame); their levels are of those, then hung in place to be seen together.
  const open: Drawn[] = [
    { label: 'shell in pieces', geometry: model.openShell, weld: 'smooth', opaque: true },
    { label: 'fixed glass', geometry: model.openGlass, weld: 'smooth', opaque: false },
    { label: 'cabin', geometry: model.openInterior, weld: 'boxes', opaque: true },
  ];
  const all = await Promise.all(open.map((part) => levelsOf(part, made)));
  const doors = await Promise.all(model.doors.map(async (d) => ({ door: d, panel: await levelsOf({ label: 'leaf', geometry: d.panel, weld: 'smooth', opaque: true }, made),
    glass: await levelsOf({ label: 'pane', geometry: d.glass, weld: 'smooth', opaque: false }, made),
    card: d.card ? await levelsOf({ label: 'card', geometry: d.card, weld: 'smooth', opaque: true }, made) : null })));
  SCALES.forEach((scale, k) => {
    const pieces: PieceSpec[] = [];
    open.forEach((part, i) => { const g = all[i]![k]; if (g) pieces.push({ label: part.label, geometry: g, material: null }); });
    for (const { door, panel, glass, card } of doors) {
      for (const [label, levels] of [['leaf', panel], ['pane', glass], ['card', card]] as const) {
        const g = levels?.[k];
        if (g) pieces.push({ label: `door ${door.index} ${label}`, geometry: hung(g, door.hingeX, door.hingeZ), material: null });
      }
    }
    if (pieces.length) add({ group: 'Vehicles: levels', name, variation: `${variation} doors open ${scale.name}`, origin: 'kit', source, build: 'instanced', pieces });
  });
  if (model.steering) await addLevels(add, made, name, `${variation} steering wheel`, source, [{ label: 'steering wheel', geometry: model.steering.geometry, weld: 'boxes', opaque: true }]);
}

/** Every vehicle body, two-wheeler and wheel at every scale; `asWhole`: the same objects, by the same names, each part whole (its level 0)
 *  at every scale, what a level is measured against by the sheets (`--only="as whole"` before, `--only="^vehicle levels$"` after). */
export async function vehicleLevelItems(add: Add, asWhole = false): Promise<void> {
  const made: Made = { asWhole, maker: new PartLevelMaker() };
  for (const a of ARCHETYPES) {
    if (a.shape === 'car') {
      for (const style of carStylesFor(a)) await bodyLevels(add, made, a.id, style, 'src/render/carBody.ts', buildCarModel(a, style));
    } else if (a.shape === 'bus' || a.shape === 'truck') {
      await bodyLevels(add, made, a.id, a.shape, 'src/render/vehicleModels.ts', a.shape === 'bus' ? buildBusModel(a) : buildTruckModel(a));
    } else {
      const t = buildTwoWheelerModel(a);
      await addLevels(add, made, a.id, a.shape, 'src/render/vehicleModels.ts', [
        { label: 'body', geometry: t.body, weld: 'smooth', opaque: true }, { label: 'trim', geometry: t.trim, weld: 'boxes', opaque: true },
        { label: 'steering', geometry: t.steering.clone().translate(t.headX, t.headY, 0), weld: 'boxes', opaque: true },
        ...(t.cranks ? [{ label: 'cranks', geometry: t.cranks.clone().translate(t.bracketX, t.bracketY, 0), weld: 'boxes', opaque: true } as const] : []),
      ]);
    }
  }
  // A car's wheel and a bicycle's as `agents.ts` placeWheels draws them: the unit tyre and rim scaled and set where they go, each at the
  // level its own size picks (a car's tyre by max(d, tread), its rim by max(0.52 d, 1.1 tread), a bicycle's both by d).
  const car = archetypeById('sedan'), bike = archetypeById('bicycle');
  const d = car.wheelRadius * 2, tread = car.width * 0.14;
  await wheelLevels(add, made, 'tyre and rim', [
    { label: 'tyre', geometry: tyreGeometry(), copies: 4, size: Math.max(d, tread), scale: [d, d, tread], z: 0, laddered: true },
    { label: 'rim', geometry: rimGeometry(), copies: 4, size: Math.max(d * 0.52, tread * 1.1), scale: [d * 0.52, d * 0.52, tread * 0.5], z: tread * 0.3, laddered: true },
  ]);
  const bd = bike.wheelRadius * 2, btread = bike.width * 0.14;
  await wheelLevels(add, made, 'bicycle', [
    { label: 'tyre', geometry: tyreGeometry(0.035), copies: 2, size: bd, scale: [bd, bd, btread], z: 0, laddered: true },
    { label: 'spoked rim', geometry: spokedRimGeometry(), copies: 2, size: bd, scale: [bd, bd, btread], z: 0, laddered: true },
  ]);
}

/** A wheel's unit part as placed (`placeWheels`): its size on the screen (`size`, units of it a metre), its scale and its offset out. */
interface WheelPart { readonly label: string; readonly geometry: BufferGeometry; readonly copies: number; readonly size: number;
  readonly scale: readonly [number, number, number]; readonly z: number; readonly laddered: boolean }

/** A wheel at every scale, each part at the level its own size picks there, scaled and placed as drawn. */
async function wheelLevels(add: Add, made: Made, variation: string, parts: readonly WheelPart[]): Promise<void> {
  const all = await Promise.all(parts.map(async (part) => {
    const drawn = withoutHidden(part.geometry, true).geometry;
    return made.asWhole || !part.laddered ? [drawn] : made.maker.levels(drawn, 'boxes', part.copies);
  }));
  SCALES.forEach((scale, k) => {
    const pixels = k === 0 ? Infinity : ERROR_PIXELS / SCALE_ERRORS[k - 1]!;
    const pieces: PieceSpec[] = [];
    parts.forEach((part, i) => {
      const levels = all[i]!;
      const g = levels[Math.min(levels.length - 1, levelFor(pixels * part.size))];
      if (g) pieces.push({ label: part.label, geometry: g.clone().scale(...part.scale).translate(0, 0, part.z), material: null });
    });
    if (pieces.length) add({ group: 'Vehicles: levels', name: 'wheel', variation: `${variation} ${scale.name}`, origin: 'kit', source: 'src/render/vehicleModels.ts', build: 'instanced', pieces });
  });
}
