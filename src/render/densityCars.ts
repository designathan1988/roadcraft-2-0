import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { TILE } from '@world/tiles';
import { pinned } from './pinned';
import { TERRAIN_MAX_HEIGHT, TERRAIN_MIN_HEIGHT } from '@world/terrain';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { laneOffset } from '@world/roadTypes';
import { m } from '@world/units';
import type { SimClient } from '@sim/host/simClient';
import { MESO_INSIDE, MESO_ONE_WAY, MESO_PRESENT, MESO_RECORD, MICRO_RADIUS, ML, MesoMemory } from '@sim/meso/memory';
import { JAM_SPACING } from '@sim/meso/model';
import { linkDirection, linkSegment } from '@sim/meso/tileLinks';
import { IMPOSTOR_FRAMES_GLSL } from './impostorShaders';
import { FRAGMENT_PARS, SET_MODELS, STILL_READ_GLSL, STILL_SLOPES, VARYINGS, colourNormal, stillOf } from './plantImpostors';
import { type FarCarBody, LEAST_CAR_PX, createFarCarPictures } from './farCarPictures';

/** THE FAR TRAFFIC: the meso model's cars on every road outside the micro window, as Cidade's density cars, a draw a tile */
/** DO NOT write every far car again at each meso step nor draw the tiles off the view: each link's cars belong to the tile of its middle, a mesh a tile culled by its sphere, and only the tiles where a link's numbers changed are written and sent.
 *  DO NOT walk every link the worker holds each step: it sends only the links that changed (`MesoDelta`), and only those are looked at here. */
// Each car an instance (its link's slot, place, lane, speed); the vertex shader places it on the link's road in a float texture (`texelFetch`):
// the page's roads by their centreline, the far tiles' straight through the start, middle and end their link tables give (`meso/tileLinks.ts`).

/** Points of a road's centreline in the texture, evenly spaced along it (a bend between two of them is a straight chord). */
const LINK_POINTS = 8;
/** Texels a row of the centreline texture: a whole number of roads a row. */
const TEX_WIDTH = 1024;
const ROADS_PER_ROW = TEX_WIDTH / LINK_POINTS;
/** How far the view's centre moves from the window's before the window is moved. */
const RECENTRE = MICRO_RADIUS * 0.3;
/** Seconds of the wall a window message may go unanswered (the worker not up yet) before it is sent again. */
const RESEND_MS = 2000;
/** Most far cars drawn: past it the roads of a tile written last are not written. */
const MOST_CARS = 1 << 18;
/** A link's numbers its cars are written from (`SIGNATURE` floats a slot): their count, queue, speed, lanes, road length and flags. */
const SIGNATURE = 6;
/** A tile's mesh starts with room for this many cars; it doubles with them. */
const TILE_START = 256;
/** A tile's sphere: its half diagonal and the land's heights, with a car's room over the highest deck. */
const TILE_RADIUS = Math.hypot(TILE / 2, TILE / 2, (TERRAIN_MAX_HEIGHT - TERRAIN_MIN_HEIGHT) / 2 + m(80));
/** The shader's clock wraps here (seconds): a float keeps a car's place to a few centimetres. */
const TIME_WRAP = 4096;
/** A far road's lane, for its cars' places across it (its profile is the store's, not on the page). */
const FAR_LANE = m(3.5);

/** A car's picture: one quad, its corners about its centre (`farCarPictures.ts`: each model's sphere, read by the model's index). */
function pictureQuad(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

const VERTEX_PARS = /* glsl */ `
uniform highp sampler2D uLinks;
uniform float uTime;
uniform vec3 uWindow;
// Half the target's height, device pixels; the fewest pixels long a car is drawn at.
uniform vec2 uSize;
uniform vec4 uSpheres[${SET_MODELS}];
uniform vec2 uBlockOf[${SET_MODELS}];
uniform float uLengths[${SET_MODELS}];
attribute vec4 aLink;
attribute vec4 aMove;
attribute vec3 aPaint;
varying vec3 vPaint;
${IMPOSTOR_FRAMES_GLSL}
${VARYINGS}
flat varying mat3 vNormalToWorld;
vec4 linkPoint(float slot, int k) {
  int i = int(slot) * ${LINK_POINTS} + k;
  return texelFetch(uLinks, ivec2(i % ${TEX_WIDTH}, i / ${TEX_WIDTH}), 0);
}
`;

// aLink: the link's slot, place along its travel (m), lateral offset to the right of travel (m), direction (1: from the road's b to its a).
// aMove: speed (m/s), the stretch it moves round (0: standing in the queue), seed, its model (-1: none pictured). aPaint: its paint, linear.
const VERTEX_PLACE = /* glsl */ `
float roadLength = linkPoint(aLink.x, 0).w;
float travel = aMove.y > 0.0 ? mod(aLink.y + aMove.x * uTime, aMove.y) : aLink.y;
float along = aLink.w > 0.5 ? roadLength - travel : travel;
float u = clamp(along / max(roadLength, 0.001), 0.0, 1.0) * float(${LINK_POINTS - 1});
int i0 = int(min(floor(u), float(${LINK_POINTS - 2})));
vec3 p0 = linkPoint(aLink.x, i0).xyz;
vec3 p1 = linkPoint(aLink.x, i0 + 1).xyz;
vec3 carAt = mix(p0, p1, u - float(i0));
vec2 carT = (p1 - p0).xz;
carT = dot(carT, carT) > 1e-8 ? normalize(carT) : vec2(1.0, 0.0);
if (aLink.w > 0.5) carT = -carT;
vec2 carRight = vec2(-carT.y, carT.x);
carAt.xz += carRight * aLink.z;
// Inside the micro window its cars are the micro simulation's: this one is folded to a point (no triangle drawn).
bool carHidden = roadLength <= 0.0 || length(vec2(carAt.x, -carAt.z) - uWindow.xy) < uWindow.z;
// The model's frame in the world: its length along the travel, its width to the right of it, up (a right-handed frame: x cross y is z).
mat3 carFrame = mat3(vec3(carT.x, 0.0, carT.y), vec3(0.0, 1.0, 0.0), vec3(carRight.x, 0.0, carRight.y));
// The picture's normal is read off the atlas (\`colourNormal\`).
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
`;

/**
 * The car's picture facing the eye, its frame the nearest of the 64 its model was taken from (the near props' still pictures,
 * \`plantImpostors.ts\` vertexMain, with the car's place and frame worked out above in place of an instance's matrix); folded to a point
 * where nothing is drawn: inside the micro window, no picture of its kind, or under \`LEAST_CAR_PX\` long.
 */
const VERTEX_TRANSFORM = /* glsl */ `
vec3 transformed = carAt;
vPaint = aPaint;
if (!carHidden && aMove.w > -0.5) {
  int carModel = int(aMove.w + 0.5);
  vec4 sphere = uSpheres[carModel];
  vec4 footClip = projectionMatrix * viewMatrix * vec4(carAt, 1.0);
  float perUnit = projectionMatrix[1][1] * uSize.x / max(footClip.w, 1e-4);
  if (uLengths[carModel] * perUnit >= uSize.y) {
    vec3 eyeWorld = cameraPosition;
    if (projectionMatrix[2][3] == 0.0) eyeWorld = carAt + vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) * 1.0e5;
    vec3 eye = transpose(carFrame) * (eyeWorld - carAt) - sphere.xyz;
    vec3 dir = normalize(eye);
    // Never from below: the lowest pictures are level.
    dir = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z) + vec3(0.0, 1e-5, 0.0));
    vec3 qx, qy;
    frameBasis(dir, qx, qy);
    vec3 corner = (qx * position.x + qy * position.y) * (2.0 * sphere.w);
    vec3 ray = normalize(corner - eye);
    vec2 grid = hemiOctaEncode(dir) * (FRAMES - 1.0);
    vec2 cell = min(floor(grid), vec2(FRAMES - 2.0));
    vec2 f = clamp(grid - cell, 0.0, 1.0);
    vec3 w = vec3(min(1.0 - f.x, 1.0 - f.y), abs(f.x - f.y), min(f.x, f.y));
    vWeights = w.x >= w.y && w.x >= w.z ? vec3(1.0, 0.0, 0.0) : w.y >= w.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
    vFrame1 = cell;
    vFrame2 = cell + (f.x >= f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    vFrame3 = cell + vec2(1.0);
    vFrameUv1 = frameUv(vFrame1, eye, ray, sphere.w);
    vFrameUv2 = frameUv(vFrame2, eye, ray, sphere.w);
    vFrameUv3 = frameUv(vFrame3, eye, ray, sphere.w);
    vBlock = uBlockOf[carModel];
    vNormalToWorld = carFrame;
    transformed = carAt + carFrame * (sphere.xyz + corner);
  }
}
`;

/** The picture's colour (\`plantImpostors.ts\` COLOUR_MAP_STILL): its cover blended, its colours times the car's paint, as the near traffic's
 *  far model is painted (\`agents.ts\` paint: the model's own colours times the car's). */
const COLOUR_MAP = /* glsl */ `
  ${STILL_SLOPES}
  vec4 impostorColour = ${stillOf('uAlbedo')};
  {
    float cover = impostorColour.a;
    if (cover < ${(0.5 / 255).toFixed(6)}) discard;
    diffuseColor = vec4(diffuseColor.rgb * vPaint * pow(min(impostorColour.rgb / max(impostorColour.a, 1e-4), vec3(1.0)), vec3(2.2)), cover);
  }
`;

export interface DensityCars {
  readonly object: Group;
  /** Each frame: the window told the worker, the roads' lines the network or the meso changed written, the cars of a new meso step written. */
  update(net: Network, sim: SimClient, focusX: number, focusY: number): void;
  dispose(): void;
}

/** A far road's car across it, to the right of its travel (`laneOffset` without the road's profile: a two-way road's lanes right of its centre, a one-way's about it). */
const farLateral = (lane: number, lanes: number, oneWay: boolean): number =>
  oneWay ? FAR_LANE * (lane - (lanes - 1) / 2) : FAR_LANE * (lane + 0.5);

/** `heightAt`: the road's deck at a point, or the ground's for a road not on the page (`renderer.ts` deckHeight); `bodies`: the near traffic's
 *  (`AgentMeshes.farBodies`), whose pictures the cars are drawn as (none: nothing drawn, the specs). */
export function createDensityCars(heightAt: (x: number, y: number, segment: SegmentId | undefined) => number, bodies: readonly FarCarBody[] = []): DensityCars {
  const pictures = createFarCarPictures(bodies);
  const memory = new MesoMemory();
  let sent: { x: number; y: number; at: number } | null = null;
  /** The slots the deltas taken this frame changed, and a stamp a slot to keep each once. */
  const changed: number[] = [];
  const unique: number[] = [];
  let seenStamp = new Uint32Array(0);
  let stamp = 0;
  let netState: object | null = null;
  /** Each slot's link as its line was written (NaN: none), the worker's serial of that line, and the slots by their segment (the network's delta names segments). */
  let slotLink = new Float64Array(0);
  let seenShape = new Float32Array(0);
  const bySegment = new Map<number, Set<number>>();

  // The lines, a link's slot a run of `LINK_POINTS` texels: x, height, -y (three's axes) and the road's length; in the road's own order (a to b).
  let rows = 1;
  let lines = new Float32Array(TEX_WIDTH * rows * 4);
  /** A texture not yet uploaded whole is sent whole: no ranges on it (three r186 `updateTexture` sends only the ranges when it has some, its first upload too, the rest left zero on the GPU: the far cars of those roads hidden, AGT-16). Whole until three says it went up (`onUpdate`), not until the next frame (it is not drawn while no far tile is in view). */
  let whole = true;
  const watch = (t: DataTexture): DataTexture => { t.onUpdate = () => { whole = false; }; return t; };
  let texture = watch(makeTexture(lines, rows));
  /** Each model's sphere, block and length as the shader reads them by index, the slots past the set's models empty. */
  const padded = <T>(values: readonly T[] | undefined, empty: () => T): T[] => Array.from({ length: SET_MODELS }, (_, k) => values?.[k] ?? empty());
  const uniforms = {
    uLinks: { value: texture }, uTime: { value: 0 }, uWindow: { value: new Vector3() },
    uSize: { value: new Vector2(540, LEAST_CAR_PX) },
    uSpheres: { value: padded(pictures?.spheres, () => new Vector4()) },
    uBlockOf: { value: padded(pictures?.blocks, () => new Vector2()) },
    uLengths: { value: padded(pictures?.lengths, () => 0) },
    uAlbedo: { value: pictures?.set.albedo ?? null },
    uNormals: { value: pictures?.set.normals ?? null },
    uBlocks: { value: new Vector2(pictures?.set.blocks.x ?? 1, pictures?.set.blocks.y ?? 1) },
    // The atlas's finest level read alone (a still set's, `STILL_READ_GLSL`).
    uPerMip: { value: 0 },
  };

  // The near paint's surface (`agents.ts` paint), its cover blended over what is behind it with its depth written (a still set's pictures, `createImpostors`).
  const material = new MeshStandardMaterial({ roughness: 0.38, metalness: 0.28, envMapIntensity: 1.35, transparent: true, depthWrite: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <beginnormal_vertex>', VERTEX_PLACE)
      .replace('#include <begin_vertex>', VERTEX_TRANSFORM);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}\nuniform sampler2D uAlbedo;\nuniform sampler2D uNormals;\nuniform float uPerMip;\nflat varying mat3 vNormalToWorld;\nvarying vec3 vPaint;\n${STILL_READ_GLSL}`)
      .replace('#include <map_fragment>', COLOUR_MAP)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${colourNormal(stillOf('uNormals'), true)}`);
  };
  material.customProgramCacheKey = () => 'density-cars-pictures';
  /** The target's height read as a tile is drawn: what a car's pixels are measured against (the post chain's targets, the canvas). */
  const viewport = new Vector4();
  const measureTarget = (renderer: { getCurrentViewport(target: Vector4): Vector4 }): void => {
    uniforms.uSize.value.x = renderer.getCurrentViewport(viewport).w / 2;
  };
  /** A car's paint, written into its instance. */
  const paint = new Color();

  const shape = pictureQuad();
  const group = new Group();
  group.name = 'densityCars';
  pinned(group);

  /** The cars of one tile: a mesh culled by the tile's sphere, its links (slots), and whether one of them changed since it was written. */
  interface CarTile {
    readonly mesh: Mesh;
    geometry: InstancedBufferGeometry;
    link: Float32Array;
    move: Float32Array;
    paint: Float32Array;
    linkAttribute: InstancedBufferAttribute;
    moveAttribute: InstancedBufferAttribute;
    paintAttribute: InstancedBufferAttribute;
    capacity: number;
    n: number;
    readonly slots: Set<number>;
    dirty: boolean;
    readonly key: number;
  }
  const tiles = new Map<number, CarTile>();
  /** Each slot's tile, and the numbers its cars were last written from (NaN: write them). */
  const slotTile: (CarTile | undefined)[] = [];
  let signature = new Float32Array(0);
  /** Cars written in every tile. */
  let total = 0;

  /** A geometry for a tile with room for `n` cars (the old one let go: three keeps a geometry's buffers until it is disposed), its sphere the tile's. */
  function tileGeometry(tile: Pick<CarTile, 'link' | 'move' | 'paint' | 'linkAttribute' | 'moveAttribute' | 'paintAttribute' | 'capacity'>, n: number, sphere: Sphere): InstancedBufferGeometry {
    const g = new InstancedBufferGeometry();
    g.index = shape.index;
    g.setAttribute('position', shape.getAttribute('position'));
    g.setAttribute('normal', shape.getAttribute('normal'));
    tile.link = new Float32Array(n * 4);
    tile.move = new Float32Array(n * 4);
    tile.paint = new Float32Array(n * 3);
    tile.linkAttribute = new InstancedBufferAttribute(tile.link, 4).setUsage(DynamicDrawUsage);
    tile.moveAttribute = new InstancedBufferAttribute(tile.move, 4).setUsage(DynamicDrawUsage);
    tile.paintAttribute = new InstancedBufferAttribute(tile.paint, 3).setUsage(DynamicDrawUsage);
    g.setAttribute('aLink', tile.linkAttribute);
    g.setAttribute('aMove', tile.moveAttribute);
    g.setAttribute('aPaint', tile.paintAttribute);
    g.instanceCount = 0;
    // The cars are placed by the shader inside their tile: the tile's sphere is what the view culls.
    g.boundingSphere = sphere;
    tile.capacity = n;
    return g;
  }

  /** The tile at (cx, cy), made on first use. */
  function tileAt(cx: number, cy: number): CarTile {
    const key = cx * 65536 + cy;
    let tile = tiles.get(key);
    if (tile) return tile;
    const sphere = new Sphere(new Vector3((cx + 0.5) * TILE, (TERRAIN_MAX_HEIGHT + TERRAIN_MIN_HEIGHT) / 2, -(cy + 0.5) * TILE), TILE_RADIUS);
    const made = { link: new Float32Array(0), move: new Float32Array(0), paint: new Float32Array(0), capacity: 0 } as unknown as CarTile;
    const geometry = tileGeometry(made, TILE_START, sphere);
    const mesh = new Mesh(geometry, material);
    mesh.name = `densityCars-${cx},${cy}`;
    pinned(mesh);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.onBeforeRender = measureTarget;
    // Nothing drawn until a car is written.
    mesh.visible = false;
    tile = Object.assign(made, { mesh, geometry, n: 0, slots: new Set<number>(), dirty: false, key });
    tiles.set(key, tile);
    group.add(mesh);
    return tile;
  }

  /** A tile with no road left: its cars out of the count, its mesh off the group, its geometry's buffers released (three keeps them until disposed). */
  function dropTile(tile: CarTile): void {
    tiles.delete(tile.key);
    total -= tile.n;
    group.remove(tile.mesh);
    letGoTile(tile.geometry);
  }

  /** The slot's link filed in the tile of its middle (`ML.mx`, `ML.my`); the tiles it left and joined written again. */
  function fileSlot(slot: number): void {
    const r = slot * MESO_RECORD, recs = memory.links;
    const present = (recs[r + ML.flags]! & MESO_PRESENT) !== 0 && !Number.isNaN(slotLink[slot] ?? Number.NaN);
    const mx = recs[r + ML.mx]!, my = recs[r + ML.my]!;
    const next = present && Number.isFinite(mx) && Number.isFinite(my) ? tileAt(Math.floor(mx / TILE), Math.floor(my / TILE)) : undefined;
    const was = slotTile[slot];
    if (was === next) return;
    if (was) {
      was.slots.delete(slot);
      was.dirty = true;
      // DO NOT keep a tile the window left: its mesh, geometry and buffers let go with its last road, or every tile the camera ever passed stays (grows with the path, not the view).
      if (was.slots.size === 0) dropTile(was);
    }
    if (next) { next.slots.add(slot); next.dirty = true; }
    slotTile[slot] = next;
  }

  /** Room in the texture for slot `slot`: rows doubled, what was written kept. */
  function roomFor(slot: number): void {
    const need = Math.floor(slot / ROADS_PER_ROW) + 1;
    if (need <= rows) return;
    let next = rows;
    while (next < need) next *= 2;
    const grown = new Float32Array(TEX_WIDTH * next * 4);
    grown.set(lines);
    lines = grown;
    rows = next;
    texture.dispose();
    texture = watch(makeTexture(lines, rows));
    uniforms.uLinks.value = texture;
    whole = true;
  }

  /** Room to note `n` slots' links. */
  function track(n: number): void {
    if (slotLink.length >= n) return;
    const links = new Float64Array(n).fill(Number.NaN);
    links.set(slotLink);
    slotLink = links;
    const shapes = new Float32Array(n);
    shapes.set(seenShape);
    seenShape = shapes;
    const signatures = new Float32Array(n * SIGNATURE).fill(Number.NaN);
    signatures.set(signature);
    signature = signatures;
    slotTile.length = n;
  }

  /** One slot's line into the texture, its range marked for upload: the page's road by its centreline and deck, a far one straight through its table's points on the ground (none: its cars hidden). */
  function writeLine(net: Network, slot: number): void {
    roomFor(slot);
    const at = slot * LINK_POINTS * 4;
    const id = slotLink[slot] ?? Number.NaN;
    const segment = linkSegment(id) as SegmentId;
    const line = Number.isNaN(id) ? undefined : net.ribbons.get(segment)?.full;
    if (line && line.length > 0) {
      for (let k = 0; k < LINK_POINTS; k++) {
        const f = line.sampleAt((line.length * k) / (LINK_POINTS - 1)).p;
        lines[at + k * 4] = f.x;
        lines[at + k * 4 + 1] = heightAt(f.x, f.y, segment);
        lines[at + k * 4 + 2] = -f.y;
        lines[at + k * 4 + 3] = line.length;
      }
    } else {
      const r = slot * MESO_RECORD, recs = memory.links;
      const ax = recs[r + ML.ax]!, ay = recs[r + ML.ay]!, mx = recs[r + ML.mx]!, my = recs[r + ML.my]!, bx = recs[r + ML.bx]!, by = recs[r + ML.by]!;
      const first = Math.hypot(mx - ax, my - ay), second = Math.hypot(bx - mx, by - my), L = first + second;
      if (Number.isNaN(id) || !(L > 0)) lines.fill(0, at, at + LINK_POINTS * 4);
      else {
        for (let k = 0; k < LINK_POINTS; k++) {
          const d = (L * k) / (LINK_POINTS - 1);
          const onFirst = d <= first;
          const t = onFirst ? (first > 0 ? d / first : 0) : (second > 0 ? (d - first) / second : 1);
          const x = onFirst ? ax + (mx - ax) * t : mx + (bx - mx) * t;
          const y = onFirst ? ay + (my - ay) * t : my + (by - my) * t;
          lines[at + k * 4] = x;
          lines[at + k * 4 + 1] = heightAt(x, y, undefined);
          lines[at + k * 4 + 2] = -y;
          lines[at + k * 4 + 3] = L;
        }
      }
    }
    if (!whole) texture.addUpdateRange(at, LINK_POINTS * 4);
    texture.needsUpdate = true;
    // Its cars written again (their length and lanes across the road come from the line).
    if (slot * SIGNATURE < signature.length) signature[slot * SIGNATURE] = Number.NaN;
    const tile = slotTile[slot];
    if (tile) tile.dirty = true;
  }

  /** DO NOT write every line again for an edit or a tile come or gone: only the slots of the segments the network's delta names (a road on the page now drawn by its centreline, or gone back to its table's line). */
  function syncLines(net: Network): void {
    if (netState === net.state) return;
    const delta = netState === null ? null : net.changesSince(netState);
    netState = net.state;
    if (delta === null) {
      // @rebuild A map opened: every known slot's line.
      for (const slots of bySegment.values()) for (const slot of slots) writeLine(net, slot);
      return;
    }
    for (const id of delta.segments) for (const slot of bySegment.get(id) ?? []) writeLine(net, slot);
  }

  /** The slots of the deltas whose link or line the worker changed (`ML.shape`): their link noted and their line written. */
  function readLines(net: Network, slots: readonly number[]): void {
    track(memory.capacity);
    const recs = memory.links;
    const changed: number[] = [];
    for (const slot of slots) {
      const r = slot * MESO_RECORD;
      if ((recs[r + ML.flags]! & MESO_PRESENT) !== 0 && recs[r + ML.shape]! !== seenShape[slot]) changed.push(slot);
    }
    // Many rows changed (a buffer or a reach filled): one upload of the whole texture, not a range a row (`WebGLTextures.updateTexture`).
    if (changed.length > ROADS_PER_ROW * 4) { texture.clearUpdateRanges(); whole = true; }
    for (const slot of changed) {
      seenShape[slot] = recs[slot * MESO_RECORD + ML.shape]!;
      const was = slotLink[slot]!, now = memory.ids[slot]!;
      if (was !== now) {
        if (!Number.isNaN(was)) {
          // A segment no slot holds any more: forgotten (DO NOT keep a set for every segment the window ever had).
          const left = bySegment.get(linkSegment(was));
          if (left) { left.delete(slot); if (left.size === 0) bySegment.delete(linkSegment(was)); }
        }
        slotLink[slot] = now;
        let set = bySegment.get(linkSegment(now));
        if (!set) bySegment.set(linkSegment(now), set = new Set());
        set.add(slot);
      }
      fileSlot(slot);
      writeLine(net, slot);
    }
  }

  /** The window told the worker (again when the view moved far enough, or nobody answered); whole while no delta came (every link sent). */
  function tellWindow(sim: SimClient, x: number, y: number): void {
    const now = performance.now();
    const moved = !sent || Math.hypot(x - sent.x, y - sent.y) > RECENTRE;
    const unanswered = !!sent && memory.serial === 0 && now - sent.at > RESEND_MS;
    if (!moved && !unanswered) return;
    const cx = moved || !sent ? x : sent.x, cy = moved || !sent ? y : sent.y;
    sim.window(cx, cy, MICRO_RADIUS, memory.serial === 0);
    sent = { x: cx, y: cy, at: now };
  }

  /** The tiles of the slots whose numbers the meso step changed (their count, queue, speed, lanes, line or flags), marked to be written. */
  function noteChanges(slots: readonly number[]): void {
    const recs = memory.links;
    for (const slot of slots) {
      const tile = slotTile[slot];
      if (!tile) continue;
      const r = slot * MESO_RECORD, o = slot * SIGNATURE;
      const flags = recs[r + ML.flags]! & (MESO_PRESENT | MESO_INSIDE | MESO_ONE_WAY);
      const count = recs[r + ML.count]!, queued = recs[r + ML.queued]!, speed = recs[r + ML.speed]!, lanes = recs[r + ML.lanes]!;
      const L = lines[slot * LINK_POINTS * 4 + 3]!;
      if (signature[o] === count && signature[o + 1] === queued && signature[o + 2] === speed && signature[o + 3] === lanes
        && signature[o + 4] === L && signature[o + 5] === flags) continue;
      signature[o] = count; signature[o + 1] = queued; signature[o + 2] = speed; signature[o + 3] = lanes; signature[o + 4] = L; signature[o + 5] = flags;
      tile.dirty = true;
    }
  }

  /** Lanes across a road, to the right of travel (at most a road's lanes; one each, not one a car). */
  const lateralOf: number[] = [];

  /** One tile's cars of the meso step: each road's count, its queue packed at its end, the rest moving round the free stretch; only its buffer sent. */
  function writeTile(net: Network, tile: CarTile): void {
    const recs = memory.links;
    total -= tile.n;
    const room = MOST_CARS - total;
    let n = 0;
    const put = (slot: number, s: number, lateral: number, dir: number, speed: number, wrap: number, seed: number): void => {
      if (n >= tile.capacity) {
        const old = tile.geometry;
        const keepLink = tile.link, keepMove = tile.move, keepPaint = tile.paint;
        tile.geometry = tileGeometry(tile, tile.capacity * 2, old.boundingSphere!);
        tile.link.set(keepLink.subarray(0, n * 4));
        tile.move.set(keepMove.subarray(0, n * 4));
        tile.paint.set(keepPaint.subarray(0, n * 3));
        tile.mesh.geometry = tile.geometry;
        letGoTile(old);
      }
      const at = n * 4;
      const link = tile.link, move = tile.move;
      // Its model and paint by its seed, as the near traffic's mix and its classes' palettes give them (`farCarPictures.ts`).
      const model = pictures ? pictures.modelOf(seed) : -1;
      if (pictures && model >= 0) pictures.paintOf(seed, model, paint); else paint.setRGB(1, 1, 1);
      link[at] = slot; link[at + 1] = s; link[at + 2] = lateral; link[at + 3] = dir;
      move[at] = speed; move[at + 1] = wrap; move[at + 2] = seed; move[at + 3] = model;
      tile.paint[n * 3] = paint.r; tile.paint[n * 3 + 1] = paint.g; tile.paint[n * 3 + 2] = paint.b;
      n++;
    };
    for (const slot of tile.slots) {
      if (n >= room) break;
      const r = slot * MESO_RECORD;
      const flags = recs[r + ML.flags]!;
      if (!(flags & MESO_PRESENT) || flags & MESO_INSIDE) continue;
      const count = Math.round(recs[r + ML.count]!);
      const id = slotLink[slot]!;
      if (count <= 0 || Number.isNaN(id)) continue;
      const dir = linkDirection(id);
      const ribbon = net.ribbons.get(linkSegment(id) as SegmentId);
      // The road's length as its line was written (the page's centreline, or the table's points).
      const L = lines[slot * LINK_POINTS * 4 + 3]!;
      if (!(L > 0)) continue;
      const lanes = Math.max(1, Math.round(recs[r + ML.lanes]!));
      const oneWay = (flags & MESO_ONE_WAY) !== 0;
      const cars = Math.min(count, Math.floor((L * lanes) / JAM_SPACING));
      const queued = Math.min(cars, Math.round(recs[r + ML.queued]!));
      for (let lane = 0; lane < lanes; lane++) {
        lateralOf[lane] = ribbon ? -laneOffset(ribbon.road, lane, ribbon.direction, dir === 0) : farLateral(lane, lanes, oneWay);
      }
      for (let k = 0; k < queued && n < room; k++) {
        put(slot, L - (Math.floor(k / lanes) + 0.5) * JAM_SPACING, lateralOf[k % lanes]!, dir, 0, 0, slot * 31 + k);
      }
      const free = cars - queued, stretch = Math.max(0, L - Math.ceil(queued / lanes) * JAM_SPACING);
      const speed = recs[r + ML.speed]!;
      for (let k = 0; k < free && stretch > 0 && n < room; k++) {
        put(slot, ((k + 0.5) / free) * stretch, lateralOf[(queued + k) % lanes]!, dir, speed, stretch, slot * 31 + queued + k);
      }
    }
    for (const attribute of [tile.linkAttribute, tile.moveAttribute, tile.paintAttribute]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, n * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    tile.geometry.instanceCount = n;
    tile.mesh.visible = n > 0;
    tile.n = n;
    total += n;
    tile.dirty = false;
  }

  return {
    object: group,
    update(net, sim, focusX, focusY) {
      tellWindow(sim, focusX, focusY);
      syncLines(net);
      const deltas = sim.takeMeso();
      if (deltas.length) {
        changed.length = 0;
        for (const d of deltas) memory.apply(d, changed);
        // Each slot once, in the order first changed.
        if (seenStamp.length < memory.capacity) seenStamp = new Uint32Array(memory.capacity);
        if (++stamp === 0xffffffff) { stamp = 1; seenStamp.fill(0); }
        unique.length = 0;
        for (const slot of changed) if (seenStamp[slot] !== stamp) { seenStamp[slot] = stamp; unique.push(slot); }
        readLines(net, unique);
        noteChanges(unique);
      }
      // The window the worker stands at (its numbers in this step), not the one asked for: its cars and these meet at its edge.
      uniforms.uWindow.value.set(memory.windowX, memory.windowY, memory.windowR);
      uniforms.uTime.value = sim.clock.time % TIME_WRAP;
      // Drawn once their pictures are taken (`takeWaitingPictures`, between draws).
      group.visible = pictures?.set.ready() ?? false;
      // The tiles a step or an edit changed: written and sent, the others left as they are.
      for (const tile of tiles.values()) if (tile.dirty) writeTile(net, tile);
    },
    dispose() {
      for (const tile of tiles.values()) tile.geometry.dispose();
      shape.dispose();
      material.dispose();
      texture.dispose();
      pictures?.dispose();
    },
  };
}

/** A tile's geometry let go: the car's shape it shares with every tile (its index, position and normal) taken off first, so three frees the tile's own buffers only (r186 `WebGLGeometries` frees every attribute and the index a disposed geometry holds, AGT-17). */
function letGoTile(g: BufferGeometry): void {
  g.setIndex(null);
  g.deleteAttribute('position');
  g.deleteAttribute('normal');
  g.dispose();
}

function makeTexture(data: Float32Array, rows: number): DataTexture {
  const t = new DataTexture(data, TEX_WIDTH, rows, RGBAFormat, FloatType);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
