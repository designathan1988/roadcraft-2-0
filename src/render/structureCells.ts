import { BoxGeometry, Group, type Material } from 'three';
import type { ChangeRect } from '@world/changes';
import { CELL, CellFiling } from '@world/cells';
import type { RoadElevation } from '@world/elevation';
import type { Network, SegmentRibbon } from '@world/network';
import type { SceneMaterials } from './materials';
import { SPAN_REACH, buildStructureDetails, pierShape, type StructureDetails } from './structures';

/** DO NOT build every viaduct and tunnel of the map again because an edit reached one of them */

/** A structure's cell's key: the world's own cells (`world/cells.ts` CELL). */
const cellKey =(ix: number, iy: number): number => (ix + 0x8000) * 0x10000 + (iy + 0x8000);
const cellOfRibbon = (ribbon: SegmentRibbon): number => {
  const b = ribbon.full.bbox;
  return cellKey(Math.floor((b.minX + b.maxX) / 2 / CELL), Math.floor((b.minY + b.maxY) / 2 / CELL));
};
const cellRect = (key: number): ChangeRect => {
  const ix = Math.floor(key / 0x10000) - 0x8000, iy = (key % 0x10000) - 0x8000;
  return [ix * CELL, iy * CELL, (ix + 1) * CELL, (iy + 1) * CELL];
};

/** A cell's structures, and the box they read (each road's own box grown by the reach of its details). */
interface Cell { readonly details: StructureDetails; readonly reads: ChangeRect }

export interface StructureCells {
  readonly group: Group;
  readonly triangles: number;
  /** The cells a road edit reached (`blocks`: where the roads or the ground changed, and the road cells the view took or let go; null: every
   *  cell held) built again; `within`: whether a cell's square is one the view has (`mesh/roadResidency.ts` taken) - a cell not within is let go,
   *  and none is built outside. DO NOT build the structures of the whole map: the cells built are the view's, as the roads' are. */
  prepare(net: Network, elevation: RoadElevation, terrainAt: (x: number, y: number) => number,
    blocks: readonly (readonly [number, number, number, number])[] | null, within?: (rect: ChangeRect) => boolean): { readonly fresh: readonly Group[]; apply(): void };
  /** Every cell let go (another map opened), the shapes kept. */
  clear(): void;
  dispose(): void;
}

export function createStructureCells(materials: SceneMaterials, groundMaterial?: Material): StructureCells {
  const group = new Group();
  group.name = 'road-structure-details';
  // The shapes every cell's instances are drawn with, made once.
  const shapes = { pier: pierShape(), box: new BoxGeometry(1, 1, 1) };
  const cells = new Map<number, Cell>();
  /** The cells by the box their structures read: what an edit there reaches. */
  const filing = new CellFiling<number, Cell>();
  let triangles = 0;

  /** The roads whose line centres in the cell. */
  const ribbonsOf = (net: Network, key: number): SegmentRibbon[] => {
    const out: SegmentRibbon[] = [];
    for (const id of net.segmentCells.idsMeeting(cellRect(key))) {
      const ribbon = net.ribbons.get(id);
      if (ribbon && cellOfRibbon(ribbon) === key) out.push(ribbon);
    }
    return out.sort((a, b) => a.id - b.id);
  };

  return {
    group,
    get triangles() { return triangles; },
    prepare(net, elevation, terrainAt, blocks, within) {
      const reached = blocks;
      const dirty = new Set<number>();
      if (reached === null) {
        /** @rebuild Every cell held, when the edit cannot say where: never the map's roads - the cells are the view's (`within`). */
        for (const key of cells.keys()) dirty.add(key);
      } else {
        for (const b of reached) {
          for (const id of net.segmentCells.idsMeeting([b[0] - SPAN_REACH, b[1] - SPAN_REACH, b[2] + SPAN_REACH, b[3] + SPAN_REACH])) {
            const ribbon = net.ribbons.get(id);
            if (ribbon) dirty.add(cellOfRibbon(ribbon));
          }
          for (const key of filing.idsMeeting(b)) dirty.add(key);
        }
      }
      // A cell held that the view no longer has goes with this build.
      if (within) for (const key of cells.keys()) if (!within(cellRect(key))) dirty.add(key);
      const made = new Map<number, Cell | null>();
      for (const key of dirty) {
        const ribbons = within && !within(cellRect(key)) ? [] : ribbonsOf(net, key);
        const details = ribbons.length ? buildStructureDetails(net, elevation, terrainAt, materials, groundMaterial, ribbons, shapes) : null;
        if (!details || details.group.children.length === 0) { details?.dispose(); made.set(key, null); continue; }
        let reads: ChangeRect | null = null;
        for (const s of details.spans) reads = reads ? [Math.min(reads[0], s[0]), Math.min(reads[1], s[1]), Math.max(reads[2], s[2]), Math.max(reads[3], s[3])] : [s[0], s[1], s[2], s[3]];
        made.set(key, { details, reads: reads ?? cellRect(key) });
      }
      return {
        fresh: [...made.values()].filter((c): c is Cell => c !== null).map((c) => c.details.group),
        apply() {
          for (const [key, cell] of made) {
            const was = cells.get(key);
            if (was) {
              group.remove(was.details.group);
              triangles -= was.details.triangles;
              was.details.dispose();
              cells.delete(key);
              filing.remove(key);
            }
            if (!cell) continue;
            cells.set(key, cell);
            filing.file(key, cell, cell.reads);
            group.add(cell.details.group);
            triangles += cell.details.triangles;
          }
        },
      };
    },
    clear() {
      for (const [key, cell] of cells) { group.remove(cell.details.group); cell.details.dispose(); filing.remove(key); }
      cells.clear();
      triangles = 0;
    },
    dispose() {
      for (const cell of cells.values()) cell.details.dispose();
      cells.clear();
      shapes.pier.dispose();
      shapes.box.dispose();
      group.clear();
      triangles = 0;
    },
  };
}
