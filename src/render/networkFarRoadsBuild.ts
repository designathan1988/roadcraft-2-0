import earcut, { refine } from 'earcut';
import { ladderTriangles } from './mesh/stripShape';

/**
 * THE WHOLE NETWORK'S FAR ROADS, MADE FROM THE SAME PIECES AS THE DETAIL (`networkFarRoads.ts`): each road a strip of its carriageway and a strip
 * of its casing each side (the kerb and the footway as one band, out to the footway's outer edge; on a deck to the deck's edge, `segmentPiece.ts`
 * FAR_OUTER), each junction a fan of its carriageway's plate and a strip of its
 * casing at each corner (`roads/segmentPiece.ts` segmentFarShapes, `roads/junctionPiece.ts` junctionFarShapes), laid at their heights and
 * triangulated, filed by their owner block (`roads/pieceOwner.ts`). Pure, run by a job worker (`networkFarRoads.worker.ts`) or, where none can
 * be made, on the page.
 *
 * DO NOT unite the outlines and cut the layers apart (the casing's outline spanned the carriageway, and two coplanar layers told apart by a
 * polygon offset alone fight triangle by triangle in a floating-point depth buffer: OpenGL ES 3.0 spec, 3.6.5 "Depth Offset", the saw-tooth of
 * step-25k 89-ne-district, 2026-10-21). The pieces' strips are disjoint by construction: the carriageway's strip ends where the casing's starts
 * (the same edge, the same points), a road's strips end on its junction's mouth points, where the junction's plate and corners start. Nothing is
 * clipped to a block's square either: a piece is drawn whole in its owner's block, at this level as in the detail, so a block's square stands for
 * the same pieces at both and the two swap with no overlap and no hole (`mesh/roadResidency.ts`).
 */

/** A shape's kind: a strip (its chain a's points, then b's) or a fan (its middle, then its outline). */
export const FAR_STRIP = 0, FAR_FAN = 1;

/** What the page hands over, a shape after the other: its owner block, its layer (0 the casing, 1 the carriageway), its colour (linear rgb), its
 *  kind, its points' counts and its points. */
export interface FarRoadInput {
  /** The blocks' side, world units (the road blocks', `roadSurfaceEntries.ts` CELL; their lines from the origin). */
  readonly cell: number;
  /** The blocks whose pieces are drawn by their detailed surfaces already (the opening's view): none of their pieces is here. Null: none. */
  readonly exclude: readonly [number, number, number, number] | null;
  /** Each shape's owner block, column and row. */
  readonly owners: Int32Array;
  readonly layers: Uint8Array;
  readonly colors: Float32Array;
  readonly kinds: Uint8Array;
  /** Two counts a shape: a strip's chain a's points and chain b's; a fan's outline's points (its middle first, not counted) and 0. */
  readonly sizes: Uint32Array;
  /** Four numbers a point: x, y, its height, its arc length along its road (a strip's chains; 0 for a fan's). */
  readonly points: Float64Array;
  /** A carriageway's paint as the detail's carriageway carries it (`roadSurfaceReads.ts` asphaltSection, asphaltPlate), so the far level inks the
   *  same lines and marks (`mesh/roadEdges.ts` applyRoadFarPaint): one a point, its offset across its road (left of the road's way positive; a
   *  plate's 0), and one a shape, its slot in the paint's table (`roadPaint.ts`: a road's, a plate's `-2 - slot` of its node; -1 none). */
  readonly across: Float32Array;
  readonly slots: Float32Array;
}

/** One block's layer: positions in the scene (x, height, -y), a colour a vertex, the carriageway's section a vertex (`FAR_SECTION` numbers: across,
 *  along, the paint's slot, the surface's code, as the detail's `roadSection`; none on the casing), the triangles. */
export interface FarRoadCell {
  readonly key: string;
  readonly layer: number;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly sections: Float32Array;
  readonly indices: Uint32Array;
}

/** Numbers a vertex of a carriageway's section (`mesh/surfaceTiles.ts` SECTION_SIZE): across, along, slot, code (the carriageway's, 0). */
export const FAR_SECTION = 4;
/** The layer of the carriageway, whose vertices carry its section. */
export const FAR_CARRIAGEWAY = 1;

interface Builder { positions: number[]; colors: number[]; sections: number[]; indices: number[] }

/** A junction's plate's triangles (a fan's outline, the vertices 1 to `count`; its middle, vertex 0, unused): its outline alone, cut by ear clipping
 *  and refined to Delaunay quality by edge flips (earcut 3.2 and its `refine`, https://github.com/mapbox/earcut), no point added, as the detail cuts
 *  it (`roads/pieceMesh.ts` plateTriangles) and the owner's road tool does (`du`). DO NOT fan it from its middle: the worst triangulation there is
 *  (Persson, https://www.humus.name/index.php?page=News&ID=228), and two more triangles than its outline needs. */
function plateTriangles(points: Float64Array, at: number, count: number): number[] {
  const flat: number[] = [];
  for (let i = 0; i < count; i++) flat.push(points[at + (1 + i) * 4]!, points[at + (1 + i) * 4 + 1]!);
  const tris = earcut(flat);
  refine(tris, flat, 2);
  return tris;
}

/** The blocks' layers, a shape after the other into its owner's (see the file's comment). */
export function buildFarRoadCells(input: FarRoadInput): FarRoadCell[] {
  const { owners, layers, colors, kinds, sizes, points, across, slots } = input;
  const builders = new Map<string, Builder>();
  let at = 0;
  for (let k = 0; k < kinds.length; k++) {
    const na = sizes[k * 2]!, nb = sizes[k * 2 + 1]!;
    const kind = kinds[k]!;
    const start = at;
    at += (kind === FAR_FAN ? 1 + na : na + nb) * 4;
    const key = `${owners[k * 2]!},${owners[k * 2 + 1]!}`;
    const layer = layers[k]!;
    let tris: ArrayLike<number>;
    let first = start, count: number;
    if (kind === FAR_STRIP) {
      if (na < 2 || nb < 2) continue;
      const chain = (from: number, n: number): { xy: Float64Array; s: Float64Array } => {
        const xy = new Float64Array(n * 2), s = new Float64Array(n);
        for (let i = 0; i < n; i++) { xy[i * 2] = points[from + i * 4]!; xy[i * 2 + 1] = points[from + i * 4 + 1]!; s[i] = points[from + i * 4 + 3]!; }
        return { xy, s };
      };
      tris = ladderTriangles({ a: chain(start, na), b: chain(start + na * 4, nb) }).tris;
      count = na + nb;
    } else {
      if (na < 3) continue;
      tris = plateTriangles(points, start, na);
      first = start + 4;
      count = na;
    }
    if (tris.length === 0) continue;
    // Counter-clockwise on the plan, seen from above (the material draws the front faces alone): a strip's or an outline's way round turned.
    let twice = 0;
    for (let t = 0; t + 2 < tris.length; t += 3) {
      const a = first + tris[t]! * 4, b = first + tris[t + 1]! * 4, c = first + tris[t + 2]! * 4;
      twice += (points[b]! - points[a]!) * (points[c + 1]! - points[a + 1]!) - (points[b + 1]! - points[a + 1]!) * (points[c]! - points[a]!);
    }
    const flip = twice < 0;
    const name = `${key}|${layer}`;
    let b = builders.get(name);
    if (!b) builders.set(name, b = { positions: [], colors: [], sections: [], indices: [] });
    const base = b.positions.length / 3;
    for (let i = 0; i < count; i++) {
      const p = first + i * 4;
      b.positions.push(points[p]!, points[p + 2]!, -points[p + 1]!);
      b.colors.push(colors[k * 3]!, colors[k * 3 + 1]!, colors[k * 3 + 2]!);
      // A road's point its place along it; a plate's none (`roadSurfaceReads.ts` asphaltPlate: 0 across, -1 along).
      if (layer === FAR_CARRIAGEWAY) b.sections.push(across[p / 4]!, kind === FAR_STRIP ? points[p + 3]! : -1, slots[k]!, 0);
    }
    for (let t = 0; t + 2 < tris.length; t += 3) {
      if (flip) b.indices.push(base + tris[t]!, base + tris[t + 2]!, base + tris[t + 1]!);
      else b.indices.push(base + tris[t]!, base + tris[t + 1]!, base + tris[t + 2]!);
    }
  }
  const out: FarRoadCell[] = [];
  for (const [name, b] of builders) {
    const [key, layer] = name.split('|') as [string, string];
    out.push({
      key, layer: Number(layer), positions: new Float32Array(b.positions), colors: new Float32Array(b.colors), sections: new Float32Array(b.sections),
      indices: new Uint32Array(b.indices),
    });
  }
  return out;
}
