import type { Budget } from '@core/perfBudget';
import type { QualityLevel } from '@render/quality';

/** The specs' counts: exact, the same on every run (`tests/perf`). */
export const COUNT_BUDGETS = {
  /** Rings measured per corner of the ground graded to the default town's 761 buildings (7.59): the nearest-ring pruning (`pads.ts`). */
  padRingsPerCorner: { max: 9.5, level: 'error', why: 'the platforms pruning (7.59; without it ~tens)' },
  /** Kerb edges walked per `kerbward` ask over the default town (208.6): its pruning (`poleLines.ts`). */
  kerbEdgesPerAsk: { max: 260, level: 'error', why: 'the kerb pruning (208.6; without it the whole city)' },
  /** Cells of the default town's crossing surface (21 297). */
  townWalkableCells: { max: 30_000, level: 'error', why: 'crossing grids of the default town (21 297)' },
  /** Triangles of the road surfaces of `tests/fixtures/grid-and-bends.json` (6,896): neither bloated nor stripped of detail. */
  fixtureRoadTriangles: { min: 6_200, max: 7_700, level: 'error', why: 'road surfaces of the fixed scene (6 896, 2026-10-25: one quad a band, the lines drawn by the shader of the carriageway, no verge; 42 794 at db9da0c7, 133 500 before the strips)' },
  /** Meshes (draw calls) of the same surfaces (46). */
  fixtureRoadMeshes: { max: 55, level: 'error', why: 'surface meshes of the fixed scene (46, 2026-10-25: no verge and no marking meshes; 64 at db9da0c7)' },
} as const satisfies Readonly<Record<string, Budget>>;

/** Whether a value keeps its budget. */
export function withinBudget(value: number, budget: Budget): boolean {
  return value <= budget.max && (budget.min === undefined || value >= budget.min);
}

/** The views the tiers are counted at (`tests/support/sceneHarness.ts`: the photographs' map, district and street). */
export type TierView = 'map' | 'district' | 'street';

/** What three issued for a view standing still (`settled`) and at most in one frame on the way there (`peak`: the frame that drew the sun's cascades whole over the colour pass). */
export interface TierViewCounts {
  readonly draws: number;
  readonly triangles: number;
  readonly peakDraws: number;
  readonly peakTriangles: number;
}

/** The share over today's counts a tier's budget allows: past it, something draws more than it did and the commit says why. */
export const TIER_MARGIN = 0.1;
/** The share over today's retained heap the city may hold on a tier (the heap moves by ~0.2 % between runs; the counts never). */
export const TIER_HEAP_MARGIN = 0.15;

/**
 * TODAY'S COUNTS OF THE SMALL CITY OF SEED 7 ON EACH TIER (`tests/perf/budgets.spec.ts`), exact on every run: the city opened on `low`
 * (the weak machine's tier) and raised a tier at a time on the same scene (`setQuality`, as `graphicsWiring.ts` applies a tier), each
 * view settled. Budget: each count times 1 + `TIER_MARGIN`. A change made on purpose updates them in the same commit, and says why.
 * `heapMB`: the JS heap the opened city keeps on that tier after a full collection, over the heap before it was opened.
 * 2026-10-25, measured against db9da0c7 (whose counts were already past these on low's street, 353 draws). Triangles: fewer on every district
 * and street view but low's street (district on low 4,367,022 -> 3,870,100, on medium 4,821,438 -> 3,946,816) and on ultra's map; more on
 * the maps of low (1,228,898 -> 1,427,515: more of the buildings' parts drawn, 40,570 -> 52,340 concrete ones), medium and high (1,630,006 ->
 * 1,660,247) and on low's street (3,680,203 -> 3,770,192). Draws: low's street 353 -> 342; the maps' up (low 183 -> 222): the null GPU has no
 * `WEBGL_multi_draw`, so each piece of a batched mesh is a call of its own (`renderBufferDirect` called 163 times on that view, 164 here), and
 * the far roads are their pieces now, filed by owner block (`networkFarRoads.ts`: 8 drawn -> 32), the shells' far batches 29 -> 33 and 28 -> 32.
 * The heap on low 133.6 -> 141.1 MB.
 */
export const TIER_COUNTS: Readonly<Record<QualityLevel, { readonly views: Readonly<Record<TierView, TierViewCounts>>; readonly heapMB: number }>> = {
  low: {
    views: {
      map: { draws: 222, triangles: 1_427_515, peakDraws: 222, peakTriangles: 1_514_298 },
      district: { draws: 225, triangles: 3_870_100, peakDraws: 231, peakTriangles: 3_870_100 },
      street: { draws: 342, triangles: 3_770_192, peakDraws: 401, peakTriangles: 4_910_896 },
    },
    heapMB: 141.1,
  },
  medium: {
    views: {
      map: { draws: 250, triangles: 1_660_247, peakDraws: 432, peakTriangles: 2_989_079 },
      district: { draws: 246, triangles: 3_946_816, peakDraws: 421, peakTriangles: 6_708_066 },
      street: { draws: 355, triangles: 3_841_010, peakDraws: 393, peakTriangles: 4_089_892 },
    },
    heapMB: 145.2,
  },
  high: {
    views: {
      map: { draws: 258, triangles: 1_660_255, peakDraws: 502, peakTriangles: 3_541_638 },
      district: { draws: 254, triangles: 3_946_824, peakDraws: 469, peakTriangles: 7_107_978 },
      street: { draws: 363, triangles: 3_841_018, peakDraws: 442, peakTriangles: 5_265_936 },
    },
    heapMB: 146.2,
  },
  ultra: {
    views: {
      map: { draws: 270, triangles: 1_732_163, peakDraws: 537, peakTriangles: 4_324_334 },
      district: { draws: 254, triangles: 3_946_824, peakDraws: 469, peakTriangles: 7_107_978 },
      street: { draws: 363, triangles: 3_841_018, peakDraws: 442, peakTriangles: 5_265_936 },
    },
    heapMB: 147.2,
  },
};
