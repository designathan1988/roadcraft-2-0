import { WebGLRenderer } from 'three';

import { applyFacadePattern } from '@world/buildings/facadePatterns';
import {
  BAY_COMPONENTS,
  type Building,
  type ElementKind,
  FACADE_PATTERNS,
  type FacadePattern,
  ROOF_KINDS,
  type RoofKind,
  type BayComponent,
} from '@world/buildings/types';
import { ELEMENT_DEFAULTS, elementAt } from '@world/buildings/elements';
import { BLUEPRINTS, type BlueprintBody, blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { CITY_BUILDINGS, cityBuilding } from '@world/buildings/cityBuildings';
import { LOT_NAMES, loadLot, loadedLot, lotKey } from '@world/buildings/lotLibrary';
import { type PhotoView, createPhotoStudio } from '../render/buildings/photo';
import { primeSurfaceBake, startSurfaceBake } from '../render/surfaceBakeClient';
import { BUILDER_TAB_SPECS } from '../ui/builder/catalog';

/**
 * THE BUILDER'S PHOTOS, TAKEN ONCE (`scripts/builder-photos.mjs`, on the lab page that never starts the game): every option the Builder's
 * shelves show - its models, the town's buildings, the lot lab's lots, the facades, the parts, the roofs - photographed and written beside
 * the menu (`ui/builder/photos/`), which shows them as they are. DO NOT photograph them in the game: the menu built a picture of each
 * option as it opened, a second WebGL context beside the game's, the game at 4 frames a second and the walls black (2026-10-27).
 */

/** Which BayComponent a gallery id stands for: most carry their own name. */
const WALL_PARTS: Readonly<Record<string, BayComponent>> = {
  ...Object.fromEntries(BAY_COMPONENTS.map((component) => [component, component])),
  pillarBay: 'pillar',
  wallBay: 'wall',
};

const ROOF_PARTS: Readonly<Record<string, RoofKind>> = Object.fromEntries(
  ROOF_KINDS.map((kind) => [kind === 'flat' ? 'roofFlat' : `roof${kind[0]?.toUpperCase()}${kind.slice(1)}`, kind]),
);

const isElementPart = (id: string): boolean => Object.hasOwn(ELEMENT_DEFAULTS, id);

/** The traced runs are their element, seen as the thing they lay. */
const RUN_PARTS: Readonly<Record<string, ElementKind>> = {
  wallRun: 'wall',
  fenceRun: 'fence',
  pavementRun: 'pavement',
  stairRun: 'stair',
  railing: 'railing',
};

const isModel = (id: string): boolean => BLUEPRINTS.some((blueprint) => blueprint.key === id);

function blank(): Building | null {
  const blueprint = blueprintByKey('block');
  if (!blueprint) return null;
  return { ...instantiate(blueprint.body, { x: 0, y: 0 }, 0), id: -1 } as Building;
}

/** The record a part is photographed from */
function partSample(id: string): Building | null {
  // A lot of the lot lab, once read (`photographAll` reads every lot first).
  if (id.startsWith('lot:')) {
    const lot = loadedLot(id.slice(4));
    return lot ? ({ ...instantiate(lot.body as BlueprintBody, { x: 0, y: 0 }, Math.PI / 4), id: -1 } as Building) : null;
  }
  if (id.startsWith('city:')) {
    const model = cityBuilding(id.slice(5));
    return model ? ({ ...instantiate(model.body, { x: 0, y: 0 }, Math.PI / 4), id: -1 } as Building) : null;
  }
  if (isModel(id)) {
    const blueprint = blueprintByKey(id);
    if (!blueprint) return null;
    return { ...instantiate(blueprint.body, { x: 0, y: 0 }, Math.PI / 4), id: -1 } as Building;
  }

  const sample = blank();
  const volume = sample?.volumes[0];
  if (!sample || !volume) return null;
  sample.elements = [];

  const component = WALL_PARTS[id];
  if (component) {
    // One storey, one wall, filled with the part: the picture is the part.
    if (!volume.storeys[0]) return null;
    volume.storeys = [{ facade: { fill: component } }];
    return sample;
  }

  // A composition is photographed on the wall it composes.
  if ((FACADE_PATTERNS as readonly string[]).includes(id)) {
    // Applied as the panel applies it - shopfronts, glazing, piers - or every pattern photographed as the same plain block.
    applyFacadePattern(sample, { scope: 'building' }, id as FacadePattern);
    return sample;
  }

  const roof = ROOF_PARTS[id];
  if (roof) {
    volume.roof = roof;
    return sample;
  }
  if (id === 'roofShape' || id === 'roofs') {
    volume.roof = 'gable';
    return sample;
  }

  const kind = RUN_PARTS[id] ?? (isElementPart(id) ? (id as ElementKind) : null);
  if (kind) {
    // No walls at all: the element alone, at the size it is placed at.
    sample.volumes = [];
    sample.cores = [];
    sample.elements = [{ ...elementAt(sample, kind, { x: 0, y: 0 }, 2), id: 1 }];
    return sample;
  }

  return null;
}


/** Every option a shelf of the Builder shows (`ui/v2/shell.ts` renderBuild): its tools, its models, the town's buildings, the lots, the facades. */
export function photoIds(): string[] {
  const ids = new Set<string>();
  for (const spec of BUILDER_TAB_SPECS) {
    for (const s of spec.sections) {
      for (const tool of s.tools ?? []) ids.add(tool.id);
      if (s.shelf === 'models') for (const id of [...CITY_BUILDINGS.map((c) => `city:${c.fn}`), ...BLUEPRINTS.map((b) => b.key), ...LOT_NAMES.map(lotKey)]) ids.add(id);
      if (s.shelf === 'patterns') for (const id of FACADE_PATTERNS) ids.add(id);
    }
  }
  return [...ids];
}

/** How an option is framed (`photo.ts` PhotoView): a roof from above, a wall part on its bays, anything else whole. */
const viewOf = (id: string): PhotoView => (ROOF_PARTS[id] ? 'roof' : WALL_PARTS[id] ? 'wall' : 'model');

/** Each option's photo as a PNG data URL, by id; an option with nothing to build (a tool such as "delete") has none and keeps its glyph. */
export async function photographAll(ids: readonly string[] = photoIds()): Promise<Record<string, string>> {
  primeSurfaceBake(await startSurfaceBake());
  await Promise.all(ids.filter((id) => id.startsWith('lot:')).map((id) => loadLot(id.slice(4))));
  // The page's one context (the lab page never starts the game); the depth convention of the game's (`depthConvention.ts`).
  const renderer = new WebGLRenderer({ antialias: false, reversedDepthBuffer: true });
  const studio = createPhotoStudio(renderer);
  const photos: Record<string, string> = {};
  try {
    for (const id of ids) {
      const sample = partSample(id);
      const blob = sample ? await studio.photograph(sample, viewOf(id)) : null;
      if (blob) photos[id] = await dataUrlOf(blob);
    }
  } finally {
    studio.dispose();
    renderer.dispose();
  }
  return photos;
}

const dataUrlOf = (blob: Blob): Promise<string> => new Promise((done, fail) => {
  const reader = new FileReader();
  reader.onload = () => done(reader.result as string);
  reader.onerror = () => fail(reader.error ?? new Error('the photo could not be read'));
  reader.readAsDataURL(blob);
});
