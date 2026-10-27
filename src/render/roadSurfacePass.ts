import type { SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import type { RoadReads } from '@world/roadField';
import { Level, laneWidth } from '@world/roadTypes';
import { footwayRiseShare } from '@world/roads/footwayRise';
import { walkingRise } from '@world/curbRamps';
import { RAISED_LIFT, isRaised, roadStructure } from '@world/structures';
import type { Reach, SurfacePass } from './roadSurfaceInputs';
import type { PassDesc, RoadLook, SurfaceReads } from './roadSurfaceReads';
import type { Tile } from './mesh/tileMesh';
import type { Geom, PieceReach } from './roads/pieceGeom';
import { type MeshedSurface, pieceBundle } from './roads/pieceMesh';
import { roadAlongPaint } from './roadMarks';
import { roadPaint } from './roadPaint';

/** ONE PASS OF THE ROADS' SURFACES AS PLAIN DATA (`roadSurfaces.ts` on the page, `nearRoadTiles.ts` in a worker): what it reads, how it is described and each of its tiles' surfaces, the same code on both sides */

/** DO NOT refine a surface to a grid of some edge (half a terrain cell on the ground, a cell raised): its vertices are its pieces' strips and fans,
 *  stationed where the ground leaves their chords (`mesh/stripShape.ts` stationsOf); a large city's flat streets drew 6 M triangles of a plane on
 *  that grid (2026-10-20). */

/** The page's constants a pass is drawn with: its materials' texture scales, the carriageway's tints (made on the page with three's colour management); numbers, handed to a worker as they are. */
export interface PassLook {
  readonly scale: PassDesc['scale'];
  readonly classTint: readonly number[];
  readonly referenceTint: readonly [number, number, number];
  readonly pavingTint: Readonly<Record<string, readonly [number, number, number]>>;
}

/** The road a surface reads beside the field, as a pass sees it (`RoadLook`): its paving, widths and mouths. `ids`: its paint's slot its own id and its
 *  ends' its nodes' ids (a job's, whose page resolves them, `networkFarRoads.ts`), its lines not written in this thread's table. */
export function lookOf(net: Network, id: SegmentId, ids = false): RoadLook | undefined {
  const ribbon = net.ribbons.get(id);
  const segment = net.doc.segment(id);
  if (!ribbon || !segment) return undefined;
  const trims = net.trims.get(id);
  const materials = ribbon.road.materials;
  const lane = laneWidth(ribbon.road);
  return {
    width: ribbon.road.width,
    lane,
    // Its lines along it and its widths in the carriageway shader's table, at its slot (`roadPaint.ts`); its ends' plates' slots, for a plate's vertices.
    paint: ids ? id : roadPaint.set(net.doc, id, roadAlongPaint(net, ribbon), ribbon.road.width / 2, lane),
    ends: ids ? [segment.a, segment.b] : [roadPaint.nodeSlot(net.doc, segment.a), roadPaint.nodeSlot(net.doc, segment.b)],
    id,
    endIds: [segment.a, segment.b],
    from: trims?.a[Level.Asphalt] ?? 0,
    to: ribbon.full.length - (trims?.b[Level.Asphalt] ?? 0),
    carriageway: materials?.carriageway,
    footwayLeft: materials?.footwayLeft,
    footwayRight: materials?.footwayRight,
    flushLeft: ribbon.road.flushLeft,
    flushRight: ribbon.road.flushRight,
  };
}

/** Whether a pass is drawn as a raised deck: an alignment lifted by hand where some point of its roads stands a structure's lift over the ground; a structural level by its kind. */
export function passRaised(net: Network, pass: SurfacePass, elevation: Pick<RoadReads, 'onSegment'>, terrainAt: (x: number, y: number) => number): boolean {
  if (pass.chain === undefined) return isRaised(roadStructure(pass.structure).id);
  return pass.chain.some((id) => {
    const line = net.ribbons.get(id)?.full;
    if (!line) return false;
    for (let s = 0; s <= line.length; s += Math.max(4, line.length / 24)) {
      const p = line.sampleAt(s).p;
      if (elevation.onSegment(id, p.x, p.y) - terrainAt(p.x, p.y) > RAISED_LIFT) return true;
    }
    return false;
  });
}

/** What a pass's surfaces read where the network is at hand (the page's, or a worker's own): the solved field, the ground as drawn, each road's look and line, the footways' rise (made once a pass). */
export function passReads(net: Network, elevation: RoadReads, terrainAt: (x: number, y: number) => number, ids = false): SurfaceReads {
  /** Each road's look, asked per vertex: made once a pass. */
  const looks = new Map<SegmentId, RoadLook | undefined>();
  const look = (id: SegmentId): RoadLook | undefined => {
    if (!looks.has(id)) looks.set(id, lookOf(net, id, ids));
    return looks.get(id);
  };
  return {
    field: elevation,
    terrainAt,
    lineOf: (id) => net.ribbons.get(id)?.full,
    look,
    footwayShare: (x, y) => footwayRiseShare(net, x, y),
    walkingRise: (x, y, at) => walkingRise(net, x, y, true, at),
  };
}

/** The pass as its surfaces read it, plain data: the same on the page and in a worker (`roadSurfaceReads.ts`). */
export function passDesc(net: Network, pass: SurfacePass, raised: boolean, look: PassLook): PassDesc {
  const structure = roadStructure(pass.structure);
  return {
    id: pass.id,
    structure: structure.id,
    ...(pass.segment !== undefined ? { segment: pass.segment } : {}),
    ...(pass.chain !== undefined ? { chain: pass.chain } : {}),
    rootType: pass.segment === undefined ? 0 : net.doc.segment(pass.segment)?.type ?? 0,
    raised,
    scale: { asphalt: look.scale.asphalt, footway: look.scale.footway, kerb: look.scale.kerb, verge: look.scale.verge, deck: look.scale.deck },
    classTint: look.classTint,
    referenceTint: look.referenceTint,
    pavingTint: look.pavingTint,
  };
}

/** A part's shapes without their boxes and digests, by surface: what a worker meshes it from (`roads/pieceMesh.ts`). */
export function geomsOf(into: Reach): PieceReach {
  const out = new Map<string, readonly Geom[]>();
  for (const [slot, inputs] of into) out.set(slot, inputs.map((input) => input.geom));
  return out;
}

/** Every surface of a piece, meshed whole from its shapes, each vertex read here: by surface name, in the order of `specs`; `only`, those named
 *  alone (`pieceBundle`). */
export function tileBundle(into: Reach, specs: readonly MeshedSurface[], only?: ReadonlySet<string>): Map<string, Tile> {
  return pieceBundle(geomsOf(into), specs, only);
}
