import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { pullTowardEye } from './depthConvention';
import { flatTriangles } from './roads/pieceMesh';
import { type FarShape, deckOf, segmentFarShapes } from './roads/segmentPiece';
import { junctionFarShapes } from './roads/junctionPiece';
import { STREET_MEANS } from './roadTones';

/** A ROAD JUST BUILT, DRAWN ON THE PAGE IN THE NEXT FRAME UNTIL THE WORLD'S BUILD OF ITS COMMIT LANDS (`renderer.ts` worldSteps): its casing and its carriageway, and the junctions at its ends, from the network the commit solved: the same pieces as the far level's (`roads/segmentPiece.ts` segmentFarShapes, `roads/junctionPiece.ts` junctionFarShapes), strips and fans that meet edge on edge, never outlines filled one over the other
 *  - DO NOT leave a road built invisible until the world's build lands: the coarse in place until the fine comes, as every level does. */


/** What the stand-in reads of the roads' heights (`RoadElevation`). */
export interface StandInHeights {
  onSegment(segment: SegmentId, x: number, y: number): number;
  at(x: number, y: number): number;
}

/** One material each, made once: the mean of the street's texture (`STREET_MEANS`, linear, as the far level paints it; a light slab stood out over the asphalt), a plain standard material (its program the same as every untextured one), pulled over the ground it lies on. */
function standInMaterial(mean: readonly [number, number, number], steps: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: new Color().setRGB(mean[0], mean[1], mean[2]), roughness: 0.9, metalness: 0 });
  material.name = 'road-stand-in';
  pullTowardEye(material, 1, steps);
  return material;
}

/** A piece's shapes triangulated (`flatTriangles`) and laid at `height`, each into its layer's arrays (0 the casing, 1 the carriageway): positions,
 *  indices appended. */
function fill(shapes: readonly FarShape[], height: (x: number, y: number) => number, out: readonly { positions: number[]; indices: number[] }[]): void {
  for (const { layer, geom } of shapes) {
    const made = flatTriangles(geom);
    if (!made) continue;
    const into = out[layer]!;
    const base = into.positions.length / 3;
    for (let i = 0; i < made.xy.length; i += 2) into.positions.push(made.xy[i]!, height(made.xy[i]!, made.xy[i + 1]!), -made.xy[i + 1]!);
    for (const t of made.tris) into.indices.push(base + t);
  }
}

/** A mesh of the outlines laid, or null for none. */
function meshOf(parts: { positions: number[]; indices: number[] }, material: MeshStandardMaterial, order: number): Mesh | null {
  if (parts.indices.length === 0) return null;
  const g = new BufferGeometry();
  const positions = new Float32Array(parts.positions);
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  g.setIndex(new BufferAttribute(positions.length / 3 > 0xffff ? new Uint32Array(parts.indices) : new Uint16Array(parts.indices), 1));
  g.computeBoundingSphere();
  const mesh = new Mesh(g, material);
  mesh.name = 'road-stand-in';
  mesh.renderOrder = order;
  mesh.receiveShadow = true;
  return mesh;
}

/** THE ROADS JUST BUILT, BY THE COMMIT THEY CAME WITH, until the world's build of that commit lands. */
export class RoadStandIn {
  readonly group = new Group();
  private readonly casing = standInMaterial(STREET_MEANS.footway, 2);
  private readonly asphalt = standInMaterial(STREET_MEANS.asphalt, 3);
  /** Each commit's stand-in meshes by the network revision it made: let go once a build of that revision landed (`landed`). DO NOT keep only the last commit's: each edit starts the world's build again, and the roads of every commit before it were drawn nowhere until the last build landed (two blocks laid one road a second, jogador-vazio 08-10). */
  private readonly byRevision = new Map<number, Mesh[]>();

  constructor() {
    this.group.name = 'road-stand-ins';
  }

  /** The roads `segments` drawn now (the commit's network solved, of network revision `revision`): their outlines, and the junctions at their ends whose every road is one of them.
   *  - DO NOT draw a road or a junction that was there before (a street the new one meets, split at the new junction): it is drawn already, and the stand-in's flat tone covered it until the build came (via2 37/40). */
  show(net: Network, heights: StandInHeights, segments: Iterable<SegmentId>, revision: number): void {
    const only = new Set(segments);
    const casingParts = { positions: [] as number[], indices: [] as number[] };
    const asphaltParts = { positions: [] as number[], indices: [] as number[] };
    const nodes = new Set<NodeId>();
    for (const id of only) {
      const ribbon = net.ribbons.get(id);
      const segment = net.doc.segment(id);
      if (!ribbon || !segment) continue;
      fill(segmentFarShapes(net, ribbon, deckOf(net, [id])), (x, y) => heights.onSegment(id, x, y), [casingParts, asphaltParts]);
      nodes.add(segment.a);
      nodes.add(segment.b);
    }
    for (const id of nodes) {
      const levels = net.junctions.get(id);
      const node = net.doc.node(id);
      if (!levels || !node || !node.incident.every((s) => only.has(s))) continue;
      fill(junctionFarShapes(net, id, deckOf(net, node.incident)), (x, y) => heights.at(x, y), [casingParts, asphaltParts]);
    }
    const meshes = [meshOf(casingParts, this.casing, 1), meshOf(asphaltParts, this.asphalt, 2)].filter((m): m is Mesh => m !== null);
    if (!meshes.length) return;
    const kept = this.byRevision.get(revision);
    if (kept) kept.push(...meshes); else this.byRevision.set(revision, meshes);
    for (const mesh of meshes) this.group.add(mesh);
  }

  /** The commits whose stand-ins wait for the world's build (`show`). */
  get revisions(): readonly number[] {
    return [...this.byRevision.keys()];
  }

  /** A build of the world landed, of network revision `revision`: every commit it holds (made at that revision or before) let go, the later ones kept. */
  landed(revision: number): void {
    for (const [key, meshes] of [...this.byRevision]) {
      if (key > revision) continue;
      this.byRevision.delete(key);
      for (const mesh of meshes) { this.group.remove(mesh); mesh.geometry.dispose(); }
    }
  }

  /** Every stand-in let go (another map, the diary read from nothing). */
  clear(): void {
    this.landed(Infinity);
  }

  dispose(): void {
    this.clear();
    this.casing.dispose();
    this.asphalt.dispose();
  }
}
