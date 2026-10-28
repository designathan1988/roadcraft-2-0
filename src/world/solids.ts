import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import { BARRIER_SIZE } from './barriers';
import type { PoleId } from './ids';
import { JournalCursor } from './derived';
import type { ChangeKind, ChangeRect } from './changes';
import type { LandscapeKind } from './landscape';
import { m } from './units';

/**
 * THE SOLIDS A BODY MEETS (`render/playEffects.ts` ragdolls): the barriers, the wire poles and the street furniture, by place. Each cell of
 * `CELL` is worked out the first time a query reaches it, from the document's own filing by place (`barrierIdsIn`, `poleIdsIn`,
 * `landscapeIdsIn`), and let go where the diary says its items changed. DO NOT work out the whole map's solids at the first ask (the
 * spine's `allKeys`: every barrier, pole and bench of a 10 km city for one body falling, MISSION.md item 5). The posts of a building's lot
 * (its trees and lamps) are the ragdoll's, with the walls of the buildings near it (`playEffects.ts` wallsNear).
 */
export type Solid =
  | { readonly kind: 'capsule'; readonly a: Vec2; readonly b: Vec2; readonly r: number; readonly box: Box }
  | { readonly kind: 'disc'; readonly c: Vec2; readonly r: number; readonly box: Box };
type Box = readonly [number, number, number, number];

/** The street furniture's reach, by kind (none: walked over). */
const FURNITURE: Readonly<Partial<Record<LandscapeKind, number>>> = {
  tree: m(0.3), shrub: m(0.45), bench: m(0.55), bin: m(0.3), lamp: m(0.15), hydrant: m(0.2),
  postbox: m(0.3), phone: m(0.5), sign: m(0.08), streetname: m(0.08),
};
const POLE = m(0.15);
const CELL = m(25);
/** The most a solid reaches past its item's point (a bench's 0.55 m): a cell's items are asked over it grown by this. */
const REACH = m(0.6);
/** The diary's kinds the solids are made of. */
const KINDS: readonly ChangeKind[] = ['barriers', 'utilities', 'landscape'];

export interface Solids {
  /** Every solid whose box comes within `reach` of (x, y). */
  near(x: number, y: number, reach: number): Solid[];
  /** What keeping it up has cost: the items whose solids were worked out, and the cells. */
  readonly work: { readonly computes: number; readonly cells: number };
}

/** A source item's key: its store and its id. */
export type SourceKey = `r${number}` | `p${number}` | `l${number}`;

const disc = (c: Vec2, r: number): Solid => ({ kind: 'disc', c, r, box: [c.x - r, c.y - r, c.x + r, c.y + r] });
const boxOf = (pts: readonly Vec2[], grow = 0): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
};
const meets = (a: Box, b: ChangeRect): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** The solids of one source item now; empty when it is gone or has none. */
function solidsOfItem(doc: RoadDoc, key: SourceKey): Solid[] {
  const id = Number(key.slice(1));
  const out: Solid[] = [];
  switch (key[0]) {
    case 'r': {
      const bar = doc.barriers.get(id);
      if (!bar) break;
      const r = m(BARRIER_SIZE[bar.kind].thickness) / 2;
      for (let i = 1; i < bar.points.length; i++) {
        const a = bar.points[i - 1]!, b = bar.points[i]!;
        out.push({ kind: 'capsule', a, b, r, box: boxOf([a, b], r) });
      }
      break;
    }
    case 'p': {
      const p = doc.poles.get(id as PoleId);
      if (p) out.push(disc({ x: p.x, y: p.y }, POLE));
      break;
    }
    case 'l': {
      const item = doc.landscape.get(id);
      const r = item ? FURNITURE[item.kind] : undefined;
      if (item && r !== undefined) out.push(disc({ x: item.x, y: item.y }, r));
      break;
    }
  }
  return out;
}

const cellKey = (i: number, j: number): number => i * 65_536 + j;

/** The solids of a document, worked out by cell as queries reach them (`solidsOf`). */
export function createSolids(): { solids: Solids; refresh(doc: RoadDoc): void } {
  /** Each cell worked out: the solids meeting it. */
  const cells = new Map<number, Solid[]>();
  /** Each item's solids, shared by the cells they meet (a query's answer holds each once). */
  const items = new Map<SourceKey, Solid[]>();
  const cursor = new JournalCursor(KINDS);
  let doc: RoadDoc | null = null;
  const work = { computes: 0, cells: 0 };
  const itemSolids = (key: SourceKey): Solid[] => {
    let list = items.get(key);
    if (!list) { items.set(key, list = solidsOfItem(doc!, key)); work.computes++; }
    return list;
  };
  /** A cell's solids, from the items the document files in it grown by `REACH`. */
  const cellOf = (i: number, j: number): Solid[] => {
    const key = cellKey(i, j);
    let list = cells.get(key);
    if (list) return list;
    const box: ChangeRect = [i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL];
    const ask: ChangeRect = [box[0] - REACH, box[1] - REACH, box[2] + REACH, box[3] + REACH];
    list = [];
    const take = (k: SourceKey): void => { for (const s of itemSolids(k)) if (meets(s.box, box)) list!.push(s); };
    for (const id of doc!.barrierIdsIn(ask)) take(`r${id}`);
    for (const id of doc!.poleIdsIn(ask)) take(`p${id}`);
    for (const id of doc!.landscapeIdsIn(ask)) take(`l${id}`);
    cells.set(key, list);
    work.cells++;
    return list;
  };
  /** The cells a rectangle reaches let go, and the items named: worked out again when asked. */
  const forget = (rect: ChangeRect, ids: readonly number[], kind: ChangeKind): void => {
    const prefix = kind === 'barriers' ? 'r' : kind === 'utilities' ? 'p' : 'l';
    for (const id of ids) items.delete(`${prefix}${id}` as SourceKey);
    // An item's solids reach past its point by `REACH`, a barrier's past its box by its half thickness: the cells over the rectangle grown by it.
    for (let i = Math.floor((rect[0] - REACH) / CELL); i <= Math.floor((rect[2] + REACH) / CELL); i++) {
      for (let j = Math.floor((rect[1] - REACH) / CELL); j <= Math.floor((rect[3] + REACH) / CELL); j++) {
        cells.delete(cellKey(i, j));
      }
    }
  };
  const solids: Solids = {
    near(x, y, reach) {
      const out = new Set<Solid>();
      for (let i = Math.floor((x - reach) / CELL); i <= Math.floor((x + reach) / CELL); i++) {
        for (let j = Math.floor((y - reach) / CELL); j <= Math.floor((y + reach) / CELL); j++) {
          for (const s of cellOf(i, j)) {
            if (s.box[0] - reach <= x && s.box[2] + reach >= x && s.box[1] - reach <= y && s.box[3] + reach >= y) out.add(s);
          }
        }
      }
      return [...out];
    },
    get work() { return work; },
  };
  return {
    solids,
    refresh(next) {
      const entries = cursor.read(next.changes);
      // A change the diary cannot place, or names no item (an item's solids are shared by the cells they meet): all of it again, as asked.
      if (next !== doc || entries === null || entries.some((e) => e.rects === null || !e.ids)) {
        doc = next;
        cells.clear();
        items.clear();
        return;
      }
      for (const e of entries) for (const rect of e.rects!) forget(rect, e.ids!, e.kind);
    },
  };
}

const known = new WeakMap<RoadDoc, ReturnType<typeof createSolids>>();

/** The document's solids, brought up to date with the diary: the cells its changes reach let go, nothing else. */
export function solidsOf(doc: RoadDoc): Solids {
  let made = known.get(doc);
  if (!made) known.set(doc, (made = createSolids()));
  made.refresh(doc);
  return made.solids;
}
