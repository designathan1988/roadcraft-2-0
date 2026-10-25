import { Polyline } from '@core/polyline';
import type { SegmentId } from '@world/ids';
import { type FieldData, PointHeights, fieldOf } from '@world/roadField';
import { type CurbRamp, rampGrid, rampRiseIn } from '@world/rampRise';
import { type FlushData, flushShareOf } from '@world/roads/footwayRise';
import type { Tile, TileRect } from './mesh/tileMesh';
import { type PassDesc, type RoadLook, type SurfaceRead, type SurfaceReads, passSurfaces } from './roadSurfaceReads';
import type { PieceReach } from './roads/pieceGeom';
import { pieceBundle } from './roads/pieceMesh';

/** THE ROADS' SURFACE PIECES MADE WHOLE OFF THE PAGE (`roadTile.worker.ts`): each piece (a road, a junction) meshed from its strips and fans
 *  (`roads/pieceMesh.ts`), handed back finished */

/** Everything a share of a pass's tiles reads besides the ground: the roads near them, as typed arrays and small records. */
export interface SurfaceData {
  /** The solved profiles a query in the tiles can read (`RoadElevation.fieldFor`). */
  readonly field: FieldData;
  /** The looks of those roads and of the pass's chain. */
  readonly looks: readonly (readonly [SegmentId, RoadLook])[];
  /** The roads with a footway laid flush whose filed box meets the tiles (`Network.flushCells`). */
  readonly flush: FlushData;
  /** The dropped kerbs filed in the cells of the tiles, of the pass's structure. */
  readonly ramps: readonly CurbRamp[];
}

/** One piece as a worker is asked for it: its box (what it reads, `SurfaceInputs.rectOf`) and its shapes by surface. */
export interface PartAsk {
  readonly rect: TileRect;
  readonly into: PieceReach;
}

/** What a share of a pass's parts is made from. */
export interface MeshAsk {
  readonly pass: PassDesc;
  readonly tiles: readonly PartAsk[];
  readonly data: SurfaceData;
}

/** A tile's surfaces, by name, in the pass's order, as handed back. */
export type TileMeshes = [string, Tile][];

/** The reads of `SurfaceData`, the ground from `heights` (a point missing pushed onto `missing`, read NaN). */
function readsOf(data: SurfaceData, heights: PointHeights, missing: number[]): SurfaceReads {
  const terrainAt = (x: number, y: number): number => {
    const h = heights.get(x, y);
    if (h !== undefined) return h;
    missing.push(x, y);
    return NaN;
  };
  const field = fieldOf(data.field, terrainAt);
  const lines = new Map<SegmentId, Polyline>();
  {
    let at = 0;
    for (let i = 0; i < data.field.ids.length; i++) {
      lines.set(data.field.ids[i]! as SegmentId, Polyline.fromFlat(data.field.lines.subarray(at, data.field.lineEnds[i]!)));
      at = data.field.lineEnds[i]!;
    }
  }
  const looks = new Map(data.looks);
  const footwayShare = flushShareOf(data.flush);
  const ramps = rampGrid(data.ramps);
  return {
    field,
    terrainAt,
    lineOf: (id) => lines.get(id),
    look: (id) => looks.get(id),
    footwayShare,
    walkingRise: (x, y, structure) => rampRiseIn(ramps, x, y, true, structure),
  };
}

/** One share of a pass's parts, made whole: `need` the ground's heights at the points it reads, `give` them, `run` */
export class TileMesher {
  private readonly heights = new PointHeights();
  private readonly made: (TileMeshes | null)[];
  private ran = false;
  /** The surfaces and the points they found missing; made again after a round that missed some (its field remembered NaN). */
  private specs: SurfaceRead[];
  private missing: number[] = [];
  private reads: SurfaceReads;

  constructor(private readonly ask: MeshAsk) {
    this.reads = readsOf(ask.data, this.heights, this.missing);
    this.specs = passSurfaces(ask.pass, this.reads);
    this.made = ask.tiles.map(() => null);
  }

  /** The ground's points asked before a first run: none (no surface reads the ground at its every vertex: the terrain meets the roads, `terrainSeams.ts`);
   *  a point the field reads the ground at (a road the solve left) comes back from `run`'s `need`. */
  need(): Float64Array {
    return new Float64Array(0);
  }

  /** The ground's heights at `points` (x, y each), as the page reads it. */
  give(points: Float64Array, heights: Float64Array): void {
    for (let i = 0; i < heights.length; i++) this.heights.add(points[i * 2]!, points[i * 2 + 1]!, heights[i]!);
    if (this.ran) {
      this.missing = [];
      this.renew();
    }
  }

  /** The reads made afresh: a field that read NaN for a point missing remembers it (`roadField.ts` `last`). */
  private renew(): void {
    this.reads = readsOf(this.ask.data, this.heights, this.missing);
    this.specs = passSurfaces(this.ask.pass, this.reads);
  }

  /** Meshes every tile not made yet: the tiles, or the points still missing (`give` them, then `run` again). */
  run(beat?: () => void): { tiles: TileMeshes[] } | { need: Float64Array } {
    this.ran = true;
    for (let k = 0; k < this.ask.tiles.length; k++) {
      if (this.made[k]) continue;
      const before = this.missing.length;
      const part = this.ask.tiles[k]!;
      let tile: TileMeshes = [];
      // Every point of the part remembered while its vertices are read (`RoadReads.remembering`).
      this.reads.field.remembering!(() => {
        tile = [...pieceBundle(part.into, this.specs)];
      });
      if (this.missing.length === before) this.made[k] = tile;
      else this.renew();
      beat?.();
    }
    if (this.missing.length > 0) {
      const seen = new PointHeights();
      const out: number[] = [];
      for (let i = 0; i < this.missing.length; i += 2) {
        const x = this.missing[i]!, y = this.missing[i + 1]!;
        if (!seen.add(x, y, 0)) out.push(x, y);
      }
      return { need: Float64Array.from(out) };
    }
    return { tiles: this.made as TileMeshes[] };
  }
}

/** Every buffer of the tiles' arrays, to hand back (MDN, "Transferable objects"). */
export function tileBuffers(tiles: readonly TileMeshes[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const tile of tiles) {
    for (const [, t] of tile) {
      out.push(t.positions.buffer as ArrayBuffer, t.normals.buffer as ArrayBuffer, t.uvs.buffer as ArrayBuffer,
        t.colors.buffer as ArrayBuffer, t.sections.buffer as ArrayBuffer, t.indices.buffer as ArrayBuffer);
      if (t.box) out.push(t.box.buffer as ArrayBuffer);
    }
  }
  return out;
}
