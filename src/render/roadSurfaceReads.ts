import type { Polyline } from '@core/polyline';
import type { SegmentId } from '@world/ids';
import type { RoadReads } from '@world/roadField';
import { CURB_BAND, FOOTWAY_RISE } from '@world/roadTypes';
import type { FootwayMaterial } from '@world/roadSection';
import { roadStructure, type RoadStructure } from '@world/structures';
import { m } from '@world/units';
import type { HeightFn, TileMeshOptions, TintFn, UvFn, UvFrameFn } from './mesh/tileMesh';
import { FOOTWAY_TINT } from './roadTones';

/** WHAT EACH SURFACE OF A ROAD PASS READS PER VERTEX (`roadSurfaces.ts`) */

/** What each surface of a piece is made from (`roads/pieceGeom.ts`): a band of the roads, a part of a median (its paint is no surface: the carriageway's
 *  shader draws it, `roadMarks.ts`). A structure's deck
 *  has a band past its footways, its edge (`deckEdge`); on the ground the terrain meets the footway's outer edge (`terrainSeams.ts`): no band there. */
export type TileSource =
  | { readonly kind: 'band'; readonly band: 'deckEdge' | 'footway' | 'kerb' | 'asphalt' | 'curbRamp' }
  | { readonly kind: 'median'; readonly part: 'kerb' | 'planting' | 'paved' };

/** The name a surface's shapes are filed under in a piece (`roadSurfaceInputs.ts`). */
export const slotOf = (source: TileSource): string =>
  source.kind === 'band' ? source.band : `median:${source.part}`;
/** Where a piece files the stations every strip of a group takes (`roads/pieceGeom.ts` 'stations'). */
export const STATIONS_SLOT = 'stations';

/** Depth of a deck's edge past its footways below the carriageway (`deckEdge`). */
const DECK_EDGE_DROP = m(0.04);
/** World size of one UV unit of the terrain's material on a mesh of the roads' own (a retaining wall's backfill, `structures.ts`). */
export const TERRAIN_UV = 64;
/** The least edge a rise of a surface is resolved to (`TileMeshOptions.leastEdge`): a dropped kerb's slope (1.8 m long, its flares 1.5 m) finer. */
const LEAST_EDGE = m(0.5);
const RAMP_LEAST_EDGE = m(0.25);
/** Height of the median island's kerb above the carriageway: the footway's kerb (15 cm). */
const MEDIAN_KERB = FOOTWAY_RISE;
/** Height of the planting inside it: the soil a hair over the kerb's top, so the two are never one plane. */
const MEDIAN_PLANTING = FOOTWAY_RISE + m(0.02);
/** Slabs in a footway panel along a bend: a joint every this many tiles (`surfaceFrameAt`). */
const FOOTWAY_PANEL_TILES = 2;
/** How far before its mouth or past it a point of a road is still on its span between its mouths (`RoadLook` from, to): a road's strip ends on its
 *  mouth, and its end's arc length read back off the centreline is the mouth's trim to a rounding (8.9e-16 m off, a T at 70 degrees), which read the
 *  end as off the road and put stations at the halves, quarters and eighths of a flat carriageway (`roads/pieceMesh.ts` sharedStations). */
const SPAN_SLACK = m(0.001);
const offSpan = (along: number, look: RoadLook): boolean => along < look.from - SPAN_SLACK || along > look.to + SPAN_SLACK;

/** A road pass as its surfaces are read (`roadSurfaceSteps`): plain data, handed to a worker as it is. */
export interface PassDesc {
  readonly id: string;
  readonly structure: RoadStructure;
  /** An alignment's root segment and its chain, for a pass of roads at authored heights. */
  readonly segment?: SegmentId;
  readonly chain?: readonly SegmentId[];
  /** The type of the root segment's road as the document has it (0 when it has none). */
  readonly rootType: number;
  readonly raised: boolean;
  /** World size of one texture tile of each material. */
  readonly scale: { readonly asphalt: number; readonly footway: number; readonly kerb: number; readonly verge: number; readonly deck: number };
  /** The carriageway's tints against the colour its texture was baked at, made on the page (three's colour management) */
  readonly classTint: readonly number[];
  readonly referenceTint: readonly [number, number, number];
  readonly pavingTint: Readonly<Record<string, readonly [number, number, number]>>;
}

/** What a surface reads of a road beside the field: its paving, widths and its carriageway's span between its mouths. */
export interface RoadLook {
  readonly width: number;
  /** One lane's width (`laneWidth`). */
  readonly lane: number;
  /** Its slot in the carriageway shader's table (`roadPaint.ts`): its lines along it, its marks (`roadMarks.ts`). */
  readonly paint?: number | undefined;
  /** The slots of the nodes at its two ends (a and b): what a junction's plate's vertices carry (`roadMarks.ts`, a plate's marks). */
  readonly ends?: readonly [number, number] | undefined;
  /** Its own id and the ids of the nodes at its ends: whose slots `paint` and `ends` are (a tile kept between sessions names them, `tilePieces.ts`). */
  readonly id?: number | undefined;
  readonly endIds?: readonly [number, number] | undefined;
  /** The carriageway between its junction mouths, arc length along the road. */
  readonly from: number;
  readonly to: number;
  readonly carriageway?: string | undefined;
  readonly footwayLeft?: FootwayMaterial | undefined;
  readonly footwayRight?: FootwayMaterial | undefined;
  /** A side whose footway is laid level with the carriageway (`roadTypes.ts` flushOn): no kerb stone, so none drawn on its footway. */
  readonly flushLeft?: boolean | undefined;
  readonly flushRight?: boolean | undefined;
}

/** Everything a pass's surfaces read besides the point: on the page the network's, in a worker the roads handed to it. */
export interface SurfaceReads {
  readonly field: RoadReads;
  /** The ground as it is drawn. */
  terrainAt(x: number, y: number): number;
  /** A road's centreline (an alignment's chain, `segmentAt`). */
  lineOf(id: SegmentId): Polyline | undefined;
  /** A road's look; undefined for one without a ribbon. */
  look(id: SegmentId): RoadLook | undefined;
  /** The share of `FOOTWAY_RISE` the footway stands at (`footwayRiseShare`). */
  footwayShare(x: number, y: number): number;
  /** The walking surface's share of it over a dropped kerb (`walkingRise`, on a footway). */
  walkingRise(x: number, y: number, structure: string): number;
}

/** One surface of a pass: what its shape is cut from and what each vertex reads. */
export interface SurfaceRead {
  readonly source: TileSource;
  readonly options: TileMeshOptions & { readonly name: string };
}

const offset = (base: HeightFn, amount: number): HeightFn => (x, y) => base(x, y) + amount;

/** The surfaces of a pass, outermost first. */
export function passSurfaces(pass: PassDesc, reads: SurfaceReads): SurfaceRead[] {
  const { field } = reads;
  const only: ReadonlySet<RoadStructure> = new Set([pass.structure]);
  const raised = pass.raised;
  const chainHit = { s: 0, distance: 0 };
  /** The segment of the pass a point belongs to: the one whose centreline is nearest. */
  const segmentAt = (x: number, y: number): SegmentId => {
    const chain = pass.chain!;
    if (chain.length === 1) return chain[0]!;
    let best = chain[0]!, bestD = Infinity;
    for (const id of chain) {
      const line = reads.lineOf(id);
      if (line) line.closestInto(x, y, chainHit);
      const d = line ? chainHit.distance : Infinity;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  };

  /** The single deck height every band of this structure is measured from. */
  const deck: HeightFn = pass.segment !== undefined
    ? (x, y) => field.onSegment(segmentAt(x, y), x, y)
    : (x, y) => field.at(x, y, only, false);
  /** Underside of a raised structure: the soffit of its deck. */
  const depth = roadStructure(pass.segment === undefined ? pass.structure : 'elevated').deck;
  const soffit: HeightFn = (x, y) => deck(x, y) - depth - FOOTWAY_RISE;

  /** A vertex's frame read into one object (`surfaceFrameInto`): DO NOT make one a vertex. */
  const at = { along: 0, across: 0 };
  const frameFor = (tile: number, panel?: number): UvFrameFn => (x, y, pickX, pickY, out) => {
    const segment = pass.segment === undefined ? undefined : segmentAt(pickX, pickY);
    const frame = field.surfaceFrameInto
      ? field.surfaceFrameInto(x, y, only, pickX, pickY, pass.segment !== undefined, segment, panel, at)
      : field.surfaceFrameAt(x, y, only, pickX, pickY, pass.segment !== undefined, segment, panel);
    out[0] = frame.across / tile;
    out[1] = frame.along / tile;
  };
  /** Road-framed UVs, with every triangle kept inside one road's frame. */
  const uvFor = (tile: number, panel?: number): { uv: UvFn; uvFrame: UvFrameFn } => {
    const uvFrame = frameFor(tile, panel);
    return { uv: (x, y, out) => uvFrame(x, y, x, y, out), uvFrame };
  };

  /** The carriageway's tint, taken from the class of the nearest road and normalised against the colour the asphalt texture */
  const asphaltTint: TintFn = (x, y, out) => {
    const sample = pass.segment === undefined ? field.roadAt(x, y, only, false) : null;
    const type = sample ? sample.type : pass.rootType;
    // A carriageway paved with something else than the class's asphalt takes that material's tone.
    const segment = sample ? sample.segment : segmentAt(x, y);
    const look = segment === undefined ? undefined : reads.look(segment);
    let material = look?.carriageway;
    // Between its junction mouths only
    if (material && sample && look) {
      if (offSpan(sample.along, look)) material = undefined;
    }
    const paving = material && material !== 'asphalt' ? pass.pavingTint[material] : undefined;
    if (paving) { out[0] = paving[0]; out[1] = paving[1]; out[2] = paving[2]; return; }
    const classes = pass.classTint;
    if (type >= 0 && type * 3 < classes.length) { out[0] = classes[type * 3]!; out[1] = classes[type * 3 + 1]!; out[2] = classes[type * 3 + 2]!; return; }
    out[0] = pass.referenceTint[0]; out[1] = pass.referenceTint[1]; out[2] = pass.referenceTint[2];
  };

  const suffix = pass.id === 'ground' ? '' : `-${pass.id}`;

  /** A point's place on the carriageway's road, for its lines and the marks of its use (`mesh/roadEdges.ts`, `roadPaint.ts`): across and along
   *  its road, and the road's place in the paint's table (its id); -1 on no road (a junction's plate has its own, `asphaltPlate`).
   *  DO NOT give a point past its road's mouth -1: the shader reads the slot of a triangle's last corner alone (`flat`), and a road's strip is one quad
   *  from mouth to mouth, a corner of it past the mouth where the mouth is skewed (9 m along against a span from 15 m, an avenue of the large city):
   *  half of every such road drew no line. The lines and marks are cut to their painted stretch in the shader (`CARRIAGEWAY_PAINT` inStretch). */
  const asphaltSection: TintFn = (x, y, out) => {
    const sample = field.roadAt(x, y, only, pass.segment !== undefined);
    const look = sample.segment === undefined ? undefined : reads.look(sample.segment);
    out[0] = sample.across;
    out[1] = sample.along;
    out[2] = !look || look.paint === undefined ? -1 : look.paint;
  };
  /** The same in the frame of the road nearest (pickX, pickY) (`TileMeshOptions.sectionFrame`): a triangle whose corners lie nearer two roads
   *  (the wedge two roads share at a bend) is read all of it on one, so its lines do not run between the two roads' frames. */
  const asphaltSectionFrame = (x: number, y: number, pickX: number, pickY: number, out: [number, number, number]): void => {
    const pick = field.roadAt(pickX, pickY, only, pass.segment !== undefined);
    const look = pick.segment === undefined ? undefined : reads.look(pick.segment);
    if (pick.segment === undefined || !look) { asphaltSection(x, y, out); return; }
    const frame = field.surfaceFrameAt(x, y, only, pickX, pickY, pass.segment !== undefined, pick.segment);
    out[0] = frame.across;
    out[1] = frame.along;
    out[2] = look.paint === undefined ? -1 : look.paint;
  };
  /** A vertex of a junction's plate (`TileMeshOptions.plateSection`): its node's slot as `-2 - slot` (`roadMarks.ts`: a plate's marks, never a
   *  road's lines), the node at the end of the road nearest it that it lies before (a plate's point is before its legs' mouths along each of them). */
  const asphaltPlate: TintFn = (x, y, out) => {
    const sample = field.roadAt(x, y, only, pass.segment !== undefined);
    const look = sample.segment === undefined ? undefined : reads.look(sample.segment);
    out[0] = 0;
    out[1] = -1;
    out[2] = !look?.ends ? -1 : -2 - (sample.along <= (look.from + look.to) / 2 ? look.ends[0] : look.ends[1]);
  };
  /** A point's place across the footway: metres from the kerb stone's back (under 0 over the stone's top: the footway runs from the carriageway's edge,
   *  and its shader draws the kerb's top there, `mesh/roadEdges.ts`; none on a side laid flush), and the footway's width to the lot. A junction's
   *  footway corner writes its own first number, its distance from its kerb's return (`roads/pieceMesh.ts` kerbDistances). */
  const footwaySection: TintFn = (x, y, out) => {
    const sample = field.roadAt(x, y, only, pass.segment !== undefined);
    const look = sample.segment === undefined ? undefined : reads.look(sample.segment);
    if (!look) { out[0] = 0; out[1] = -1; out[2] = -1; return; }
    const side = sample.across >= 0 ? sample.sidewalkLeft : sample.sidewalkRight;
    const flush = sample.across >= 0 ? look.flushLeft : look.flushRight;
    out[0] = Math.abs(sample.across) - look.width / 2 - (flush ? 0 : CURB_BAND);
    out[1] = Math.max(m(0.5), (side ?? sample.sidewalk ?? m(2)) - CURB_BAND);
    out[2] = 1;
  };

  /** The footway's tone: its side's material on the road nearest the point. */
  const footwayTint: TintFn = (x, y, out) => {
    const sample = field.roadAt(x, y, only, pass.segment !== undefined);
    const look = sample.segment === undefined ? undefined : reads.look(sample.segment);
    const material = look ? (sample.across >= 0 ? look.footwayLeft : look.footwayRight) : undefined;
    const tint = FOOTWAY_TINT[material ?? 'pavers'];
    out[0] = tint[0]; out[1] = tint[1]; out[2] = tint[2];
  };
  /** Where the footway stands: a kerb's rise over the carriageway, or level with it where it is laid flush. */
  const footwayTop: HeightFn = (x, y) => deck(x, y) + FOOTWAY_RISE * reads.footwayShare(x, y);

  // Outermost first, so a nearer band's wall lands on the one outside it.
  const specs: SurfaceRead[] = [
    // A raised deck's edge past its footways, a hair under the carriageway, its outer side the deck's face down to the soffit. On the ground there
    // is no band past the footway: the terrain meets its outer edge on the edge's own vertices (`terrainSeams.ts`).
    ...(raised ? [{
      source: { kind: 'band', band: 'deckEdge' },
      options: {
        name: `deck-edge${suffix}`,
        top: offset(deck, -DECK_EDGE_DROP),
        bottom: soffit,
        leastEdge: LEAST_EDGE,
        ...uvFor(pass.scale.deck),
        skirtUvScale: pass.scale.deck,
      },
    } satisfies SurfaceRead] : []),
    {
      source: { kind: 'band', band: 'footway' },
      options: {
        name: `footway${suffix}`,
        top: footwayTop,
        // Its walls: on a deck its outer side down to the deck's edge; on the ground only where a dropped kerb cuts it, down to the carriageway.
        bottom: raised ? offset(deck, -DECK_EDGE_DROP) : deck,
        leastEdge: LEAST_EDGE,
        // Laid at its true length on each line along a bend, a joint every few slabs
        ...uvFor(pass.scale.footway, pass.scale.footway * FOOTWAY_PANEL_TILES),
        tint: footwayTint,
        section: footwaySection,
        skirtUvScale: pass.scale.footway,
      },
    },
    {
      // The dropped kerbs at the zebras (`world/curbRamps.ts`)
      source: { kind: 'band', band: 'curbRamp' },
      options: {
        name: `curb-ramp${suffix}`,
        top: (x, y) => deck(x, y) + FOOTWAY_RISE * reads.footwayShare(x, y) * reads.walkingRise(x, y, pass.structure),
        bottom: raised ? offset(deck, -DECK_EDGE_DROP) : deck,
        leastEdge: RAMP_LEAST_EDGE,
        ...uvFor(pass.scale.footway),
        skirtUvScale: pass.scale.footway,
      },
    },
    {
      // The kerb stone's face, a wall from the footway's height down to the carriageway (`roads/pieceGeom.ts` face), and its end at a road's free
      // end; its top is the footway's, drawn by the footway's shader (`mesh/roadEdges.ts`), but where no footway runs behind it (its own band then).
      source: { kind: 'band', band: 'kerb' },
      options: {
        name: `kerb${suffix}`,
        top: footwayTop,
        bottom: deck,
        leastEdge: LEAST_EDGE,
        ...uvFor(pass.scale.kerb),
        skirtUvScale: pass.scale.kerb,
      },
    },
    {
      source: { kind: 'band', band: 'asphalt' },
      options: {
        name: `asphalt${suffix}`,
        top: deck,
        ...(raised ? { bottom: soffit } : {}),
        leastEdge: LEAST_EDGE,
        ...uvFor(pass.scale.asphalt),
        tint: asphaltTint,
        section: asphaltSection,
        sectionFrame: asphaltSectionFrame,
        plateOffRoad: true,
        plateSection: asphaltPlate,
        skirtUvScale: pass.scale.deck,
      },
    },
    {
      source: { kind: 'median', part: 'kerb' },
      options: {
        name: `median-kerb${suffix}`,
        top: offset(deck, MEDIAN_KERB),
        bottom: deck,
        leastEdge: LEAST_EDGE,
        ...uvFor(pass.scale.kerb),
        skirtUvScale: pass.scale.kerb,
      },
    },
    {
      source: { kind: 'median', part: 'planting' },
      options: {
        name: `median-planting${suffix}`,
        top: offset(deck, MEDIAN_PLANTING),
        bottom: offset(deck, MEDIAN_KERB),
        leastEdge: LEAST_EDGE,
        ...uvFor(pass.scale.verge),
        skirtUvScale: pass.scale.kerb,
      },
    },
    {
      // A median paved instead of planted: the footway's paving at the planting's height.
      source: { kind: 'median', part: 'paved' },
      options: {
        name: `median-paved${suffix}`,
        top: offset(deck, MEDIAN_PLANTING),
        bottom: offset(deck, MEDIAN_KERB),
        leastEdge: LEAST_EDGE,
        ...uvFor(pass.scale.footway),
        skirtUvScale: pass.scale.kerb,
      },
    },
  ];
  // On a deck the shapes' deck walls stand (`roads/pieceGeom.ts` deckWalls): its sides and its free ends.
  return raised ? specs.map((spec) => ({ ...spec, options: { ...spec.options, deck: true } })) : specs;
}
