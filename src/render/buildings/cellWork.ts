import type { Finish } from '@world/buildings/materials';
import { eachRecord, readRecords } from '@world/buildings/recordTable';
import { type PavingData, pavingReader } from '@world/paving';
import { type GroundReaders, type SharedGroundData, sharedGroundReaders } from '../sharedGround';
import { ShellWriter, emitLotsAt, emitProgram, letGoEmitted, type ProgramWants } from './buildingMesh';
export { ShellWriter } from './buildingMesh';
import { type CellArrays, type CellMass, type CellSelection, type KitBoxes, cellArrays, cellBuffers, cellMass, cellMassBuffers, joinMass } from './cellArrays';
import type { BuildingChunk, CellJobEntry, LotGroundRecipe } from './chunk';
import type { Building } from '@world/buildings/types';
import type { FlagInstance } from './flagLayer';
import { COARSE_PARTS, DETAIL_PARTS, PART_KINDS } from './partKinds';
import { DETAIL_CELL } from './partFiling';
import { CELL_DETAIL, type MassDetail, PLATE_DETAIL, TILE_DETAIL, baseFloor, massFloor, massOf, type MassingChunk } from './massing';
import { type PartFiling, fileParts, filingBuffers, shellPieceOf } from './partFiling';
import { levelCells } from './levelKeys';
import { type BaseMass, type BaseSlice, BaseWriter, baseBuffers, writeBase } from './massBase';
import { type BuildingProgram, type LotsProgram, type ProgramSummary, ProgramCache, summaryOf } from './program';
import { PartyWalls } from './partyWalls';

/** DO NOT send the page a chunk per building */

export type { CellEntry } from './chunk';

/** What a job makes: a cell's detail (its coarse batch and its detail cells'), the same at the far level (`facade`: L1, `emitChunk` `far`), a cell's buildings faded */
/** 'massTile' and 'massPlate': the masses of a 1,000 m tile (L2) and a 2,000 m plate (L3) merged, simplified to their level (`massLevels.ts`); 'massBase': a plate's square at the top level, its blocks' prisms (`massBase.ts`). */
export type JobKind = 'cell' | 'mass' | 'summary' | 'facade' | 'massTile' | 'massPlate' | 'massBase';

/** What each kind of masses leaves out (`massing.ts` `MassDetail`). */
const MASS_DETAIL: Partial<Readonly<Record<JobKind, MassDetail>>> = { mass: CELL_DETAIL, massTile: TILE_DETAIL, massPlate: PLATE_DETAIL };

/** A cell of a tile's, a plate's or a base's job whose slice is not kept (`CellJob.spans`): how many of the job's entries are its buildings, in order. */
export interface CellSpan {
  readonly cell: string;
  readonly count: number;
}

/** A CELL'S SLICE OF A SQUARE'S LEVEL, kept between jobs (`cellPool.ts` SliceStore, the derived cache): its buildings' masses at the tile's or the
 *  plate's detail merged in floats (`cellMass` with no square; null: none), or its base (`BaseWriter.sliceOf`). A tile, a plate and a base are
 *  joined from their cells' slices (`joinMass`, `BaseWriter.put`): an edit makes its cell's slices again, its buildings alone walked, every other
 *  cell's read as kept. */
export interface CellSlice {
  readonly mass?: CellMass | null;
  readonly base?: BaseSlice | null;
}
export interface KeptSlice {
  readonly cell: string;
  readonly slice: CellSlice;
}

export interface CellJob {
  readonly id: number;
  readonly kind: JobKind;
  /** The coarse cell the entries stand in (`BATCH_CELL`). */
  readonly cell: string;
  readonly entries: readonly CellJobEntry[];
  /** Whether the page has paving to read. */
  readonly paved: boolean;
  /** The roads near the cell, to read the paving here instead of asking the page (`world/paving.ts`). */
  readonly paving?: PavingData;
  /** The ground in shared memory, read here as the page reads it (`sharedGround.ts`); none when the job is done on the page. */
  readonly ground?: SharedGroundData;
  /** Where the ground was cut to its plates around the job (`groundAround`: a job for another process); a read past them asks the job again (`wider`). */
  readonly around?: readonly [number, number, number, number];
  /** The page reads the natural ground as the drawn one (`layer.ts` `update`, `naturalAt` left out). */
  readonly naturalIsGround?: boolean;
  /** The kit's part boxes and each finish's colour from afar (`kit.ts` `finishTone`): the job carries all it reads. */
  readonly boxes: KitBoxes;
  readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>;
  /** A cell's detail or facade level within twice the detail's reach (`massCells.ts` PAIR_REACH): each building walked once for both, kept
   *  together (`JobPrograms.levels`), so the cell stepping to the other level as the eye moves reads it, no walk. */
  readonly pair?: boolean;
  /** A tile's, a plate's or a base's job joined from its cells' slices: the cells its entries are the buildings of, in order (`CellSpan`, those
   *  whose slice is not kept: made here and handed back, `CellResult.slices`), and the slices kept of its other cells (their buildings not sent).
   *  Absent: every building walked, nothing kept (a job on the page, no store). */
  readonly spans?: readonly CellSpan[];
  readonly slices?: readonly KeptSlice[];
}

/** What the page keeps of a building emitted: its flags, how its lots' ground is made again, its signature floor. */
export interface ChunkSummary {
  readonly key: string;
  readonly flags?: readonly FlagInstance[];
  readonly lot: LotGroundRecipe | null;
  readonly signatureFloor?: number;
}

export interface CellResult {
  /** The coarse batch ('cell'); none for a summary or masses. */
  readonly batch: CellArrays | null;
  /** The cell's parts by band and detail cell, filed here (`partFiling.ts`): null for a summary or masses, or none. */
  readonly parts: PartFiling | null;
  /** The buildings this job emitted whole. */
  readonly summaries: readonly ChunkSummary[];
  /** The cell's masses ('mass'): null when none of its buildings has any. */
  readonly mass?: CellMass | null;
  /** A square's base ('massBase'): null with no building. */
  readonly base?: BaseMass | null;
  /** Each entry's ground floor as the job stood it (`CellEntry.floor`): null with no closed block, undefined where it read none; kept by the page for the next jobs of the same buildings (`cellPool.ts`). */
  readonly floors?: readonly (number | null | undefined)[];
  /** The slices a tile's, a plate's or a base's job made of its cells not kept (`CellJob.spans`), for the page to keep. */
  readonly slices?: readonly KeptSlice[];
}

export type WorkReply =
  /** The paving was read past the roads handed over, or the ground past the plates (`CellJob.around`): the job is asked again with them over `rect` (rare: a building reaching far out of its cell). */
  | { readonly kind: 'wider'; readonly job: number; readonly rect: readonly [number, number, number, number] }
  | { readonly kind: 'done'; readonly job: number; readonly result: CellResult }
  | { readonly kind: 'error'; readonly job: number; readonly message: string };

/** Every buffer of a reply: handed over, not copied (MDN, `postMessage` transfer). */
export function replyBuffers(reply: WorkReply): ArrayBuffer[] {
  if (reply.kind !== 'done') return [];
  const out = reply.result.batch ? cellBuffers(reply.result.batch) : [];
  if (reply.result.parts) out.push(...filingBuffers(reply.result.parts));
  if (reply.result.mass) out.push(...cellMassBuffers(reply.result.mass));
  if (reply.result.base) out.push(...baseBuffers(reply.result.base));
  for (const { slice } of reply.result.slices ?? []) {
    if (slice.mass) out.push(...cellMassBuffers(slice.mass));
    if (slice.base) out.push(slice.base.position.buffer as ArrayBuffer, slice.base.paint.buffer as ArrayBuffer, slice.base.grid.buffer as ArrayBuffer, slice.base.index.buffer as ArrayBuffer);
  }
  return out;
}

/** What a job reads: the ground (shared, or the page's own), and the paving, undefined where it cannot be read here. */
interface CellReads extends GroundReaders {
  readonly pavedAt?: (x: number, y: number) => number | undefined;
  /** The worker's own shell and rows (`ShellWriter`): DO NOT make them for each job, their arrays grown again from nothing. */
  readonly writer?: ShellWriter;
  /** The box of the reads on plates the job was not handed (`CellJob.around`); null when none. */
  readonly groundMissed?: () => readonly [number, number, number, number] | null;
}

/** A job's reads in a worker: the shared ground, the paving off the roads it was handed (reading the shared natural ground where they need it). */
export function workerReads(job: CellJob, writer?: ShellWriter): CellReads {
  if (!job.ground) throw new Error(`[buildings] a cell job with no shared ground (${job.cell})`);
  const miss: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const shared = sharedGroundReaders(job.ground, (x, y) => {
    if (x < miss[0]) miss[0] = x;
    if (y < miss[1]) miss[1] = y;
    if (x > miss[2]) miss[2] = x;
    if (y > miss[3]) miss[3] = y;
  });
  const naturalAt = job.naturalIsGround ? shared.groundAt : shared.naturalAt;
  const pavedAt = job.paving ? pavingReader(job.paving, naturalAt) : undefined;
  const groundMissed = (): readonly [number, number, number, number] | null => (miss[0] <= miss[2] ? miss : null);
  return { groundAt: shared.groundAt, naturalAt, groundMissed, ...(pavedAt ? { pavedAt } : {}), ...(writer ? { writer } : {}) };
}

/** THE PROGRAMS THIS WORKER KEEPS (`program.ts`): a building walked once (`emitProgram`), every later job of it reading its program, each
 *  level a filter over it. A few tens of MB: a worker is a heap in the page's V8 cage (`jobPool.ts`). */
const PROGRAMS = new ProgramCache(32 * 2 ** 20);
/** The programs this thread keeps: what it holds, the walks and the reads counted (`ProgramCache`). */
export const keptPrograms = (): ProgramCache => PROGRAMS;

/** A building body's key: the building and its record (`CellEntry.sig`: an edit changes it, so only the edited building is walked again), the
 *  ground under it and whether paving is read, the masses' tone. NOT its floor: the body is kept over its floor (`program.ts`), whatever floor
 *  a job stands it on; its lots are kept by floor beside it, and its levels (laid on the floor) by floor and covers. */
const bodyKey = (entry: CellJobEntry, paved: boolean, tone: string): string => `${entry.key}|${entry.sig}|${entry.digest}|${paved ? 1 : 0}|${tone}`;
const floorKey = (floor: number | null): string => `${floor ?? '-'}`;
const toneKeyOf = (tone: CellJob['tone']): string => (tone ? JSON.stringify(tone) : '');

/** A job's buildings' programs: kept, or walked now for what the job draws and kept at once - DO NOT hold a job's every program until it is
 *  done (a plate's thousands of buildings in the worker's heap at once, `cellJobMemory.spec.ts`); let go again if the job read past what it
 *  was handed (`undo`: its reads were short, its programs wrong). */
class JobPrograms {
  private readonly made: string[] = [];
  private readonly madeLots: string[] = [];
  constructor(private readonly tone: string, private readonly paved: boolean) {}

  /** Its body and its lots on `floor`: the body walked (`walk`) only where none is kept, the lots alone (`lotsAt`) where the body is kept
   *  on another floor - the bases' estimate (`baseFloor`) and then the cell's measured floor (`massFloor`) walk the building once. */
  mass(entry: CellJobEntry, floor: number | null, walk: () => BuildingProgram, lotsAt: () => LotsProgram): BuildingProgram {
    const body = bodyKey(entry, this.paved, this.tone);
    const kept = PROGRAMS.get(`m|${body}`);
    if (!kept) {
      PROGRAMS.walks++;
      const made = walk();
      this.keepBody(body, made);
      return made;
    }
    PROGRAMS.hits++;
    const lots = this.lotsOn(body, kept, floor, lotsAt);
    return lots === kept.lots ? kept : { mass: kept.mass, flags: kept.flags, lots };
  }

  /** The levels `wants` asks for, with its neighbours' covers (`coversKey`), on `floor`: a level already walked read as it was, a missing one walked alone. */
  levels(entry: CellJobEntry, floor: number | null, covers: string, wants: ProgramWants, walk: (wants: ProgramWants) => BuildingProgram): BuildingProgram {
    const body = bodyKey(entry, this.paved, this.tone);
    const key = `l|${body}|${floorKey(floor)}|${covers}`;
    const kept = PROGRAMS.get(key);
    if (kept && (!wants.near || kept.near) && (!wants.far || kept.far)) { PROGRAMS.hits++; return kept; }
    PROGRAMS.walks++;
    const fresh = walk({ near: wants.near && !kept?.near, far: wants.far && !kept?.far });
    const made: BuildingProgram = kept ? { ...fresh, ...(kept.near ? { near: kept.near } : {}), ...(kept.far ? { far: kept.far } : {}) } : fresh;
    this.keep(key, made);
    // Its body and its lots on the same floor, read by the masses' jobs too.
    this.keepBody(body, made);
    return made;
  }

  /** A body kept on another floor than `floor`: its lots on `floor`, kept, or walked alone now. */
  private lotsOn(body: string, kept: BuildingProgram, floor: number | null, lotsAt: () => LotsProgram): LotsProgram {
    if (kept.lots.floor === floor) return kept.lots;
    const key = `L|${body}|${floorKey(floor)}`;
    const was = PROGRAMS.getLots(key);
    if (was) return was;
    PROGRAMS.lotWalks++;
    const lots = lotsAt();
    PROGRAMS.setLots(key, lots);
    this.madeLots.push(key);
    return lots;
  }

  private keepBody(body: string, made: BuildingProgram): void {
    this.keep(`m|${body}`, { mass: made.mass, flags: made.flags, lots: made.lots });
    PROGRAMS.setLots(`L|${body}|${floorKey(made.lots.floor)}`, made.lots);
    this.madeLots.push(`L|${body}|${floorKey(made.lots.floor)}`);
  }

  private keep(key: string, program: BuildingProgram): void {
    PROGRAMS.set(key, program);
    this.made.push(key);
  }

  /** The programs this job walked let go: it read past what it was handed (`wider`), so they stand on reads it did not have. */
  undo(): void {
    for (const key of this.made) PROGRAMS.delete(key);
    for (const key of this.madeLots) PROGRAMS.deleteLots(key);
    this.made.length = 0;
    this.madeLots.length = 0;
  }
}

/** A party's covers of a building as a key: the neighbours' blocks its bays are hidden behind (`partyWalls.ts`). */
function coversKey(party: PartyWalls, b: Building): string {
  return party.coversNear(b).map((c) => `${c.bottom.toFixed(3)},${c.top.toFixed(3)}:${c.ring.map((q) => `${q.x.toFixed(3)},${q.y.toFixed(3)}`).join(';')}`).join('/');
}

const COARSE: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS.filter((k) => COARSE_PARTS.has(k)), shells: true, furniture: true };
const DETAIL: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS.filter((k) => DETAIL_PARTS.has(k)), shells: false, furniture: false };

/** DO NOT ask the page for the ground in rounds: a cell's job reads every height itself (`sharedGround.ts`), in one pass, nothing kept once it is done */
export function runCellJob(job: CellJob, reads: CellReads): WorkReply {
  // A paving point past the roads handed over: the box of them, to ask the job again over it (`wider`).
  let missX0 = Infinity, missY0 = Infinity, missX1 = -Infinity, missY1 = -Infinity;
  const pavedHere = reads.pavedAt;
  const paved = job.paved
    ? (x: number, y: number): number => {
      const value = pavedHere?.(x, y);
      if (value !== undefined) return value;
      if (x < missX0) missX0 = x;
      if (y < missY0) missY0 = y;
      if (x > missX1) missX1 = x;
      if (y > missY1) missY1 = y;
      return NaN;
    }
    : undefined;
  /** Whether anything was read past what the job was handed: the paving's misses, and the ground's put with them. */
  const missed = (): boolean => {
    const ground = reads.groundMissed?.();
    if (ground) {
      missX0 = Math.min(missX0, ground[0]); missY0 = Math.min(missY0, ground[1]);
      missX1 = Math.max(missX1, ground[2]); missY1 = Math.max(missY1, ground[3]);
    }
    return missX0 <= missX1;
  };
  const { groundAt, naturalAt } = reads;
  // EVERY KIND OF JOB A FILTER OVER THE BUILDINGS' PROGRAMS (`program.ts`): each building walked once (`emitProgram`), kept by its record,
  // and the base, the masses, the summary, the facade level and the detail each drawn from it; an edited building walked again, it alone.
  const programs = new JobPrograms(toneKeyOf(job.tone), job.paved);
  const tone = job.tone;
  const stage = (floor: number | null): { floor: number | null; tone?: NonNullable<CellJob['tone']> } => (tone ? { floor, tone } : { floor });
  if (job.kind === 'massBase') {
    // The top level: each building's blocks' prisms, in its cell's run, on its floor as seen from afar (`baseFloor`) where no job measured it yet.
    // DO NOT measure the exact floor here (`massFloor`, the bays laid out): every building of the map is in a base, and the curtain waits for every base (`layer.ts` coarsePending) - 70,000 floors were ~22 s of the workers behind the opening of the step-70k city (2026-10-22). Nor hand the estimate on (`floors`): the finer levels stand on the exact one.
    const writer = new BaseWriter();
    const floors: (number | null | undefined)[] = [];
    let n = 0;
    for (const b of eachRecord(job.entries.map((entry) => entry.record))) {
      const entry = job.entries[n]!;
      const given = entry.floor;
      const floor = given !== undefined ? given : baseFloor(b, naturalAt, paved) ?? null;
      floors.push(given);
      n++;
      const program = programs.mass(entry, floor, () => emitProgram(b, groundAt, paved, naturalAt, { near: false, far: false }, stage(floor)),
        () => emitLotsAt(b, floor, groundAt, paved));
      writeBase(writer.cellOf(b), program);
    }
    if (missed()) { programs.undo(); return wider(job, missX0, missY0, missX1, missY1); }
    // Joined from its cells' slices: those kept put as they were, those walked here handed back to keep.
    for (const { cell, slice } of job.slices ?? []) if (slice.base) writer.put(cell, slice.base);
    const made: KeptSlice[] | undefined = job.spans && job.slices ? job.spans.map(({ cell }) => ({ cell, slice: { base: writer.sliceOf(cell) } })) : undefined;
    return { kind: 'done', job: job.id, result: { batch: null, parts: null, summaries: [], base: writer.done(levelCells(job.cell)), floors, ...(made ? { slices: made } : {}) } };
  }
  const detail = MASS_DETAIL[job.kind];
  if (detail) {
    const masses: MassingChunk[] = [];
    const floors: (number | null | undefined)[] = [];
    // Joined from its cells' slices (`CellJob.spans`): each cell's buildings' masses apart, merged into its slice.
    const spans = job.spans;
    const sliced: MassingChunk[][] = spans ? spans.map(() => []) : [];
    let span = 0, inSpan = 0;
    // A tile's and a plate's masses are drawn from afar, as the base is: on the floor seen from afar where none was measured (`baseFloor`), never handed on. DO NOT lay every building's bays out for them: with the bases' estimate (no floor handed on) the plates of the step-70k city took ~3 s of a worker each after the curtain, the map standing in cells' masses (2026-10-22).
    const far = job.kind !== 'mass';
    // One record at a time, let go once its masses are made: a plate's job is four tiles of buildings (`eachRecord`).
    let n = 0;
    for (const b of eachRecord(job.entries.map((entry) => entry.record))) {
      const entry = job.entries[n]!;
      // DO NOT measure a floor an earlier job of the same building on the same ground measured (`CellEntry.floor`).
      const given = entry.floor;
      const floor = given !== undefined ? given : (far ? baseFloor(b, naturalAt, paved) : massFloor(b, naturalAt, paved)) ?? null;
      floors.push(far ? given : floor);
      n++;
      const program = programs.mass(entry, floor, () => emitProgram(b, groundAt, paved, naturalAt, { near: false, far: false }, stage(floor)),
        () => emitLotsAt(b, floor, groundAt, paved));
      const mass = massOf(program, detail);
      if (spans) {
        while (inSpan >= spans[span]!.count) { span++; inSpan = 0; }
        inSpan++;
        if (mass) sliced[span]!.push(mass);
      } else if (mass) masses.push(mass);
    }
    // On the square's grid (`cellArrays.ts` `massGrid`): a cell's, a tile's or a plate's.
    const at = job.cell[1] === ':' ? levelCells(job.cell) : { i0: Number(job.cell.slice(0, job.cell.indexOf(','))), j0: Number(job.cell.slice(job.cell.indexOf(',') + 1)), n: 1 };
    if (missed()) { programs.undo(); return wider(job, missX0, missY0, missX1, missY1); }
    if (spans) {
      // Each cell's slice in floats; the level its cells' slices joined in the cells' order (`MassLevels` lists them column by column), as its buildings' chunks merged at once.
      const made: KeptSlice[] = spans.map(({ cell }, k) => ({ cell, slice: { mass: cellMass(sliced[k]!) } }));
      const all = [...made, ...(job.slices ?? [])].sort((p, q) => cellOrder(p.cell, q.cell));
      const mass = joinMass(all.flatMap(({ slice }) => (slice.mass ? [slice.mass] : [])), at);
      return { kind: 'done', job: job.id, result: { batch: null, parts: null, summaries: [], mass, floors, ...(job.slices ? { slices: made } : {}) } };
    }
    return { kind: 'done', job: job.id, result: { batch: null, parts: null, summaries: [], mass: cellMass(masses, at), floors } };
  }
  // DO NOT parse a text per building: each record decoded from its tile's shared table, a tile's shared members once for the job.
  const buildings = readRecords(job.entries.map((entry) => entry.record));
  /** What the page keeps of a building, from its program's summary. */
  const keptOf = (summary: ProgramSummary, i: number): ChunkSummary => {
    const { flags, lotGround, signatureFloor } = summary;
    return { key: job.entries[i]!.key, ...(flags ? { flags } : {}), lot: lotGround?.recipe ?? null, ...(signatureFloor !== undefined ? { signatureFloor } : {}) };
  };
  // Each floor once for the job, those an earlier job measured not again (`CellEntry.floor`).
  const known = job.entries.map((entry) => entry.floor);
  // The buildings of the cell as one another's neighbours: a party wall's covered bays not laid, each floor worked out once (`partyWalls.ts`).
  const party = new PartyWalls(buildings, naturalAt, paved, known);
  if (job.kind === 'summary') {
    // The summary: the mass stage alone (its lots' recipe, its flags, its floor), no level laid.
    const summaries = buildings.map((b, i) => {
      const floor = party.floorOf(b) ?? null;
      const program = programs.mass(job.entries[i]!, floor, () => emitProgram(b, groundAt, paved, naturalAt, { near: false, far: false }, stage(floor)),
        () => emitLotsAt(b, floor, groundAt, paved));
      return keptOf(summaryOf(program), i);
    });
    if (missed()) { programs.undo(); return wider(job, missX0, missY0, missX1, missY1); }
    return { kind: 'done', job: job.id, result: { batch: null, parts: null, summaries, floors: party.floorsKnown() } };
  }
  // One shell and one set of rows written again for each building of the job, and of every job the worker runs (`CellReads.writer`).
  const writer = reads.writer ?? new ShellWriter();
  const wants: ProgramWants = job.pair ? { near: true, far: true } : { near: job.kind !== 'facade', far: job.kind === 'facade' };
  const programsOf = buildings.map((b, i) => {
    const floor = party.floorOf(b) ?? null;
    const program = programs.levels(job.entries[i]!, floor, coversKey(party, b), wants,
      (asked) => emitProgram(b, groundAt, paved, naturalAt, asked, { party, writer, ...stage(floor) }));
    // Its furniture and bays let go now: the job reads them no more (`letGoEmitted`).
    letGoEmitted(b);
    return program;
  });
  const chunks = programsOf.map((p) => (job.kind === 'facade' ? p.far : p.near)!);
  if (missed()) { programs.undo(); return wider(job, missX0, missY0, missX1, missY1); }
  const summaries = chunks.map(keptOf);
  // The far level's shells on the cell's grid (`cellArrays.ts` `ShellGrid`); the detail's in floats (its millimetre steps).
  const comma = job.cell.indexOf(',');
  const grid = job.kind === 'facade' ? [Number(job.cell.slice(0, comma)), Number(job.cell.slice(comma + 1))] as const : undefined;
  // The detail cells inside, each its buildings in the cell's order (`layerCells.ts` `chunksByCell`).
  const detailOf = buildings.map((b) => `${Math.floor(b.x / DETAIL_CELL)},${Math.floor(b.y / DETAIL_CELL)}`);
  // The shells pieced by the cell's halves (whole detail cells: 3 + 2 a side, `partFiling.ts` shellHalf): each piece culled by its own box (`cellArrays` groups), and a cell
  // at the district's scale drawing four pieces rather than twenty-five. The parts keep the detail cell's finer levels (`partFiling.ts`).
  const shellOf = buildings.map((b) => shellPieceOf(b.x, b.y));
  const batch = cellArrays(chunks, { ...COARSE, ghost: false, dim: false, ...(grid ? { grid } : {}) }, job.boxes, shellOf);
  const byDetail = new Map<string, BuildingChunk[]>();
  buildings.forEach((_b, i) => {
    const key = detailOf[i]!;
    const list = byDetail.get(key);
    if (list) list.push(chunks[i]!); else byDetail.set(key, [chunks[i]!]);
  });
  const details = [...byDetail].map(([key, list]) => [key, cellArrays(list, { ...DETAIL, ghost: false, dim: false }, job.boxes)] as const);
  // DO NOT hand the page the instances to band: the parts filed here, by band and detail cell, their buffers ready (`partFiling.ts`).
  if (!job.boxes.bandings) throw new Error('[buildings] a cell job with no part bandings (`kitBoxes`)');
  const parts = details.length ? fileParts(job.cell, details, job.boxes.bandings) : null;
  return { kind: 'done', job: job.id, result: { batch, parts, summaries, floors: party.floorsKnown() } };
}

/** Two cells' keys ("i,j") in a level's order: column by column, row by row in a column (`massLevels.ts` listOf). */
function cellOrder(a: string, b: string): number {
  const ca = a.indexOf(','), cb = b.indexOf(',');
  return Number(a.slice(0, ca)) - Number(b.slice(0, cb)) || Number(a.slice(ca + 1)) - Number(b.slice(cb + 1));
}

/** The roads and the ground to hand the job again: those it was handed and every point it read past them, a metre round. */
function wider(job: CellJob, x0: number, y0: number, x1: number, y1: number): WorkReply {
  const rect: [number, number, number, number] = [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  for (const was of [job.paving?.rect, job.around]) {
    if (was) { rect[0] = Math.min(rect[0], was[0]); rect[1] = Math.min(rect[1], was[1]); rect[2] = Math.max(rect[2], was[2]); rect[3] = Math.max(rect[3], was[3]); }
  }
  return { kind: 'wider', job: job.id, rect };
}
