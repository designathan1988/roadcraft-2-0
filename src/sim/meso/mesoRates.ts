import { m } from '@world/units';
import { ENTRY_RATE } from '../vehicles/spawn';
import type { DemandCells } from './demand';
import type { MesoModel } from './model';
import { grown } from './slots';

/** THE RATES OF THE MESO'S LINKS (`meso.ts` begin, work): each link's trips from off the world and from its street's land use, a step's worth a tick, into typed arrays by slot and by dense cell - no Map on the step. */

/** A trip's mean length, for the share of a link's traffic that ends its trip on it and how often its street's lots send one out. */
const TRIP_LENGTH = m(3000);

export class MesoRates {
  /** Each slot's cell demand and trips from off the world, written by `ratesIn` for `MesoModel.setRates`. */
  private slotCars = new Float64Array(0);
  private slotWeight = new Float64Array(0);
  private slotEntry = new Float64Array(0);
  private cellCars = new Float64Array(64);
  private cellWeight = new Float64Array(64);
  private cellsRead = 0;
  /** Each slot's start at the map's edge, and the node map's change it was found at (`Meso.nodesChanged`). */
  private slotEdge = new Uint8Array(0);
  private slotEdgeAt = new Uint32Array(0);

  /** Each cell's numbers once a step, into arrays by its dense index: DO NOT ask the demand once a link (`ratesIn` reads arrays only). */
  readCells(demand: DemandCells): void {
    const cells = demand.cells;
    if (this.cellCars.length < cells) { this.cellCars = new Float64Array(Math.max(cells, this.cellCars.length * 2)); this.cellWeight = new Float64Array(this.cellCars.length); }
    for (let c = 0; c < cells; c++) { this.cellCars[c] = demand.carsPer100m(c); this.cellWeight[c] = demand.weight(c); }
    this.cellsRead = cells;
  }

  /**
   * Each link's trips in [`from`, `to`): from off the world at an entry (`vehicles/spawn.ts` ENTRY_RATE a lane), and its street's own by
   * the land use at this hour. `cellOf`, `placed`, `endFrom`: the meso's tables by slot; `edgeAt`: whether a node is the map's edge, as
   * last found while no node changed (`nodesChanged`): no map asked by a node id each step.
   */
  ratesIn(model: MesoModel, from: number, to: number, cellOf: Int32Array, placed: Uint8Array, endFrom: Float64Array,
    edgeAt: (node: number) => boolean, nodesChanged: number, scale: number): void {
    if (this.slotCars.length < model.slots) {
      let size = Math.max(256, this.slotCars.length);
      while (size < model.slots) size *= 2;
      this.slotCars = grown(this.slotCars, size); this.slotWeight = grown(this.slotWeight, size); this.slotEntry = grown(this.slotEntry, size);
      this.slotEdge = grown(this.slotEdge, size); this.slotEdgeAt = grown(this.slotEdgeAt, size);
    }
    for (let slot = from; slot < to; slot++) {
      if (!model.has(slot)) continue;
      const cell = cellOf[slot]!;
      const known = cell >= 0 && cell < this.cellsRead;
      this.slotCars[slot] = known ? this.cellCars[cell]! : 0;
      this.slotWeight[slot] = known ? this.cellWeight[cell]! : 0;
      if (this.slotEdgeAt[slot] !== nodesChanged) { this.slotEdgeAt[slot] = nodesChanged; this.slotEdge[slot] = placed[slot] && edgeAt(endFrom[slot]!) ? 1 : 0; }
      this.slotEntry[slot] = this.slotEdge[slot] ? ENTRY_RATE * model.lanesAt(slot) : 0;
    }
    // Balanced with the share ending here: the street holds the ambient's density in free flow.
    model.setRates(this.slotEntry, this.slotCars, this.slotWeight, m(100), TRIP_LENGTH, scale, from, to);
  }
}
