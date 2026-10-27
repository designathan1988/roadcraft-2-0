import type { Tile } from './tileMesh';

/**
 * A ROAD TILE AS IT IS KEPT BETWEEN SESSIONS (`derivedCache.ts`, `roadSurfaces.ts` stored): its sections name the roads and nodes whose paint
 * they read by their ids, never by their slots. A slot is its document's, counted out in the order a session first asks for each road and node
 * (`roadPaint.ts`), so the same tile made in two sessions carried other numbers. DO NOT keep a tile with its slots, nor key it by them: the 10 km
 * city's 3,395 kept tiles were never found again, and every opening made 10,458 tiles again (38 s of it, 2026-10-27).
 *
 * In a kept tile a section's third number is an index into its `pieces` (kind, id pairs: 0 a road, 1 a node): a road's index `k`, a node's
 * `-2 - k`, -1 none - the same signs as a slot. Read back, each piece is given this session's slot (`sessionForm`). Only the surfaces whose
 * sections carry slots (the carriageway's: `roadSurfaceReads.ts` asphaltSection, asphaltPlate) are told so; any other's third number is its own
 * (a footway's 1) and stays as it is.
 */

/** The surfaces a pass's tiles carry the paint's slots in, by name: those its specs give a plate's section (the carriageway's) and their far tiles. */
export function slotSurfaces(specs: readonly { readonly options: { readonly name: string; readonly plateSection?: unknown } }[], farName: (name: string) => string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const spec of specs) if (spec.options.plateSection !== undefined) { out.add(spec.options.name); out.add(farName(spec.options.name)); }
  return out;
}

/** Where a session's slots come from and go to: the road or node a slot was counted out for, and the slot of a road or a node. */
export interface SlotPieces {
  pieceOf(slot: number): { readonly kind: 0 | 1; readonly id: number } | undefined;
}
export interface PieceSlots {
  road(id: number): number;
  node(id: number): number;
}

/** A bundle's tiles as kept: the tiles of `carrying` surfaces (`slotSurfaces`) with their sections copied, their slots as indices into their own
 *  `pieces`; every other array, and every other tile, as it is. */
export function keptForm(bundle: ReadonlyMap<string, Tile>, slots: SlotPieces, carrying: ReadonlySet<string>): Map<string, Tile> {
  const out = new Map<string, Tile>();
  for (const [name, tile] of bundle) {
    if (!carrying.has(name) || !tile.sections.length) { out.set(name, tile); continue; }
    const index = new Map<number, number>();
    const pieces: number[] = [];
    const sections = tile.sections.slice();
    for (let i = 2; i < sections.length; i += 3) {
      const z = sections[i]!;
      if (z === -1) continue;
      const slot = z >= 0 ? z : -2 - z;
      let k = index.get(slot);
      if (k === undefined) {
        const piece = slots.pieceOf(slot);
        if (!piece) throw new Error(`[roads] a tile's slot ${slot} was never counted out: it cannot be kept`);
        const kind = z >= 0 ? 0 : 1;
        if (piece.kind !== kind) throw new Error(`[roads] a tile's slot ${slot} is a ${piece.kind === 0 ? 'road' : 'node'}'s, read as a ${kind === 0 ? 'road' : 'node'}'s`);
        k = pieces.length / 2;
        index.set(slot, k);
        pieces.push(kind, piece.id);
      }
      sections[i] = z >= 0 ? k : -2 - k;
    }
    out.set(name, { ...tile, sections, pieces: Float64Array.from(pieces) });
  }
  return out;
}

/** A kept bundle's tiles given this session's slots (`PieceSlots`), in place: their sections' indices made slots again, their pieces let go. */
export function sessionForm(bundle: Map<string, Tile>, slots: PieceSlots): Map<string, Tile> {
  for (const [name, tile] of bundle) {
    const pieces = tile.pieces;
    if (!pieces) continue;
    const slotOf: number[] = [];
    for (let k = 0; k < pieces.length / 2; k++) slotOf.push(pieces[2 * k] === 0 ? slots.road(pieces[2 * k + 1]!) : slots.node(pieces[2 * k + 1]!));
    const sections = tile.sections;
    for (let i = 2; i < sections.length; i += 3) {
      const z = sections[i]!;
      if (z === -1) continue;
      sections[i] = z >= 0 ? slotOf[z]! : -2 - slotOf[-2 - z]!;
    }
    const { pieces: _kept, ...own } = tile;
    bundle.set(name, own);
  }
  return bundle;
}
