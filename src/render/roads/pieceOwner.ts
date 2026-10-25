import type { Vec2 } from '@core/vec2';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';

/**
 * # THE BLOCK A PIECE IS DRAWN IN
 *
 * Every piece (a road between two nodes, a junction) is drawn whole in one block, its owner: the block its owner point lies in (the middle of a road's
 * centreline, a junction's node). The detailed surfaces (`roadSurfaceInputs.ts`) and the network's far level (`networkFarRoads.ts`) both file a piece
 * by this point, so a block's square stands for the same pieces at every level: showing a block's detail and hiding its far level, or the other way
 * round (`mesh/roadResidency.ts`), swaps exactly the same pieces, with no overlap and no hole, and nothing is cut at a block's edge.
 */

/** A road's owner point: the middle of its whole centreline; null where it has no ribbon. */
export function segmentOwner(net: Network, id: SegmentId): Vec2 | null {
  const ribbon = net.ribbons.get(id);
  if (!ribbon || ribbon.full.n < 2) return null;
  return ribbon.full.sampleAt(ribbon.full.length / 2).p;
}

/** A junction's owner point: its node; null for a node gone. */
export function nodeOwner(net: Network, node: NodeId): Vec2 | null {
  const record = net.doc.node(node);
  return record ? { x: record.x, y: record.y } : null;
}

/** The column and row of the block of side `cell` a point lies in (the blocks' lines on the universal grid's, `world/grid.ts`: from the origin). */
export const ownerCell = (at: Vec2, cell: number): [number, number] => [Math.floor(at.x / cell), Math.floor(at.y / cell)];
