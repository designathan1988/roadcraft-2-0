import { canQueueJobs, type JobTicket, jobPort, submitJob, warmJobWorkers } from '../../jobs/jobPool';
import type { GroundAt } from '@world/buildings/foundation';
import type { Finish } from '@world/buildings/materials';
import type { PavingSource } from '@world/paving';
import { RecordTable, type RecordRef, TableWriter, tableBytes } from '@world/buildings/recordTable';
import { m } from '@world/units';
import type { SharedGroundAt } from '../sharedGround';
import { BATCH_CELL } from './layerCells';
import type { KitBoxes } from './cellArrays';
import { type CellEntry, type CellJob, type CellResult, type CellSlice, type CellSpan, type JobKind, type KeptSlice, type WorkReply, runCellJob } from './cellWork';
import { levelCells, squareKeyOf } from './levelKeys';
import { groundAround } from '../sharedGround';
import { Digest } from '../../core/digest';
import { IdSlots, grown } from '../../core/idSlots';
import { forgetDerivedKeys, forgetOtherDerived, keepDerivedNow, readDerivedKeys, readDerivedSome } from '../derivedCache';
import { DerivedWriterLane } from '../derivedWriterLane';

declare const __CELL_WORK_HASH__: string | undefined;
/** The cells' jobs kept from one session to the next, by this build's fingerprint of their code (`cook-plugin.ts` DERIVED). */
const CELL_HASH = typeof __CELL_WORK_HASH__ !== 'undefined' && __CELL_WORK_HASH__ ? __CELL_WORK_HASH__ : null;
const CELL_PREFIX = CELL_HASH ? `cellWork:${CELL_HASH}:` : null;
/** The kinds kept: the masses and the far level, what the opening waits for (`layer.ts` coarsePending, viewPending). DO NOT make them again at every launch: the same buildings on the same ground made the same masses, 117 jobs and ~3 s of every worker before a reopened city showed (2026-10-21). The detail ('cell') is the largest and lands after the curtain. */
const KEPT_KINDS: ReadonlySet<JobKind> = new Set(['facade', 'mass', 'massTile', 'massPlate', 'massBase']);
let forgotOthers = false;
/** The keys kept, read once at the start (a keys-only read) and added to as results are kept: a job not in it is asked at once. DO NOT read the store before every job: a read waits for every write on the store before it (IndexedDB transactions), the road tiles' and the cells' own, and a city not kept yet opened 4 s later (2026-10-21). */
let keptKeys: Promise<Set<string>> | null = null;
// Whole keys: `readDerivedKeys` gives them without their prefix.
const keptCellKeys = (): Promise<Set<string>> => (keptKeys ??= CELL_PREFIX
  ? readDerivedKeys(CELL_PREFIX).then((keys) => new Set([...keys].map((k) => CELL_PREFIX + k)), () => new Set<string>())
  : Promise.resolve(new Set<string>()));

/** WHERE A CELL'S SLICES OF ITS SQUARE'S LEVELS ARE KEPT (`cellWork.ts` CellSlice): read when a tile's, a plate's or a base's job is asked, its
 *  cells kept handed to it as they are (their buildings not sent, not walked), written when a job hands back the slices it made. */
export interface SliceStore {
  /** The slices kept of these keys, by key. */
  read(keys: readonly string[]): Promise<Map<string, CellSlice>>;
  /** A slice kept under `key`, cloned now (its arrays may be let go after); `was`, the key of the cell's slice it replaces, forgotten. */
  keep(key: string, slice: CellSlice, was: string | null): void;
}

/** Where the kept entries of a prefix are read: the store's entries of these keys, by key. */
type KeptRead = <T>(prefix: string, keys: readonly string[]) => Promise<Map<string, T>>;

/** Bytes of writes the cells' reader lane may hold: it only reads (`DerivedWriterLane.read`), the cells' results kept on the page (`keepDerivedNow`). */
const KEPT_READER_BYTES = 2 ** 20;

/**
 * THE CELLS' KEPT RESULTS AND SLICES READ OFF THE PAGE (the derived cache's writer, `derivedWriter.worker.ts`), their arrays handed over; read on
 * the page where no job queue runs (tests). DO NOT read them on the page: IndexedDB rebuilds every value where it is read, and a reopened 10 km
 * city's masses, far levels and slices rebuilt there took 770 ms in every few seconds of the open city (`request.onsuccess`, one F7 profile, 2026-10-26).
 */
function keptReader(workers: boolean): KeptRead {
  if (!workers || !canQueueJobs() || typeof Worker === 'undefined') return readDerivedSome;
  const lane = new DerivedWriterLane(jobPort('derivedWriter'), KEPT_READER_BYTES);
  return (prefix, keys) => lane.read(prefix, keys);
}

/** The slices in the derived cache (IndexedDB, `core/derivedCache.ts`) under this build's fingerprint of the cells' code, beside the jobs' results
 *  kept (`CELL_PREFIX`): never in the page's memory between jobs. None without a fingerprint: every building of a level walked, as before slices. */
function derivedSlices(prefix: string | null, readKept: KeptRead = readDerivedSome): SliceStore | null {
  if (prefix === null) return null;
  return {
    read: async (keys) => {
      // Only the keys kept (`keptCellKeys`, read once at the start): a level none of whose cells is kept asks the store nothing.
      const kept = await keptCellKeys();
      const some = keys.filter((key) => kept.has(prefix + key));
      return some.length ? readKept<CellSlice>(prefix, some) : new Map<string, CellSlice>();
    },
    keep: (key, slice, was) => {
      if (keepDerivedNow(prefix + key, slice)) void keptCellKeys().then((keys) => keys.add(prefix + key));
      if (was === null || was === key) return;
      forgetDerivedKeys(prefix, [was]);
      void keptCellKeys().then((keys) => keys.delete(prefix + was));
    },
  };
}

/** The kinds joined from their cells' slices (`CellJob.spans`). */
const SLICED_KINDS: ReadonlySet<JobKind> = Object.freeze(new Set<JobKind>(['massTile', 'massPlate', 'massBase']));

/** THE PAGE'S SIDE OF THE CELLS PUT TOGETHER IN WORKERS (`cellWork.ts`, `cell.worker.ts`), through the job system's one queue (`jobPool.ts` `submitJob`) */

/** What a job reads on the page: the ground as drawn and as it was, and the paving (with `pack`: read by the worker itself). */
export interface CellEnv {
  readonly groundAt: GroundAt;
  readonly naturalAt: GroundAt;
  readonly pavedAt?: PavingSource;
}

/** How far past its cell a job's buildings read the paving off the roads handed to its worker (`PavingData`) */
const PAVING_REACH = m(64);
/** Which jobs go first, a band each, nearest the eye first within a band: the detail, its far level, the masses, the summaries; the base (the top level, `massBase.ts`) in the far levels' band (`FAR_TIER`), before them all. */
const TIER: Readonly<Record<JobKind, number>> = { cell: 0, facade: 1, mass: 2, massTile: 2.5, massPlate: 2.75, summary: 3, massBase: -0.5 };
/** A band: farther than any cell of any map is from the eye (the far levels' jobs take a band of their own, `farLevels.ts`). */
export const TIER_SPAN = m(10_000_000);
/** The bands the detail is put back by while the town is unseen (`coarseFirst`): past the masses (2-2.75). */
const DETAIL_LATER = 4;
/** THE FAR LEVELS' BAND (`farLevels.ts`, `farRoads.ts`): before every other kind - a far node the view wants and has not is a hole on the screen (nothing under it drawn), and a hole comes before any refinement of what is drawn (Cesium loads the coarse levels first). After the far levels in the band, the map view a moment after the opening showed the outer districts empty for seconds behind the region's detail (2026-10-16). */
export const FAR_TIER = -0.5;
/** WHAT THE PLAYER JUST EDITED (a building cut open, a tile's near roads baked from the page's records): before anything - it is what the player looks at. Behind the cells a road drawn was not on the screen 4 s after it was built (`conferencia` 40-road-4s, 2026-10-17). */
const EDIT_TIER = -1;
/** A cell job's place in the queue (lower first): a building cut open before anything, else its kind's band (`TIER`, the detail put back past the coarse levels while the town is unseen, `coarseFirst`), nearest the eye first within it. */
export function cellPriority(kind: JobKind, away: number, cutOpen: boolean, coarseFirst: boolean): number {
  if (cutOpen) return EDIT_TIER * TIER_SPAN;
  const later = coarseFirst && (kind === 'cell' || kind === 'facade') ? DETAIL_LATER : 0;
  return (TIER[kind] + later) * TIER_SPAN + away;
}

/** The worker a job goes to, as the job system keeps it (`jobPool.ts` JobSpec.affinity): the buildings' programs a worker keeps (`cellWork.ts`)
 *  read there by the next job of the same buildings. The masses (a cell's, its tile's, its plate's, its base's) and the summaries by the base's
 *  square they stand in: every level of a building's masses one walk on one worker. A cell's detail and facade level by the cell: the pair walked
 *  together (`CellJob.pair`), the other level read there as the eye steps between them. */
export function affinityOf(kind: JobKind, cell: string): string {
  return kind === 'cell' || kind === 'facade' ? `cell:${cell}` : `square:${squareKeyOf(cell)}`;
}

/** Times a job is asked again over wider roads (`wider`) before the page puts it together. */
const MOST_WIDER = 2;

/** A job's square in `BATCH_CELL`s from its key: a cell ("x,y") or a tile or plate of masses ("t:i,j", "p:i,j", `massLevels.ts`); null when it is none. */
function squareOf(cell: string): { readonly i0: number; readonly j0: number; readonly n: number } | null {
  if (cell[1] === ':') { const { i0, j0, n } = levelCells(cell); return { i0, j0, n }; }
  const [cx, cy] = cell.split(',').map(Number) as [number, number];
  return Number.isFinite(cx) && Number.isFinite(cy) ? { i0: cx, j0: cy, n: 1 } : null;
}

/** The rectangle a job's worker reads the paving in: its square and `PAVING_REACH` round it. */
function pavingRect(cell: string): [number, number, number, number] | null {
  const at = squareOf(cell);
  if (!at) return null;
  const { i0, j0, n } = at;
  return [i0 * BATCH_CELL - PAVING_REACH, j0 * BATCH_CELL - PAVING_REACH, (i0 + n) * BATCH_CELL + PAVING_REACH, (j0 + n) * BATCH_CELL + PAVING_REACH];
}

/** A job asked: what it is written from when a worker takes it (`write`), and where it stands. */
interface Asked {
  readonly id: number;
  readonly kind: JobKind;
  readonly cell: string;
  /** Its buildings; a level joined from its cells' slices, those of its cells not kept only (`send`). */
  entries: readonly CellEntry[];
  /** Where each record is read, taken when the job is sent (its tile's shared table: posted as a handle, never copied). */
  writers: readonly (() => RecordRef)[];
  /** A tile's, a plate's or a base's cells, the entries of each in order (`MassLevels`), till their slices are looked up (`send`); then null. */
  cells: readonly CellSpan[] | null;
  /** The cells whose slice is not kept (made by the job) and the slices kept of the others (`CellJob.spans`, `slices`), with each cell's key. */
  spans: readonly CellSpan[] | null;
  slices: readonly KeptSlice[] | null;
  sliceKeys: ReadonlyMap<string, string> | null;
  readonly env: CellEnv;
  readonly done: (result: CellResult) => void;
  readonly key: string | null;
  /** Its band now (`cellPriority`): asked again in another when the curtain lifts (`coarseFirst`). */
  priority: number;
  /** Cut open or edited by the player: always first. */
  readonly first: boolean;
  /** Taken by a worker (`write` called): it runs through as asked. */
  sent: boolean;
  readonly place: readonly [number, number] | null;
  /** Where its result is kept between sessions (`CELL_PREFIX`); null: not kept. */
  readonly stored: string | null;
  /** The roads handed with it, and the ground's plates to a job process (`groundAround`): the cell and its reach, wider once the worker said so. */
  rect: [number, number, number, number] | null;
  widened: number;
  ticket: JobTicket | null;
  /** A cell's detail or facade level asked with the other (`CellJob.pair`). */
  readonly pair: boolean;
}

/** A building's ground floor as a job measured it, and what it was measured on: its record, its ground (`CellEntry`) and whether the paving was read. */
interface Floor { readonly sig: number; readonly digest: number; readonly paved: boolean; readonly floor: number | null }

/** `FloorColumns` flags: the paving was read; the job found no floor (null). */
const FLOOR_PAVED = 1, FLOOR_NONE = 2;

/** THE FLOORS MEASURED, IN COLUMNS BY BUILDING ID (`core/idSlots.ts`): a plate's job measures every building of 2 km round, and a `Map` entry and an object each held ~100 B of JS heap a building of the city. A building cut open (its key `id|...`, a few at a time) is kept in a `Map` of its own. */
class FloorColumns {
  private readonly slots = new IdSlots(1024);
  private sig = new Float64Array(16);
  private digest = new Float64Array(16);
  private floor = new Float64Array(16);
  private flags = new Uint8Array(16);
  private readonly cut = new Map<string, Floor>();

  constructor() {
    this.slots.onGrow = (n) => {
      this.sig = grown(this.sig, n); this.digest = grown(this.digest, n); this.floor = grown(this.floor, n); this.flags = grown(this.flags, n);
    };
  }

  /** A plain building's id from its key; NaN for a key of a building cut open. */
  private static idOf(key: string): number {
    const id = Number(key);
    return key.length > 0 && Number.isFinite(id) && String(id) === key ? id : NaN;
  }

  get(key: string): Floor | undefined {
    const id = FloorColumns.idOf(key);
    if (Number.isNaN(id)) return this.cut.get(key);
    const slot = this.slots.get(id);
    if (slot < 0) return undefined;
    const flags = this.flags[slot]!;
    return { sig: this.sig[slot]!, digest: this.digest[slot]!, paved: (flags & FLOOR_PAVED) !== 0, floor: flags & FLOOR_NONE ? null : this.floor[slot]! };
  }

  set(key: string, value: Floor): void {
    const id = FloorColumns.idOf(key);
    if (Number.isNaN(id)) { this.cut.set(key, value); return; }
    const slot = this.slots.take(id);
    this.sig[slot] = value.sig; this.digest[slot] = value.digest; this.floor[slot] = value.floor ?? 0;
    this.flags[slot] = (value.paved ? FLOOR_PAVED : 0) | (value.floor === null ? FLOOR_NONE : 0);
  }

  /** Every floor whose key `keep` refuses let go. */
  retain(keep: (key: string) => boolean): void {
    const gone: number[] = [];
    this.slots.forEach((id) => { if (!keep(String(id))) gone.push(id); });
    for (const id of gone) this.slots.delete(id);
    for (const key of [...this.cut.keys()]) if (!keep(key)) this.cut.delete(key);
  }
}

export class CellPool {
  private readonly asked = new Map<number, Asked>();
  /** DO NOT measure a building's floor in each job of it (its cell's masses, its tile's, its plate's, its detail, its far level): measured once, handed with the next jobs while its record and ground are the same (`CellEntry.floor`). */
  private readonly floors = new FloorColumns();
  /** Each key's job asked: a newer one replaces it (the queue drops it too). */
  private readonly byKey = new Map<string, Asked>();
  private nextId = 1;
  private warned = false;
  /** DO NOT give the detail the queue first while the town is behind its curtain: the opening shows the masses and the far levels, the detail lands after (`renderer.ts` reveal), and the cells' detail took the queue's two workers while the coarse levels the curtain waits for stood behind it (2026-10-16, 90 s at the curtain's limit, the workers' profile). Set by the layer as it is hidden or shown. */
  get coarseFirst(): boolean {
    return this.coarse;
  }
  /** DO NOT leave the detail asked behind the curtain in its band once the town shows: the queue ranks a job by the band it was asked in, and the cell at the camera after a reload waited behind the whole re-bake (conferencia 97, picture 51: neither its detail nor its facade level 4 s on). The jobs no worker took are asked again in their band now. */
  set coarseFirst(on: boolean) {
    if (on === this.coarse) return;
    this.coarse = on;
    for (const asked of this.asked.values()) {
      if ((asked.kind !== 'cell' && asked.kind !== 'facade') || asked.sent || !asked.ticket?.pending) continue;
      const priority = cellPriority(asked.kind, 0, asked.first, on);
      if (priority === asked.priority) continue;
      asked.ticket.cancel();
      asked.priority = priority;
      this.submit(asked);
    }
  }
  private coarse = false;

  /** Each cell's slice kept now, by level and cell: forgotten in the store once another replaces it (`SliceStore.keep`). */
  private readonly cellSlices = new Map<string, string>();

  /** `workers`: false does every job on the page (tests). `tone`: each finish's colour from afar, for the masses (`kit.ts`). */
  /** `text`: where an entry's record is read (`recordTable.ts`), taken when the job is sent. `slices`: where the cells' slices of their levels are kept (`SliceStore`). */
  constructor(private readonly boxes: () => KitBoxes, private readonly text: (entry: CellEntry) => () => RecordRef, private readonly workers = true,
    private readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>, slices?: SliceStore | null) {
    this.readKept = keptReader(workers);
    this.slices = slices === undefined ? derivedSlices(CELL_PREFIX, this.readKept) : slices;
    // The kept keys read now, at the start, before the town's writes come (`keptCellKeys`).
    if (workers && canQueueJobs()) void keptCellKeys();
  }

  /** Where the cells' kept results and slices are read (`keptReader`): off the page where jobs run. */
  private readonly readKept: KeptRead;
  /** Where the cells' slices of their levels are kept (`SliceStore`). */
  private readonly slices: SliceStore | null;

  /** Jobs asked and not answered. */
  get running(): number {
    return this.asked.size;
  }

  /** A cell's job: its batches ('cell'), its far level ('facade'), its masses ('mass') or its buildings' summaries; `key`, what a newer job replaces */
  /** `hole`: nothing stands where it draws (a plate of the map with no masses yet): in the far levels' band (`FAR_TIER`), before the view's detail - a hole on the screen comes before any refinement of what is drawn. */
  /** `pair`: a cell's detail or facade level walked with the other, both kept by the worker (`CellJob.pair`). `cells`: a tile's, a plate's or a
   *  base's cells, the entries of each in order (`MassLevels`): joined from their slices kept, those not kept made by the job (`SliceStore`). */
  run(kind: JobKind, cell: string, entries: readonly CellEntry[], env: CellEnv, done: (result: CellResult) => void, key: string | null = null, edited = false, hole = false, pair = false,
    cells: readonly CellSpan[] | null = null): number {
    if (key !== null) { const older = this.byKey.get(key); if (older) this.cancel(older.id); }
    const at = squareOf(cell);
    // Its band; its distance to the view is the queue's, as the view moves (`JobSpec.at`). A building the player cut open goes first: what the click asked for (`layer.ts` `entryFor`).
    const place = at ? [(at.i0 + at.n / 2) * BATCH_CELL, (at.j0 + at.n / 2) * BATCH_CELL] as const : null;
    // A cell the player's edit changed (`edited`, `layer.ts` editedCells: a building demolished in a tile next to a road's) goes with the cut-open one: it draws what was just done.
    const first = edited || entries.some((e) => e.key.includes('|'));
    const priority = hole && !first ? FAR_TIER * TIER_SPAN : cellPriority(kind, 0, first, this.coarse);
    const offPage = this.offPage(env);
    const asked: Asked = {
      id: this.nextId++, kind, cell, entries, writers: entries.map((e) => this.text(e)), env, done, key, priority, first, sent: false, place,
      stored: offPage && !first ? this.storedKey(kind, cell, entries, env) : null, rect: pavingRect(cell), widened: 0, ticket: null, pair,
      cells: offPage && this.slices !== null && SLICED_KINDS.has(kind) ? cells : null, spans: null, slices: null, sliceKeys: null,
    };
    if (!offPage) { this.onPage(asked); return asked.id; }
    this.asked.set(asked.id, asked);
    if (key !== null) this.byKey.set(key, asked);
    if (asked.stored === null) { this.send(asked); return asked.id; }
    // Kept by an earlier session: taken as its job would answer it, the job never asked.
    const stored = asked.stored;
    void keptCellKeys().then((keys) => {
      if (this.asked.get(asked.id) !== asked) return undefined;
      if (!keys.has(stored)) { this.send(asked); return undefined; }
      return this.readKept<CellResult>(CELL_PREFIX!, [stored.slice(CELL_PREFIX!.length)]).then((got) => got.values().next().value, () => undefined).then((kept) => {
        if (this.asked.get(asked.id) !== asked) return;
        if (kept && typeof kept === 'object' && 'summaries' in kept) { this.forget(asked); this.learn(asked, kept); asked.done(kept); return; }
        this.send(asked);
      });
    }, () => this.send(asked));
    return asked.id;
  }

  /** A job into the queue; a tile's, a plate's or a base's after its cells' slices are looked up (`SliceStore`): those kept handed with it, their
   *  buildings not sent; the others' buildings sent, their slices made by the job (`CellJob.spans`). Its priority is the one `run` gave it. */
  private send(asked: Asked): void {
    const cells = asked.cells, store = this.slices;
    if (!cells || !store) { this.submit(asked); return; }
    asked.cells = null;
    const keys = new Map<string, string>();
    let from = 0;
    for (const { cell, count } of cells) {
      keys.set(cell, this.sliceKey(asked.kind, cell, asked.entries.slice(from, from + count), asked.env));
      from += count;
    }
    void store.read([...keys.values()]).catch((error: unknown) => {
      // Every cell of the level made by its job, as with no slice kept.
      console.error("[buildings] the cells' slices could not be read; the level made of all its buildings", error);
      return new Map<string, CellSlice>();
    }).then((kept) => {
      if (this.asked.get(asked.id) !== asked) return;
      const spans: CellSpan[] = [], slices: KeptSlice[] = [], entries: CellEntry[] = [], writers: (() => RecordRef)[] = [];
      let at = 0;
      for (const { cell, count } of cells) {
        const key = keys.get(cell)!;
        const slice = kept.get(key);
        if (slice) {
          slices.push({ cell, slice });
          this.cellSlices.set(`${asked.kind}|${cell}`, key);
        } else {
          spans.push({ cell, count });
          for (let k = at; k < at + count; k++) { entries.push(asked.entries[k]!); writers.push(asked.writers[k]!); }
        }
        at += count;
      }
      asked.entries = entries;
      asked.writers = writers;
      asked.spans = spans;
      asked.slices = slices;
      asked.sliceKeys = keys;
      this.submit(asked);
    });
  }

  /** Where a cell's slice of a level is kept: the level's kind, the cell and all its slice is made of - its buildings' records, the ground under
   *  them and the floors they are handed (`floorKnown`: a floor measured since is another slice), whether paving is read, the kit's boxes and tones. */
  private sliceKey(kind: JobKind, cell: string, entries: readonly CellEntry[], env: CellEnv): string {
    const paved = env.pavedAt !== undefined;
    const d = new Digest().add(this.kitDigest()).add(paved ? 1 : 0).add(env.naturalAt === env.groundAt ? 1 : 0);
    for (const e of entries) {
      const floor = this.floorKnown(e, paved);
      d.addText(e.key).add(e.sig).add(e.digest).add(floor === undefined ? 0 : floor === null ? 1 : 2).add(floor ?? 0);
    }
    return `slice|${kind}|${cell}|${d.value()}`;
  }

  /** The job system's workers made now, ahead of the first job. */
  warm(): void {
    if (this.workers && canQueueJobs()) warmJobWorkers();
  }

  /** A job no longer wanted: never sent if waiting, its answer dropped if begun (a worker runs a job through, one message). */
  cancel(id: number): void {
    const asked = this.asked.get(id);
    if (!asked) return;
    this.forget(asked);
    asked.ticket?.cancel();
  }

  /** A job a newer one for its cell replaces (`cancel`). */
  supersede(id: number): void {
    this.cancel(id);
  }

  /** Whether a job is still waiting or being worked on (one done on the page never is). */
  isRunning(id: number): boolean {
    return this.asked.has(id);
  }

  dispose(): void {
    for (const id of [...this.asked.keys()]) this.cancel(id);
  }

  /** DO NOT hand a worker a job it would have to ask the page about: only with the ground shared and the paving packable (`sharedGround.ts`, `PavingSource.pack`) */
  private offPage(env: CellEnv): boolean {
    if (!this.workers || !canQueueJobs()) return false;
    if (!(env.groundAt as SharedGroundAt).share?.current) return false;
    return env.pavedAt === undefined || env.pavedAt.pack !== undefined;
  }

  private submit(asked: Asked): void {
    asked.sent = false;
    asked.ticket = submitJob({
      service: 'cells',
      key: asked.key === null ? null : `cells:${asked.key}`,
      priority: asked.priority,
      ...(asked.place ? { at: asked.place } : {}),
      // Fit for a job process: its ground cut to the plates around it there (`write`).
      crosses: true,
      affinity: affinityOf(asked.kind, asked.cell),
      write: (to) => { asked.sent = true; return this.write(asked, to.sharesMemory); },
      done: (answer) => this.answer(asked, answer as WorkReply),
      failed: (message) => this.failed(asked, message),
    });
  }

  /** The job as its worker reads it: the records' shared tables and rows, the plates' shared buffers, the roads near the cell (MDN, transfer). */
  /** `sharesMemory`: false for a worker in another process (`jobs/processWorker.ts`), every shared buffer copied there: the plates around the cell alone (`groundAround`). */
  private write(asked: Asked, sharesMemory: boolean): { data: CellJob; transfer: ArrayBuffer[] } {
    const whole = (asked.env.groundAt as SharedGroundAt).share?.current;
    if (!whole) throw new Error('[buildings] the ground is not shared any more');
    const around = !sharesMemory && asked.rect ? asked.rect : null;
    const ground = around ? groundAround(whole, around) : whole;
    const packed = asked.env.pavedAt && asked.rect ? asked.env.pavedAt.pack!(asked.rect) : null;
    if (asked.env.pavedAt && asked.rect && !packed) throw new Error('[buildings] the paving cannot be handed to a worker');
    const base = this.base(asked);
    // A worker in another process gets its buildings' rows in a table of their own (`ownRows`). DO NOT name the map's table there: a 10 km
    // city's table of 249,122 buildings went whole to each of the 18 job threads, its first job each (`ProcessWorker` kept), the view's
    // buildings waiting behind the copies (2026-10-26).
    const job: CellJob = {
      ...base, ...(sharesMemory ? {} : { entries: this.ownRows(base.entries) }), ground, ...(around ? { around } : {}),
      ...(asked.env.naturalAt === asked.env.groundAt ? { naturalIsGround: true } : {}),
      ...(packed ? { paving: packed.data } : {}),
    };
    return { data: job, transfer: packed?.transfer ?? [] };
  }

  /** The record tables the jobs' rows are copied from (`ownRows`), read once each. */
  private readonly sources = new WeakMap<ArrayBufferLike, RecordTable>();

  /** A job's entries with their records' rows copied into a table of their own (`TableWriter.copyRows`: no record decoded), in a plain buffer: what a worker in another process reads, the job's buildings alone. */
  private ownRows(entries: CellJob['entries']): CellJob['entries'] {
    const writer = new TableWriter(false);
    for (const e of entries) {
      let table = this.sources.get(e.record.buffer);
      if (!table) this.sources.set(e.record.buffer, table = new RecordTable(e.record.buffer));
      writer.copyRows(table, [e.record.row]);
    }
    const buffer = tableBytes(writer.finish().buffer);
    // The field written over a row (a building's wear, `RecordRef.field`) goes with it: the row copied is the table's.
    return entries.map((e, row) => ({ ...e, record: e.record.field ? { buffer, row, field: e.record.field } : { buffer, row } }));
  }

  /** What every job carries, on the page or off it. */
  private base(asked: Asked): CellJob {
    return {
      id: asked.id, kind: asked.kind, cell: asked.cell, paved: asked.env.pavedAt !== undefined, boxes: this.boxes(),
      entries: asked.entries.map((e, i) => {
        const floor = this.floorKnown(e, asked.env.pavedAt !== undefined);
        return { ...e, ...(floor !== undefined ? { floor } : {}), record: asked.writers[i]!() };
      }),
      ...(this.tone ? { tone: this.tone } : {}),
      ...(asked.pair && (asked.kind === 'cell' || asked.kind === 'facade') ? { pair: true } : {}),
      ...(asked.spans && asked.slices ? { spans: asked.spans, slices: asked.slices } : {}),
    };
  }

  /** A worker's answer: the result handed on, the job asked again over wider roads, or put together here. */
  private answer(asked: Asked, reply: WorkReply): void {
    if (this.asked.get(asked.id) !== asked) return;
    if (reply.kind === 'wider' && asked.widened < MOST_WIDER) {
      asked.widened++;
      asked.rect = [reply.rect[0], reply.rect[1], reply.rect[2], reply.rect[3]];
      this.submit(asked);
      return;
    }
    this.forget(asked);
    if (reply.kind === 'done') {
      // Kept before it is handed on: the store clones it now, its arrays are the layer's after (`keepDerivedNow`).
      const stored = asked.stored;
      if (stored !== null && keepDerivedNow(stored, reply.result)) void keptCellKeys().then((keys) => keys.add(stored));
      // The slices it made of its cells, kept; each cell's slice before them forgotten.
      for (const { cell, slice } of reply.result.slices ?? []) {
        const key = asked.sliceKeys?.get(cell);
        if (key === undefined || !this.slices) continue;
        const was = `${asked.kind}|${cell}`;
        this.slices.keep(key, slice, this.cellSlices.get(was) ?? null);
        this.cellSlices.set(was, key);
      }
      this.learn(asked, reply.result);
      asked.done(reply.result);
      return;
    }
    if (reply.kind === 'error') console.warn('[buildings] a cell worker failed on a cell; put together on the page', reply.message);
    this.onPage(asked);
  }

  /** The worker failed, or none runs: put together here. */
  private failed(asked: Asked, message: string): void {
    if (this.asked.get(asked.id) !== asked) return;
    if (!this.warned) { this.warned = true; console.warn('[buildings] a cell job could not run in a worker; put together on the page', message); }
    this.forget(asked);
    this.onPage(asked);
  }

  private forget(asked: Asked): void {
    this.asked.delete(asked.id);
    if (asked.key !== null && this.byKey.get(asked.key) === asked) this.byKey.delete(asked.key);
  }

  /** The job done here, every height read off the page's own ground. */
  private onPage(asked: Asked): void {
    const { groundAt, naturalAt, pavedAt } = asked.env;
    const reply = runCellJob(this.base(asked), { groundAt, naturalAt, ...(pavedAt ? { pavedAt } : {}) });
    if (reply.kind !== 'done') throw new Error(`[buildings] a cell put together on the page did not finish (${asked.cell})`);
    this.learn(asked, reply.result);
    asked.done(reply.result);
  }

  /** A building's floor measured on the same record, ground and paving; undefined when none was, or on other ground (its digest changed: a stamp under it, a road beside it). */
  floorKnown(entry: CellEntry, paved: boolean): number | null | undefined {
    const known = this.floors.get(entry.key);
    return known && known.sig === entry.sig && known.digest === entry.digest && known.paved === paved ? known.floor : undefined;
  }

  /** DO NOT keep the floor of a building gone from the document (a tile let go as the eye walked on): the floors kept follow what is loaded, not the way walked. `keep`: whether an entry's building is still there, by its key (an id, or a building cut open, `id|...`). */
  forgetFloors(keep: (key: string) => boolean): void {
    this.floors.retain(keep);
  }

  /** Where a job's result is kept between sessions: its kind, its cell and all it is made from (each building's record and the ground under it, `CellEntry`; the paving read or not; the kit's boxes and tones). Null for a kind not kept, or with no fingerprint of the code. */
  private storedKey(kind: JobKind, cell: string, entries: readonly CellEntry[], env: CellEnv): string | null {
    if (!CELL_PREFIX || !CELL_HASH || !KEPT_KINDS.has(kind)) return null;
    if (!forgotOthers) { forgotOthers = true; forgetOtherDerived('cellWork', CELL_HASH); }
    const d = new Digest().add(this.kitDigest()).add(env.pavedAt !== undefined ? 1 : 0).add(env.naturalAt === env.groundAt ? 1 : 0);
    for (const e of entries) d.addText(e.key).add(e.sig).add(e.digest);
    return `${CELL_PREFIX}${kind}|${cell}|${d.value()}`;
  }

  /** The kit's boxes and tones as one number: the boxes hashed once a set (`kitBoxes` gives the same `parts` and `furniture` every call), the
   *  bandings (a few numbers a kind) each call. DO NOT key it by the object `boxes()` returns: it is new every call (its bandings follow the
   *  kit's levels), and the whole kit was hashed again for every cell job of a move (`Digest.addPlain` 333 ms self in the player's probe,
   *  612 ms in `npm run diagnose`, 2026-10-22). */
  private kitDigest(): number {
    const boxes = this.boxes();
    if (this.kitSeen?.parts !== boxes.parts || this.kitSeen.furniture !== boxes.furniture) {
      this.kitSeen = { parts: boxes.parts, furniture: boxes.furniture, digest: new Digest().addPlain(boxes.parts).addPlain(boxes.furniture).addPlain(this.tone ?? null).value() };
    }
    return new Digest().add(this.kitSeen.digest).addPlain(boxes.bandings ?? null).value();
  }
  private kitSeen: { readonly parts: KitBoxes['parts']; readonly furniture: KitBoxes['furniture']; readonly digest: number } | null = null;

  /** The floors a job stood its buildings on, kept for their next jobs. */
  private learn(asked: Asked, result: CellResult): void {
    const floors = result.floors;
    if (!floors) return;
    const paved = asked.env.pavedAt !== undefined;
    asked.entries.forEach((e, i) => {
      const floor = floors[i];
      if (floor !== undefined) this.floors.set(e.key, { sig: e.sig, digest: e.digest, paved, floor });
    });
  }
}
