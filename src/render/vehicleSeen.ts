import type { BufferGeometry } from 'three';

/** WHICH TRIANGLES OF A VEHICLE'S PART ANYONE CAN SEE, from outside the vehicle, through its glass: the vehicle is looked at from directions
 *  spread evenly over the sphere (a Fibonacci lattice, [Gonzalez, Measurement of areas on a sphere using Fibonacci and latitude-longitude
 *  lattices](https://arxiv.org/abs/0912.4540)) down to LOWEST under the horizon (a camera stands above the ground the vehicle stands on), and
 *  what none of them sees is cut, as a sphere of cameras culls a model ([Simplygon, geometry culling](https://simplygon.com/features/geometryculling)).
 *  From each direction the vehicle's opaque triangles are drawn as the game draws them, orthographic, into a depth buffer sampled on a lattice
 *  PITCH apart: only those facing the view (the parts are front-sided: a triangle facing away is not drawn and hides nothing), the glass not at
 *  all (the view passes it). They are drawn by their edge functions ([Pineda, A parallel algorithm for polygon
 *  rasterization](https://history.siggraph.org/?p=119557)), every sample on or inside a triangle's edges covered by it. A triangle of the part is
 *  seen where it lies at the front at a sample it covers (within DEPTH_TIE: two faces in one plane are both drawn, whichever the depth test
 *  keeps), and one too small to cover a sample of a view where it lies within PITCH of the front at the sample nearest its centre (the surface
 *  it is a piece of drawn there). The test this replaces traced rays from four points of each triangle (its centroid and corners drawn in): a
 *  bus's floor seen through a wheel arch had all four behind the body, was cut, and the arch showed daylight under it (2026-10-25).
 *  A level is then made and measured of what is seen of the part (`partLevelsWork.ts`): what no one sees cannot be seen to change. */

/** Directions of view. A piece of a cabin seen only through a slit is seen from a narrow cone of directions: every body drawn whole and without
 *  what is cut, orthographic at 80 px/m (where the first level that cuts is first drawn) from 144 directions and 168 others, differed at 192
 *  directions in up to 18 pixels of a view (the headlining past a roof's edge, from 15 degrees up), at 384 in up to 17, at 768 in none but 5
 *  of the bus's in all 312 views, a shade apart where two of its faces lie in one plane (2026-10-25). A 12.5 mm lattice at 768 left 1-3. A
 *  car's trim is seen in 0.3 s, its cabin in 0.7-1.0, the bus's in 1.8, every body's trim and cabin in 9.8 s (node, 2026-10-25; 15.9 drawing
 *  every occluder over whole blocks of samples). */
const VIEW_DIRECTIONS = 768;
/** The lowest a direction of view goes, radians under the horizon (a camera on a slope below the vehicle). */
const LOWEST = 0.35;
/** The depth buffer's samples apart, metres: the finest level's error (`partLevelsWork.ts` LEVEL_ERRORS), half a pixel where the finest level is
 *  first drawn (80 px/m), and every level is made of what is seen. A piece of a triangle seen half a pixel across there covers a sample. */
const PITCH = 0.00625;
/** Blocks of 2^BLOCK_BITS samples a side: an occluder reaching none holding a sample to draw (`View`) is not drawn at all. */
const BLOCK_BITS = 4;
/** Two depths the same to this are a tie, metres: the models' own weld (`weldGeometry` at 1e-4). */
const DEPTH_TIE = 1e-4;

/** Unit directions of view (towards the viewer), x y z each, in a chain: each the nearest of those left to the one before, so a view is much
 *  like the one before it (`seenTriangles` draws first what hid the part there). Which directions, not their order, is what is seen. */
function viewDirections(n: number): Float64Array {
  const out: number[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  // A lattice over the whole sphere, kept above LOWEST under the horizon (y up).
  const total = Math.ceil(n * 2 / (1 + Math.sin(LOWEST)));
  for (let i = 0; i < total && out.length < n * 3; i++) {
    const y = 1 - (2 * (i + 0.5)) / total;
    if (y < -Math.sin(LOWEST)) break;
    const r = Math.sqrt(1 - y * y), a = golden * i;
    out.push(Math.cos(a) * r, y, Math.sin(a) * r);
  }
  const count = out.length / 3, chain = new Float64Array(out.length), taken = new Uint8Array(count);
  for (let k = 0, at = 0; k < count; k++) {
    taken[at] = 1;
    chain[k * 3] = out[at * 3]!; chain[k * 3 + 1] = out[at * 3 + 1]!; chain[k * 3 + 2] = out[at * 3 + 2]!;
    let next = -1, nearest = -Infinity;
    for (let i = 0; i < count; i++) {
      if (taken[i]) continue;
      const dot = out[i * 3]! * chain[k * 3]! + out[i * 3 + 1]! * chain[k * 3 + 1]! + out[i * 3 + 2]! * chain[k * 3 + 2]!;
      if (dot > nearest) { nearest = dot; next = i; }
    }
    at = next;
  }
  return chain;
}

/** Triangles of a part, nine floats each: what it draws, in the vehicle's frame. */
export type Soup = Float64Array;

/** The triangles a geometry draws, nine numbers each, in its index's order. */
export function soupOf(g: BufferGeometry): Soup {
  const p = g.getAttribute('position'), index = g.getIndex();
  const corners = index ? index.count : p.count;
  const out = new Float64Array(corners * 3);
  for (let i = 0; i < corners; i++) {
    const v = index ? index.getX(i) : i;
    out[i * 3] = p.getX(v); out[i * 3 + 1] = p.getY(v); out[i * 3 + 2] = p.getZ(v);
  }
  return out;
}

/** Soups one after another. */
export function joinSoups(soups: readonly Soup[]): Soup {
  const out = new Float64Array(soups.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const s of soups) { out.set(s, at); at += s.length; }
  return out;
}

/** Triangle `t` of a soup seen from a direction, its frame `f` (u, v across the view, the direction towards the viewer, x y z each): each
 *  corner's place on the lattice through the origin less `ox`, `oy` (x, y, in samples) and its depth (towards the viewer, metres). */
function project(soup: Soup, out: Float64Array, t: number, f: Float64Array, ox: number, oy: number): void {
  for (let k = t * 9; k < t * 9 + 9; k += 3) {
    const x = soup[k]!, y = soup[k + 1]!, z = soup[k + 2]!;
    out[k] = (x * f[0]! + y * f[1]! + z * f[2]!) / PITCH - ox;
    out[k + 1] = (x * f[3]! + y * f[4]! + z * f[5]!) / PITCH - oy;
    out[k + 2] = x * f[6]! + y * f[7]! + z * f[8]!;
  }
}

/** Whether triangle `t` of projected corners `p` is wound towards the viewer. */
function isFacing(p: Float64Array, t: number): boolean {
  const b = t * 9;
  return (p[b + 3]! - p[b]!) * (p[b + 7]! - p[b + 1]!) - (p[b + 6]! - p[b]!) * (p[b + 4]! - p[b + 1]!) > 0;
}

/** The depth buffer of one view, the samples of it drawn, and the triangles drawn into it or tested against it. Only the samples a triangle
 *  tested covers (and the one nearest the centre of one covering none, `seen`) are ever read, so only they are cleared and drawn. */
class View {
  private depth = new Float32Array(0);
  /** Which triangle drew each sample's depth. */
  private owner = new Int32Array(0);
  private width = 0;
  private height = 0;
  /** The samples to draw, row by row: spans of them, first and last across each, in order and apart, those of row j from spans[2 spanAt[j]]
   *  to spans[2 spanAt[j + 1]]. Asked (`reach`) as row, first and last threes until sealed (`seal`), sorted through `sorted` by `cursor`. */
  private asked = new Int32Array(0);
  private askedCount = 0;
  private sorted = new Int32Array(0);
  private cursor = new Int32Array(0);
  private spans = new Int32Array(0);
  private spanAt = new Int32Array(0);
  /** Blocks across and down, which hold a sample to draw (1) or none (0), and how many hold one up to each (a summed-area table, a row and a
   *  column of zeros first): an occluder reaching none is not drawn. */
  private blocks = 0;
  private rows = 0;
  private need = new Uint8Array(0);
  private sums = new Int32Array(0);
  /** A triangle's rows of samples (`rowsOf`): row, first and last threes. */
  private cells = new Int32Array(0);
  /** A row's samples inside the edges met so far: from span[0] to span[1]. */
  private readonly span = new Float64Array(2);
  /** A triangle's blocks (`blocksOf`). */
  private readonly box = new Int32Array(4);

  /** Sized for a lattice of `width` x `height` samples, no sample to draw (what is drawn is kept: `seal`). */
  clear(width: number, height: number): void {
    this.width = width; this.height = height;
    if (this.depth.length < width * height) { this.depth = new Float32Array(width * height); this.owner = new Int32Array(width * height); }
    if (this.cells.length < 3 * height) this.cells = new Int32Array(3 * height);
    this.askedCount = 0;
  }

  /** Every sample asked (`reach`) put in order and cleared (or, `clear` false, kept as drawn), the blocks holding them counted. */
  seal(clear = true): void {
    const height = this.height, asked = this.asked, n = this.askedCount;
    if (this.spanAt.length < height + 1) { this.spanAt = new Int32Array(height + 1); this.cursor = new Int32Array(height + 1); }
    if (this.sorted.length < 2 * n) this.sorted = new Int32Array(2 * n);
    if (this.spans.length < 2 * n) this.spans = new Int32Array(2 * n);
    const spanAt = this.spanAt, cursor = this.cursor, sorted = this.sorted, spans = this.spans;
    // By row (a counting sort), then across each row by first (a row asks a few), the spans that touch or overlap joined.
    cursor.fill(0, 0, height + 1);
    for (let k = 0; k < n; k++) cursor[asked[k * 3]! + 1]!++;
    for (let j = 0; j < height; j++) cursor[j + 1]! += cursor[j]!;
    for (let k = 0; k < n; k++) {
      const at = cursor[asked[k * 3]!]!++;
      sorted[at * 2] = asked[k * 3 + 1]!; sorted[at * 2 + 1] = asked[k * 3 + 2]!;
    }
    let out = 0, from = 0;
    for (let j = 0; j < height; j++) {
      spanAt[j] = out;
      const to = cursor[j]!;
      for (let k = from + 1; k < to; k++) {
        const a = sorted[k * 2]!, b = sorted[k * 2 + 1]!;
        let i = k - 1;
        for (; i >= from && sorted[i * 2]! > a; i--) { sorted[(i + 1) * 2] = sorted[i * 2]!; sorted[(i + 1) * 2 + 1] = sorted[i * 2 + 1]!; }
        sorted[(i + 1) * 2] = a; sorted[(i + 1) * 2 + 1] = b;
      }
      for (let k = from; k < to; k++) {
        const a = sorted[k * 2]!, b = sorted[k * 2 + 1]!;
        if (out > spanAt[j]! && a <= spans[out * 2 - 1]! + 1) spans[out * 2 - 1] = Math.max(spans[out * 2 - 1]!, b);
        else { spans[out * 2] = a; spans[out * 2 + 1] = b; out++; }
      }
      from = to;
    }
    spanAt[height] = out;
    // Cleared, and the blocks holding them marked and summed.
    this.blocks = (this.width >> BLOCK_BITS) + 1;
    this.rows = (height >> BLOCK_BITS) + 1;
    const blocks = this.blocks, rows = this.rows, w = blocks + 1, size = w * (rows + 1);
    if (this.need.length < blocks * rows) this.need = new Uint8Array(blocks * rows);
    if (this.sums.length < size) this.sums = new Int32Array(size);
    const need = this.need, sums = this.sums, depth = this.depth, width = this.width;
    need.fill(0, 0, blocks * rows);
    for (let j = 0; j < height; j++) {
      for (let s = spanAt[j]!; s < spanAt[j + 1]!; s++) {
        const a = spans[s * 2]!, b = spans[s * 2 + 1]!;
        if (clear) depth.fill(-Infinity, j * width + a, j * width + b + 1);
        need.fill(1, (j >> BLOCK_BITS) * blocks + (a >> BLOCK_BITS), (j >> BLOCK_BITS) * blocks + (b >> BLOCK_BITS) + 1);
      }
    }
    sums.fill(0, 0, size);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < blocks; x++) sums[(y + 1) * w + x + 1] = need[y * blocks + x]! + sums[y * w + x + 1]! + sums[(y + 1) * w + x]! - sums[y * w + x]!;
    }
  }

  /** The blocks triangle `t` of projected corners `p` reaches: first and last across, first and last down, into `out`. */
  private blocksOf(p: Float64Array, t: number, out: Int32Array): void {
    const b = t * 9;
    out[0] = Math.min(this.blocks - 1, Math.max(0, Math.floor(Math.min(p[b]!, p[b + 3]!, p[b + 6]!)) >> BLOCK_BITS));
    out[1] = Math.min(this.blocks - 1, Math.max(0, Math.ceil(Math.max(p[b]!, p[b + 3]!, p[b + 6]!)) >> BLOCK_BITS));
    out[2] = Math.min(this.rows - 1, Math.max(0, Math.floor(Math.min(p[b + 1]!, p[b + 4]!, p[b + 7]!)) >> BLOCK_BITS));
    out[3] = Math.min(this.rows - 1, Math.max(0, Math.ceil(Math.max(p[b + 1]!, p[b + 4]!, p[b + 7]!)) >> BLOCK_BITS));
  }

  /** Whether triangle `t` of projected corners `p` reaches a block holding a sample to draw (`seal` first). */
  reaches(p: Float64Array, t: number): boolean {
    const b = t * 9;
    if (Math.max(p[b]!, p[b + 3]!, p[b + 6]!) < 0 || Math.max(p[b + 1]!, p[b + 4]!, p[b + 7]!) < 0
      || Math.min(p[b]!, p[b + 3]!, p[b + 6]!) > this.width - 1 || Math.min(p[b + 1]!, p[b + 4]!, p[b + 7]!) > this.height - 1) return false;
    const box = this.box, sums = this.sums, w = this.blocks + 1;
    this.blocksOf(p, t, box);
    const x0 = box[0]!, x1 = box[1]!, y0 = box[2]!, y1 = box[3]!;
    return sums[(y1 + 1) * w + x1 + 1]! - sums[y0 * w + x1 + 1]! - sums[(y1 + 1) * w + x0]! + sums[y0 * w + x0]! > 0;
  }

  /** The rows of samples triangle `t` of projected corners `p` covers (on or inside its edges, those of a triangle wound towards the viewer
   *  on their left), row, first and last threes into `cells`: how many. */
  private rowsOf(p: Float64Array, t: number): number {
    const b = t * 9;
    const x0 = p[b]!, y0 = p[b + 1]!, x1 = p[b + 3]!, y1 = p[b + 4]!, x2 = p[b + 6]!, y2 = p[b + 7]!;
    const jLo = Math.max(0, Math.ceil(Math.min(y0, y1, y2))), jHi = Math.min(this.height - 1, Math.floor(Math.max(y0, y1, y2)));
    const span = this.span, cells = this.cells;
    let n = 0;
    for (let j = jLo; j <= jHi; j++) {
      span[0] = -Infinity; span[1] = Infinity;
      if (!this.within(x0, y0, x1, y1, j) || !this.within(x1, y1, x2, y2, j) || !this.within(x2, y2, x0, y0, j)) continue;
      const iLo = Math.max(0, Math.ceil(span[0])), iHi = Math.min(this.width - 1, Math.floor(span[1]));
      if (iLo > iHi) continue;
      cells[n * 3] = j; cells[n * 3 + 1] = iLo; cells[n * 3 + 2] = iHi;
      n++;
    }
    return n;
  }

  /** Narrows `span` to the samples of row y = j left of the edge from (ax, ay) to (bx, by) (on it included); false: none of the row's. */
  private within(ax: number, ay: number, bx: number, by: number, j: number): boolean {
    const ex = bx - ax, ey = by - ay, span = this.span;
    if (ey > 0) span[1] = Math.min(span[1]!, ax + (ex * (j - ay)) / ey);
    else if (ey < 0) span[0] = Math.max(span[0]!, ax + (ex * (j - ay)) / ey);
    else return ex * (j - ay) >= 0;
    return true;
  }

  /** The sample nearest the centre of triangle `t` of projected corners `p`: its place in the buffer. */
  private nearest(p: Float64Array, t: number): number {
    const b = t * 9;
    const i = Math.min(this.width - 1, Math.max(0, Math.round((p[b]! + p[b + 3]! + p[b + 6]!) / 3)));
    const j = Math.min(this.height - 1, Math.max(0, Math.round((p[b + 1]! + p[b + 4]! + p[b + 7]!) / 3)));
    return j * this.width + i;
  }

  /** The samples triangle `t` of projected corners `p` (facing the viewer) is tested at (`seen`), to be drawn. */
  reach(p: Float64Array, t: number): void {
    const n = this.rowsOf(p, t), cells = this.cells;
    for (let k = 0; k < n; k++) this.ask(cells[k * 3]!, cells[k * 3 + 1]!, cells[k * 3 + 2]!);
    if (n === 0) {
      const at = this.nearest(p, t), i = at % this.width;
      this.ask((at - i) / this.width, i, i);
    }
  }

  /** Row j's samples first to last to be drawn. */
  private ask(j: number, first: number, last: number): void {
    if (this.asked.length < (this.askedCount + 1) * 3) {
      const grown = new Int32Array(Math.max(3 * 1024, this.asked.length * 2));
      grown.set(this.asked);
      this.asked = grown;
    }
    const at = this.askedCount++ * 3;
    this.asked[at] = j; this.asked[at + 1] = first; this.asked[at + 2] = last;
  }

  /** Triangle `t` of projected corners `p` (`project`, facing the viewer) drawn: its depth kept where it is nearer, at the samples to draw. */
  draw(p: Float64Array, t: number): void {
    const b = t * 9;
    const x0 = p[b]!, y0 = p[b + 1]!, z0 = p[b + 2]!, x1 = p[b + 3]!, y1 = p[b + 4]!, z1 = p[b + 5]!, x2 = p[b + 6]!, y2 = p[b + 7]!, z2 = p[b + 8]!;
    // Twice its area on the lattice (positive: it faces the viewer), and its depth's plane over the lattice.
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const a = ((z1 - z0) * (y2 - y0) - (z2 - z0) * (y1 - y0)) / area, c = ((x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)) / area;
    const jLo = Math.max(0, Math.ceil(Math.min(y0, y1, y2))), jHi = Math.min(this.height - 1, Math.floor(Math.max(y0, y1, y2)));
    const depth = this.depth, owner = this.owner, width = this.width, spans = this.spans, spanAt = this.spanAt;
    // The edges worked out as `within` does them, in place: a triangle is drawn over hundreds of rows a view.
    const left = Math.min(x0, x1, x2), right = Math.max(x0, x1, x2);
    const e0x = x1 - x0, e0y = y1 - y0, e1x = x2 - x1, e1y = y2 - y1, e2x = x0 - x2, e2y = y0 - y2;
    for (let j = jLo; j <= jHi; j++) {
      // A row with no sample to draw, or none across the triangle's reach, is passed.
      const first = spanAt[j]!, last = spanAt[j + 1]!;
      if (first === last || spans[first * 2]! > right || spans[last * 2 - 1]! < left) continue;
      let lo = -Infinity, hi = Infinity;
      if (e0y > 0) hi = Math.min(hi, x0 + (e0x * (j - y0)) / e0y);
      else if (e0y < 0) lo = Math.max(lo, x0 + (e0x * (j - y0)) / e0y);
      else if (!(e0x * (j - y0) >= 0)) continue;
      if (e1y > 0) hi = Math.min(hi, x1 + (e1x * (j - y1)) / e1y);
      else if (e1y < 0) lo = Math.max(lo, x1 + (e1x * (j - y1)) / e1y);
      else if (!(e1x * (j - y1) >= 0)) continue;
      if (e2y > 0) hi = Math.min(hi, x2 + (e2x * (j - y2)) / e2y);
      else if (e2y < 0) lo = Math.max(lo, x2 + (e2x * (j - y2)) / e2y);
      else if (!(e2x * (j - y2) >= 0)) continue;
      const iLo = Math.max(0, Math.ceil(lo)), iHi = Math.min(width - 1, Math.floor(hi));
      if (iLo > iHi) continue;
      const row = j * width;
      // Over the row's spans to be drawn it meets.
      for (let s = first; s < last; s++) {
        const from = Math.max(iLo, spans[s * 2]!), to = Math.min(iHi, spans[s * 2 + 1]!);
        if (from > to) { if (spans[s * 2]! > iHi) break; continue; }
        let z = z0 + a * (from - x0) + c * (j - y0);
        for (let i = from; i <= to; i++, z += a) if (z > depth[row + i]!) { depth[row + i] = z; owner[row + i] = t; }
      }
    }
  }

  /** Whether triangle `t` of projected corners `p` (facing the viewer, `reach`ed) is seen: it lies at the front at a sample it covers, or,
   *  covering none, within PITCH of the front at the sample nearest its centre (the surface it is a piece of drawn there, a sample's step from
   *  its nearest corner at a slope of 45 degrees). */
  seen(p: Float64Array, t: number): boolean {
    const n = this.rowsOf(p, t), depth = this.depth, cells = this.cells, width = this.width;
    const b = t * 9;
    if (n === 0) return Math.max(p[b + 2]!, p[b + 5]!, p[b + 8]!) + PITCH >= depth[this.nearest(p, t)]! - DEPTH_TIE;
    const x0 = p[b]!, y0 = p[b + 1]!, z0 = p[b + 2]!, x1 = p[b + 3]!, y1 = p[b + 4]!, z1 = p[b + 5]!, x2 = p[b + 6]!, y2 = p[b + 7]!, z2 = p[b + 8]!;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const a = ((z1 - z0) * (y2 - y0) - (z2 - z0) * (y1 - y0)) / area, c = ((x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)) / area;
    for (let k = 0; k < n; k++) {
      const j = cells[k * 3]!, iLo = cells[k * 3 + 1]!, iHi = cells[k * 3 + 2]!, row = j * width;
      let z = z0 + a * (iLo - x0) + c * (j - y0);
      for (let i = iLo; i <= iHi; i++, z += a) if (z >= depth[row + i]! - DEPTH_TIE) return true;
    }
    return false;
  }

  /** Adds to `out`, from its `n`th, the triangles that drew the front at the samples triangle `t` of projected corners `p` is tested at
   *  (`seen`), those marked `stamp` in `mark` left out and the rest marked; how many `out` then holds. */
  hiders(p: Float64Array, t: number, mark: Int32Array, stamp: number, out: Int32Array, n: number): number {
    const rows = this.rowsOf(p, t), cells = this.cells, owner = this.owner, width = this.width;
    if (rows === 0) {
      const o = owner[this.nearest(p, t)]!;
      if (mark[o] !== stamp) { mark[o] = stamp; out[n++] = o; }
      return n;
    }
    for (let k = 0; k < rows; k++) {
      const row = cells[k * 3]! * width;
      for (let i = cells[k * 3 + 1]!; i <= cells[k * 3 + 2]!; i++) {
        const o = owner[row + i]!;
        if (mark[o] !== stamp) { mark[o] = stamp; out[n++] = o; }
      }
    }
    return n;
  }
}

/** Triangle `t`'s nine numbers as a key. */
const triangleAt = (soup: Soup, t: number): string => soup.subarray(t * 9, t * 9 + 9).join(',');

/** Whether each triangle of `part` (nine floats a triangle) is seen from outside, the vehicle's opaque triangles (`occluders`, the part's own
 *  among them, the same numbers) in the way: 1 seen, 0 not. A part triangle not among the occluders breaks that and is an error. Each view is
 *  drawn only where the triangles of the part not yet seen that face it are tested (their window and the samples they cover), first by what
 *  hid them in the view before. */
export function seenTriangles(part: Soup, occluders: Soup): Uint8Array {
  const count = occluders.length / 9;
  // The part's triangles among the occluders.
  const at = new Map<string, number>();
  for (let t = 0; t < count; t++) { const k = triangleAt(occluders, t); if (!at.has(k)) at.set(k, t); }
  const of = new Int32Array(part.length / 9);
  const tested = new Uint8Array(count);
  for (let t = 0; t < of.length; t++) {
    const o = at.get(triangleAt(part, t));
    if (o === undefined) throw new Error(`[vehicles] triangle ${t} of a part is not among the occluders it is seen past`);
    of[t] = o;
    tested[o] = 1;
  }
  // Each occluder's neighbours, those sharing a corner with it: those of what hid the part are drawn first with it (a view turned a little
  // shows the part past it, behind them).
  const cornerOf = new Map<string, number>();
  const corners = new Int32Array(count * 3);
  for (let k = 0; k < count * 3; k++) {
    const key = `${occluders[k * 3]},${occluders[k * 3 + 1]},${occluders[k * 3 + 2]}`;
    let c = cornerOf.get(key);
    if (c === undefined) { c = cornerOf.size; cornerOf.set(key, c); }
    corners[k] = c;
  }
  const byCorner = new Int32Array(cornerOf.size + 1);
  for (let k = 0; k < count * 3; k++) byCorner[corners[k]! + 1]!++;
  for (let c = 0; c < cornerOf.size; c++) byCorner[c + 1]! += byCorner[c]!;
  const around = new Int32Array(count * 3), placed = byCorner.slice(0, cornerOf.size);
  for (let k = 0; k < count * 3; k++) around[placed[corners[k]!]!++] = Math.floor(k / 3);
  const seen = new Uint8Array(count);
  const projected = new Float64Array(occluders.length), facing = new Uint8Array(count), frame = new Float64Array(9);
  const view = new View();
  const directions = viewDirections(VIEW_DIRECTIONS);
  // The part's triangles not yet seen (`open`, `opens` of them); what drew the front where the part was hidden from the view before
  // (`hiders`), marked `first` in `mark` (a view's number from 1; none before the first view); the part's triangles still in question after
  // them (`kept`).
  const open = new Int32Array(count);
  let opens = 0;
  for (let t = 0; t < count; t++) if (tested[t]) open[opens++] = t;
  const hider = new Int32Array(count), mark = new Int32Array(count), kept = new Uint8Array(count);
  let hiders = 0, first = -1;
  for (let d = 0; d < directions.length && opens > 0; d += 3) {
    const dx = directions[d]!, dy = directions[d + 1]!, dz = directions[d + 2]!;
    // The view's plane: u and v across it, u x v = d (a triangle wound towards the viewer is wound anticlockwise on it).
    const [hx, hy, hz] = Math.abs(dy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ux = hy * dz - hz * dy, uy = hz * dx - hx * dz, uz = hx * dy - hy * dx;
    const length = Math.hypot(ux, uy, uz);
    ux /= length; uy /= length; uz /= length;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    frame[0] = ux; frame[1] = uy; frame[2] = uz; frame[3] = vx; frame[4] = vy; frame[5] = vz; frame[6] = dx; frame[7] = dy; frame[8] = dz;
    // On the lattice through the vehicle's origin, over the window of the part's triangles still to be seen that face the view.
    let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
    for (let k = 0; k < opens; k++) {
      const t = open[k]!;
      project(occluders, projected, t, frame, 0, 0);
      if (!isFacing(projected, t)) continue;
      for (let c = t * 9; c < t * 9 + 9; c += 3) {
        xLo = Math.min(xLo, projected[c]!); xHi = Math.max(xHi, projected[c]!);
        yLo = Math.min(yLo, projected[c + 1]!); yHi = Math.max(yHi, projected[c + 1]!);
      }
    }
    if (!(xHi >= xLo)) continue;
    const ox = Math.floor(xLo), oy = Math.floor(yLo);
    for (let t = 0; t < count; t++) {
      if (tested[t] && !seen[t]) for (let c = t * 9; c < t * 9 + 9; c += 3) { projected[c] = projected[c]! - ox; projected[c + 1] = projected[c + 1]! - oy; }
      else project(occluders, projected, t, frame, ox, oy);
      facing[t] = isFacing(projected, t) ? 1 : 0;
    }
    const width = Math.ceil(xHi) - ox + 1, height = Math.ceil(yHi) - oy + 1;
    view.clear(width, height);
    for (let k = 0; k < opens; k++) if (facing[open[k]!]) view.reach(projected, open[k]!);
    view.seal();
    // What hid the part in the view before drawn first: what of the part it hides is hidden from this view whatever else is drawn (a sample's
    // depth only grows), and the rest is drawn only where the part is still in question.
    for (let k = 0; k < hiders; k++) { const t = hider[k]!; if (facing[t] && view.reaches(projected, t)) view.draw(projected, t); }
    view.clear(width, height);
    let rest = 0;
    for (let k = 0; k < opens; k++) {
      const t = open[k]!;
      kept[t] = 0;
      if (!facing[t] || !view.seen(projected, t)) continue;
      kept[t] = 1; rest++;
      view.reach(projected, t);
    }
    if (rest > 0) {
      view.seal(false);
      for (let t = 0; t < count; t++) if (facing[t] && mark[t] !== first && view.reaches(projected, t)) view.draw(projected, t);
      for (let k = 0; k < opens; k++) { const t = open[k]!; if (kept[t] && view.seen(projected, t)) seen[t] = 1; }
    }
    // The next view's first: what drew the front where the part is hidden from this one, and what shares a corner with it.
    first = d / 3 + 1;
    hiders = 0;
    let still = 0;
    for (let k = 0; k < opens; k++) {
      const t = open[k]!;
      if (seen[t]) continue;
      open[still++] = t;
      if (facing[t]) hiders = view.hiders(projected, t, mark, first, hider, hiders);
    }
    opens = still;
    for (let k = 0, found = hiders; k < found; k++) {
      for (let c = hider[k]! * 3; c < hider[k]! * 3 + 3; c++) {
        for (let a = byCorner[corners[c]!]!; a < byCorner[corners[c]! + 1]!; a++) {
          const o = around[a]!;
          if (mark[o] !== first) { mark[o] = first; hider[hiders++] = o; }
        }
      }
    }
  }
  const out = new Uint8Array(of.length);
  for (let t = 0; t < of.length; t++) out[t] = seen[of[t]!]!;
  return out;
}
