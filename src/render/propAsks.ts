import type { ChangeJournal, ChangeRect } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { CellKey, ViewCells } from '@world/viewCells';
import type { PropLayerSpec, PropPlacement } from './propCells';

/**
 * THE PLACEMENTS A PROP LAYER ASKS OFF THE PAGE (`PropLayerSpec.ask`), by their rectangle (a near cell's; a far block's, which both far classes
 * read): asked when the view first wants the cell, held until each cache that asked it has taken it or no longer wants it (`prune`); one a change
 * reached let go (`follow`: its answer, read before or after the change, never taken), asked again. A cell is derived only once its placement came
 * (`ready`). A layer with no `ask` places on the page: every cell ready, its placing made when derived.
 */

/** A cache a placement was asked for (a near cell's, or a far block's of one class). */
type Asker = Pick<ViewCells<unknown>, 'wants' | 'has' | 'rectOf'>;
/** A placement asked: null until it comes; who asked it, each taking it once. */
interface Asked { readonly rect: ChangeRect; placement: PropPlacement | null; askers: { readonly cells: Asker; readonly key: CellKey }[] }

export interface PropAsks {
  /** Whether `cells` may derive its cell `key` now: its placement come from off the page (asked now if it was not), or placed on the page. */
  ready(cells: Asker, key: CellKey): boolean;
  /** The placement `cells` derives its cell from: the one come from off the page (taken), or placed now. */
  placementFor(cells: Asker, key: CellKey, rect: ChangeRect): PropPlacement;
  /** The placements no cache wants any more let go: those come, and those asked whose askers all went (left to come, then let go). */
  prune(): void;
  /** The placements a change reached (their rectangles grown by the layer's `pad`) let go: everything, when the diary cannot say where. */
  follow(journal: ChangeJournal): void;
  /** Every placement asked let go, its answer never taken. */
  clear(): void;
}

const rectKey = (r: ChangeRect): string => `${r[0]},${r[1]},${r[2]},${r[3]}`;

export function createPropAsks(spec: Pick<PropLayerSpec, 'name' | 'changes' | 'pad' | 'place' | 'ask' | 'arrived'>): PropAsks {
  const asked = new Map<string, Asked>();
  const cursor = spec.ask ? new JournalCursor(spec.changes) : null;
  return {
    ready(cells, key) {
      if (!spec.ask) return true;
      const rect = cells.rectOf(key), k = rectKey(rect);
      let known = asked.get(k);
      if (!known) {
        const answer = spec.ask(rect);
        if (!answer) return true;
        const entry: Asked = { rect, placement: null, askers: [] };
        known = entry;
        asked.set(k, entry);
        answer.then((placement) => {
          if (asked.get(k) !== entry) return;
          entry.placement = placement;
          spec.arrived?.();
        }, (error: unknown) => {
          // Placed here instead, from the document as it is now (a change since let the entry go: `follow`).
          console.error(`[${spec.name}] a placement could not be worked out off the page; placed on the page`, error);
          if (asked.get(k) !== entry) return;
          entry.placement = spec.place(entry.rect);
          spec.arrived?.();
        });
      }
      if (!known.askers.some((a) => a.cells === cells && a.key === key)) known.askers.push({ cells, key });
      return known.placement !== null;
    },
    placementFor(cells, key, rect) {
      const k = rectKey(rect);
      const known = asked.get(k);
      if (!known?.placement) return spec.place(rect);
      known.askers = known.askers.filter((a) => a.cells !== cells || a.key !== key);
      if (!known.askers.length) asked.delete(k);
      return known.placement;
    },
    prune() {
      for (const [k, known] of asked) {
        known.askers = known.askers.filter((a) => a.cells.wants(a.key) && !a.cells.has(a.key));
        if (!known.askers.length && known.placement) asked.delete(k);
      }
    },
    follow(journal) {
      if (!cursor) return;
      const entries = cursor.read(journal);
      if (entries === null || entries.some((e) => e.rects === null)) { asked.clear(); return; }
      const pad = spec.pad;
      for (const e of entries) {
        for (const r of e.rects!) {
          for (const [k, known] of asked) {
            const o = known.rect;
            if (o[0] - pad <= r[2] && o[2] + pad >= r[0] && o[1] - pad <= r[3] && o[3] + pad >= r[1]) asked.delete(k);
          }
        }
      }
    },
    clear() { asked.clear(); },
  };
}
