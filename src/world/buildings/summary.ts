import { Digest } from '@core/digest';
import { legacyFlag } from './flags';
import { buildingHeight, storedBounds } from './geometry';
import { signatureKind } from './towerKit';
import type { Building, RoofDetail } from './types';

/**
 * WHAT IS READ OF A BUILDING WITHOUT ITS RECORD, AS A TABLE'S SUMMARY COLUMNS (`recordTable.ts` format 3, `SUMMARY_*`): its height, its
 * module, its record's digests with and without its wear, its marks (a flag flown, a signature body), the box of the ground it reads and the
 * minute it was built (its wear's clock, `decayWatch.ts`). Worked out ONCE, where the record
 * is decoded anyway (the city's generator, the save's join, a square written), and copied with the row after (`TableWriter.copyRows`). The
 * page files the town from these columns (`render/buildings/townColumns.ts` fileRow). DO NOT decode a city's every building at its
 * opening to learn them: the 10 km city's 249,122 were decoded in one frame of its opening, by the buildings' layer alone (2026-10-26).
 */

/** It flies a flag: a spire or a lantern with a flag of its own or a fixed one (`render/buildings/buildingMesh.ts` emits it). */
export const MARK_FLIES = 1;
/** A signature building: its body drawn with parts of its own (`render/buildings/signature.ts`, one design for every `TOWER_KINDS`). */
export const MARK_SIGNATURE = 2;

/** The summary columns, in their order: the height, the module, the two digests, the marks, the box of the ground the building reads (`storedBounds(b, b.module * 2)`: grown in the building's own frame, then turned), and its `builtAt` (NaN: none). */
export const SUMMARY_HEIGHT = 0, SUMMARY_SIG = 2, SUMMARY_MASS_SIG = 3, SUMMARY_MARKS = 4;
export const SUMMARY_GROUND_MIN_X = 5, SUMMARY_GROUND_MIN_Y = 6, SUMMARY_GROUND_MAX_X = 7, SUMMARY_GROUND_MAX_Y = 8, SUMMARY_BUILT_AT = 9;
/** How many summary columns a building's table holds. */
export const SUMMARY_WIDTH = 10;

/** A roof part's flag, or null: its own design, else the fixed one it names. */
const flagOf = (detail: RoofDetail): unknown => (!detail.flag || detail.flag === 'none' ? null : detail.flagDesign ?? legacyFlag(detail.flag));

/** Whether a building flies a flag (a spire or a lantern with one). */
export function fliesFlag(b: Building): boolean {
  return b.volumes.some((v) => (v.roofDetails ?? []).some((d) => (d.kind === 'spire' || d.kind === 'lantern') && flagOf(d) !== null));
}

/** Whether a building is drawn as a signature (its blueprint names one of `TOWER_KINDS`, each of which has its design). */
export const isSignature = (b: Building): boolean => signatureKind(b) !== null;

/** Each member object's digest, once: a record's members are shared with other buildings (`intern.ts`, `SharedMembers`: a storey, a facade, a material once for the city) and never edited in place (records are replaced), so one hashed is hashed for every building that has it. */
function memberDigest(member: object, known: WeakMap<object, number>): number {
  let d = known.get(member);
  if (d === undefined) {
    d = new Digest().addPlain(member).value();
    known.set(member, d);
  }
  return d;
}

/** The digest of a record with its wear and without it (`massing.ts` reads no wear): what its detail and its masses are made of.
 *  DO NOT walk the whole record twice, nor its shared members again for every building: filing a reopened city of 8,102 buildings
 *  spent 0.77 s of the page here (`npm run diagnose`, 2026-10-22). The shape once (members by their digest), the wear over it. */
export function recordDigests(b: Building, members: WeakMap<object, number> = new WeakMap()): { readonly sig: number; readonly massSig: number } {
  const shape = new Digest();
  const record = b as unknown as Record<string, unknown>;
  let keys = 0;
  for (const key in record) {
    const value = record[key];
    if (key === 'decay' || value === undefined || typeof value === 'function') continue;
    shape.addText(key);
    if (typeof value === 'object' && value !== null) shape.add(memberDigest(value, members));
    else shape.addPlain(value);
    keys++;
  }
  const massSig = shape.add(keys).value();
  return { sig: wornDigest(massSig, b.decay ?? null), massSig };
}

/** A record's digest from its digest without its wear and its wear (null: none): what `recordDigests` gives, for a row of a table worn as its field (`TableItems.writeField`) without decoding it. */
export function wornDigest(massSig: number, decay: number | null): number {
  return new Digest().add(massSig).addPlain(decay).value();
}

/** A building's summary columns (`SUMMARY_*`). */
function buildingSummary(b: Building, members: WeakMap<object, number>): number[] {
  const { sig, massSig } = recordDigests(b, members);
  const ground = storedBounds(b, b.module * 2);
  return [buildingHeight(b), b.module, sig, massSig, (fliesFlag(b) ? MARK_FLIES : 0) | (isSignature(b) ? MARK_SIGNATURE : 0),
    ground.minX, ground.minY, ground.maxX, ground.maxY, b.builtAt ?? Number.NaN];
}

/** The buildings' summary as a table writer takes it (`TableWriter` summary): its width, and each record's columns, its members' digests kept across the rows of one writer. */
export function buildingSummaryColumns(): { readonly width: number; of(b: Building): readonly number[] } {
  const members = new WeakMap<object, number>();
  return { width: SUMMARY_WIDTH, of: (b) => buildingSummary(b, members) };
}
