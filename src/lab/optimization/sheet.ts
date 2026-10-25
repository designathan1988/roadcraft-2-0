import {
  ACESFilmicToneMapping, Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, HemisphereLight, InstancedMesh, LineBasicMaterial, LineSegments,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, NoToneMapping, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, Vector3, WebGLRenderTarget, WebGLRenderer,
  HalfFloatType, Vector2, type Camera, type Object3D,
} from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { catalogueEntry, catalogueIds, catalogueKits, catalogueResult } from '../catalog/run';
import type { CatalogRow, PieceSpec } from '../catalog/items';
import { geometrySoup, metresPerPixel, surfaceError, triangleSoup, type SurfaceError } from './surfaceError';

/** THE OPTIMISATION SHEETS (`scripts/optimization-sheet.mjs`): every object built by the engine's own builder, alone, on a page that never starts
 *  the game; drawn from four sides, rendered and as a hidden-line wireframe, before a change and after it, with its full measures and how far the
 *  new surface lies from the old one. */

/** Where the sheet looks from: the object's centre and the camera's distance, taken from the "before" object so both are seen alike. */
export interface Framing {
  readonly centre: readonly [number, number, number];
  readonly distance: number;
  readonly floor: number;
  /** The longer of its horizontal sides: the side view looks across it, not along it. */
  readonly long: 'x' | 'z';
}

export interface Metrics {
  readonly id: string;
  readonly triangles: number;
  readonly vertices: number;
  readonly index: string;
  readonly geometryBytes: number;
  readonly bytesPerVertex: number;
  readonly attributes: string;
  readonly materials: string;
  /** Meshes (and geometry groups) it is drawn with: a draw call each. */
  readonly draws: number;
  readonly levels: readonly { readonly triangles: number; readonly vertices: number }[];
  readonly hidden: number | null;
  readonly solids: string;
  readonly size: readonly [number, number, number];
  /** Each piece (a mesh of the object): its label, triangles and vertices. */
  readonly pieces: readonly { readonly label: string; readonly triangles: number; readonly vertices: number }[];
}

export interface Before { readonly soup: string; readonly framing: Framing; readonly block: string; readonly metrics: Metrics; readonly levelErrors: readonly number[] }

export interface Capture {
  readonly key: string;
  readonly metrics: Metrics;
  readonly framing: Framing;
  /** The two columns (rendered | wireframe) of the four views, PNG base64. */
  readonly block: string;
  /** The triangles it draws, in its own frame, Float32 base64 (kept from "before" to measure "after" against). */
  readonly soup: string;
  /** After only: the whole sheet, before and after side by side, PNG base64. */
  readonly sheet?: string;
  readonly error?: SurfaceError | null;
  /** After only: per view, the share of the pixels either silhouette covers that both cover. */
  readonly overlap?: readonly number[];
  /** Each coarser level's two-sided distance from its finest level, metres (the largest over its pieces). */
  readonly levelErrors: readonly number[];
  /** The distance the errors are put in pixels at, metres. */
  readonly distance: number;
}

const VIEWS: readonly { readonly name: string; readonly dir: readonly [number, number, number]; readonly up: readonly [number, number, number] }[] = [
  { name: 'front three-quarter', dir: [-1, 0.75, 1.25], up: [0, 1, 0] },
  { name: 'back three-quarter', dir: [1, 0.75, -1.25], up: [0, 1, 0] },
  { name: 'side', dir: [0.04, 0.12, 1], up: [0, 1, 0] },
  { name: 'top', dir: [0, 1, 0], up: [0, 0, -1] },
];
const FOV = 30;
const PAD = 12;

/** A row's id without the triangle count its builder writes into the variation (`emitPlinth, 16 triangles, ...`), so it is the same before and after. */
export const stableKey = (id: string): string => id.replace(/\b\d[\d,.]*\s+triangles?,?\s*/gi, '').replace(/\s+/g, ' ').trim();

/** The objects of the builder groups `only` names (`run.ts` catalogueKits), built without writing the catalogue's own files. */
export async function optimizationBuild(only: string): Promise<{ id: string; key: string }[]> {
  (window as unknown as { __catalogueNoSave?: boolean }).__catalogueNoSave = true;
  if (catalogueIds().length === 0) await catalogueKits(only);
  return catalogueIds().map((id) => ({ id, key: stableKey(id) })).sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Every object every builder group makes, measured, nothing drawn: the inventory of what is to be optimised, and what could not be built. */
export async function optimizationInventory(): Promise<{ rows: (Metrics & { key: string; group: string; name: string; source: string })[]; gaps: string[] }> {
  await optimizationBuild('');
  const { gaps } = catalogueResult();
  const rows = catalogueIds().flatMap((id) => {
    const entry = catalogueEntry(id);
    return entry ? [{ ...metricsOf(entry.row, entry.object), key: stableKey(id), group: entry.row.group, name: entry.row.name, source: entry.row.source }] : [];
  });
  return { rows, gaps };
}

function renderer(panel: number): WebGLRenderer {
  const w = window as unknown as { __sheetRenderer?: WebGLRenderer };
  if (!w.__sheetRenderer) {
    w.__sheetRenderer = new WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, preserveDrawingBuffer: true });
    w.__sheetRenderer.setPixelRatio(1);
    w.__sheetRenderer.outputColorSpace = SRGBColorSpace;
  }
  w.__sheetRenderer.setSize(panel, panel, false);
  return w.__sheetRenderer;
}

/**
 * A shaded view drawn as the game draws its scene (`render/postprocess.ts`): into a linear half-float target, multisampled, then tone-mapped and
 * encoded onto the canvas (three's OutputPass), so a transparent mesh blends with what is under it in linear light, before the tone mapping, as in
 * the game. Asked by the page (`optimization-sheet.mjs --linear`, `window.__sheetLinear`); else drawn straight onto the canvas, as the sheets
 * always were.
 */
function renderShaded(r: WebGLRenderer, scene: Scene, camera: Camera): void {
  if ((window as unknown as { __sheetLinear?: boolean }).__sheetLinear !== true) { r.render(scene, camera); return; }
  const size = r.getDrawingBufferSize(new Vector2());
  const target = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 });
  const output = new OutputPass();
  try {
    r.setRenderTarget(target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    output.renderToScreen = true;
    // On the screen, it reads the target and writes no buffer of its own.
    output.render(r, target, target, 0, false);
  } finally {
    output.dispose();
    target.dispose();
  }
}

function metricsOf(row: CatalogRow, object: Object3D): Metrics {
  const index = new Set<string>();
  let draws = 0;
  object.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; isMesh?: boolean; isLine?: boolean; isPoints?: boolean };
    if (!holder.geometry || !(holder.isMesh || holder.isLine || holder.isPoints)) return;
    draws += Math.max(1, holder.geometry.groups.length);
    const array = holder.geometry.index?.array;
    index.add(array ? array.constructor.name.replace('Array', '') : 'none');
  });
  let size: [number, number, number] = [0, 0, 0];
  const box = new Box3().setFromObject(object);
  if (!box.isEmpty()) { const s = box.getSize(new Vector3()); size = [s.x, s.y, s.z]; }
  return {
    id: row.id, triangles: row.triangles, vertices: row.vertices, index: [...index].join(' + ') || 'none', geometryBytes: row.geometryBytes,
    bytesPerVertex: row.bytesPerVertex, attributes: row.attributes, materials: row.materials, draws, levels: row.levels.map((l) => ({ triangles: l.triangles, vertices: l.vertices })),
    hidden: row.hiddenTriangles, solids: row.solids, size, pieces: row.pieces.map((p) => ({ label: p.label, triangles: p.triangles, vertices: p.vertices })),
  };
}

/** The whole object in view, or only `crop` metres round its centre (a road layout's junction). */
function framingOf(object: Object3D, crop: number | null, at: readonly [number, number, number] | null = null): Framing {
  const box = new Box3().setFromObject(object);
  const centre = at ? new Vector3(...at) : box.getCenter(new Vector3()), size = box.getSize(new Vector3());
  const radius = crop ?? Math.max(size.length() / 2, 0.05);
  // The whole bounding sphere inside the view, a little room round it.
  const distance = (radius / Math.sin((FOV * Math.PI) / 360)) * 1.08;
  // Below the object by a hundredth of its size, never in its plane: a flat object (a road) would fight with a floor at its own height.
  return { centre: [centre.x, centre.y, centre.z], distance, floor: box.min.y - Math.max(0.01, radius * 0.02), long: size.x >= size.z ? 'x' : 'z' };
}

function cameraFor(framing: Framing, view: (typeof VIEWS)[number]): PerspectiveCamera {
  const camera = new PerspectiveCamera(FOV, 1, framing.distance / 200, framing.distance * 4);
  const centre = new Vector3(...framing.centre);
  // The side view of an object long along z turned a quarter, so it still looks across its length.
  const dir = view.name === 'side' && framing.long === 'z' ? new Vector3(view.dir[2], view.dir[1], view.dir[0]) : new Vector3(...view.dir);
  camera.position.copy(centre).addScaledVector(dir.normalize(), framing.distance);
  camera.up.set(...view.up);
  camera.lookAt(centre);
  return camera;
}

/** The hidden-line wireframe of an object: its surfaces in white pushed back a little and every triangle's edges over them, so an edge behind a
 *  surface is hidden (as `run.ts` catalogueSheet does); an instanced mesh with all its copies. */
function wireScene(object: Object3D): { scene: Scene; dispose: () => void } {
  const scene = new Scene();
  scene.background = new Color(0xffffff);
  object.updateMatrixWorld(true);
  const fill = new MeshBasicMaterial({ color: 0xf7f8fa, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const edge = new MeshBasicMaterial({ color: 0x1b2a3a, wireframe: true });
  const line = new LineBasicMaterial({ color: 0x1b2a3a });
  object.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; isMesh?: boolean; isInstancedMesh?: boolean; isLine?: boolean };
    const g = holder.geometry;
    if (!g) return;
    const copies: Object3D[] = [];
    if (holder.isInstancedMesh) {
      const source = o as InstancedMesh;
      for (const material of [fill, edge]) {
        const copy = new InstancedMesh(g, material, source.count);
        copy.instanceMatrix = source.instanceMatrix;
        copy.frustumCulled = false;
        copies.push(copy);
      }
    } else if (holder.isMesh) copies.push(new Mesh(g, fill), new Mesh(g, edge));
    else if (holder.isLine) copies.push(new LineSegments(g, line));
    for (const copy of copies) { copy.matrix.copy(o.matrixWorld); copy.matrixAutoUpdate = false; copy.frustumCulled = false; scene.add(copy); }
  });
  return { scene, dispose: () => { fill.dispose(); edge.dispose(); line.dispose(); } };
}

/** The object drawn as the sheet's renders draw it: the catalogue's lights, a floor under it. */
function shadedScene(object: Object3D, framing: Framing): { scene: Scene; dispose: () => void } {
  const scene = new Scene();
  scene.background = new Color(0xe9edf1);
  const sun = new DirectionalLight(0xffffff, 2.6);
  sun.position.set(-1.5, 3, 2);
  const floor = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ color: 0xd8d4cc }));
  floor.scale.setScalar(framing.distance * 8);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(framing.centre[0], framing.floor, framing.centre[2]);
  scene.add(new HemisphereLight(0xf4f7ff, 0x8a7f72, 1.4), sun, floor, object);
  return { scene, dispose: () => { scene.remove(object); floor.geometry.dispose(); (floor.material as MeshStandardMaterial).dispose(); } };
}

async function bitmapOf(base64: string): Promise<ImageBitmap> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

const toBase64 = (bytes: Uint8Array): string => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const soupToBase64 = (soup: Float32Array): string => toBase64(new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength));
const soupFromBase64 = (text: string): Float32Array => new Float32Array(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer);

/** The two columns of the four views: rendered, and the hidden-line wireframe. */
async function drawBlock(object: Object3D, framing: Framing, panel: number): Promise<string> {
  const r = renderer(panel);
  const page = document.createElement('canvas');
  page.width = panel * 2 + PAD; page.height = panel * VIEWS.length + PAD * (VIEWS.length - 1);
  const g = page.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
  const wire = wireScene(object);
  const shaded = shadedScene(object, framing);
  try {
    for (const [k, view] of VIEWS.entries()) {
      const camera = cameraFor(framing, view);
      r.toneMapping = ACESFilmicToneMapping;
      renderShaded(r, shaded.scene, camera);
      g.drawImage(await createImageBitmap(r.domElement), 0, k * (panel + PAD));
      r.toneMapping = NoToneMapping;
      r.render(wire.scene, camera);
      g.drawImage(await createImageBitmap(r.domElement), panel + PAD, k * (panel + PAD));
      g.fillStyle = 'rgba(20,30,40,0.75)'; g.font = '13px Segoe UI, sans-serif';
      g.fillText(view.name, 8, k * (panel + PAD) + 18);
    }
  } finally {
    shaded.dispose(); wire.dispose();
  }
  return page.toDataURL('image/png').split(',')[1]!;
}

/** The views the worst point's close-up is drawn from (`drawDetail`). */
const DETAIL_VIEWS = [VIEWS[0]!, VIEWS[3]!];

/** A soup drawn lit with its triangles' edges over it, the edges behind a surface hidden: what the close-up shows of before and after alike. */
function detailScene(soup: Float32Array): { scene: Scene; dispose: () => void } {
  const scene = new Scene();
  scene.background = new Color(0xffffff);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(soup, 3));
  geometry.computeVertexNormals();
  const fill = new MeshStandardMaterial({ color: 0xb9c2cc, side: DoubleSide, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const edge = new MeshBasicMaterial({ color: 0x1b2a3a, wireframe: true });
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(-1.5, 3, 2);
  for (const material of [fill, edge]) { const mesh = new Mesh(geometry, material); mesh.frustumCulled = false; scene.add(mesh); }
  scene.add(new HemisphereLight(0xf4f7ff, 0x8a7f72, 1.2), sun);
  return { scene, dispose: () => { geometry.dispose(); fill.dispose(); edge.dispose(); } };
}

/** The close-up of the point the surface moved most (`SurfaceError.at`), before and after, from three-quarter and above: one row of four panels. */
async function drawDetail(before: Float32Array, after: Float32Array, at: readonly [number, number, number], radius: number, panel: number): Promise<ImageBitmap> {
  const r = renderer(panel);
  const page = document.createElement('canvas');
  page.width = panel * 4 + PAD * 3; page.height = panel;
  const g = page.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
  const framing: Framing = { centre: at, distance: (radius / Math.sin((FOV * Math.PI) / 360)) * 1.08, floor: at[1], long: 'x' };
  r.toneMapping = NoToneMapping;
  for (const [s, soup] of [before, after].entries()) {
    const detail = detailScene(soup);
    try {
      for (const [k, view] of DETAIL_VIEWS.entries()) {
        r.render(detail.scene, cameraFor(framing, view));
        const x = (s * 2 + k) * (panel + PAD);
        g.drawImage(await createImageBitmap(r.domElement), x, 0);
        g.fillStyle = 'rgba(20,30,40,0.8)'; g.font = '13px Segoe UI, sans-serif';
        g.fillText(`${s === 0 ? 'before' : 'after'} · ${view.name}`, x + 8, 18);
      }
    } finally {
      detail.dispose();
    }
  }
  // The point itself, in the middle of every panel.
  g.strokeStyle = '#d0342c'; g.lineWidth = 2;
  for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(k * (panel + PAD) + panel / 2, panel / 2, 9, 0, Math.PI * 2); g.stroke(); }
  return createImageBitmap(page);
}

/** Each view's silhouette of a soup (both faces): the pixels it covers. */
function silhouettes(soup: Float32Array, framing: Framing, size: number): Uint8Array[] {
  const r = renderer(size);
  const target = new WebGLRenderTarget(size, size);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(soup, 3));
  const material = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide });
  const scene = new Scene();
  scene.background = new Color(0x000000);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const out: Uint8Array[] = [];
  r.toneMapping = NoToneMapping;
  for (const view of VIEWS) {
    r.setRenderTarget(target);
    r.render(scene, cameraFor(framing, view));
    const pixels = new Uint8Array(size * size * 4);
    r.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    const mask = new Uint8Array(size * size);
    for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4]! > 127 ? 1 : 0;
    out.push(mask);
  }
  r.setRenderTarget(null);
  target.dispose(); geometry.dispose(); material.dispose();
  return out;
}

function overlapOf(a: readonly Uint8Array[], b: readonly Uint8Array[]): number[] {
  return a.map((mask, k) => {
    let both = 0, either = 0;
    const other = b[k]!;
    for (let i = 0; i < mask.length; i++) { both += mask[i]! & other[i]!; either += mask[i]! | other[i]!; }
    return either ? both / either : 1;
  });
}

/** Each coarser level's distance from its finest level, the largest over the pieces that have one. */
function levelErrors(pieces: readonly PieceSpec[]): number[] {
  const out: number[] = [];
  for (const piece of pieces) {
    if (!piece.levels?.length) continue;
    const finest = geometrySoup(piece.geometry);
    piece.levels.forEach((level, k) => { const e = surfaceError(finest, geometrySoup(level)); out[k] = Math.max(out[k] ?? 0, e?.max ?? 0); });
  }
  return out;
}

const n = (v: number): string => v.toLocaleString('en');
const change = (a: number, b: number): string => (a === 0 ? '' : a === b ? 'same' : `${b < a ? '−' : '+'}${Math.abs(Math.round((1 - b / a) * 1000) / 10)} %`);
const mm = (metres: number): string => (metres < 1 ? `${(metres * 1000).toFixed(1)} mm` : `${metres.toFixed(3)} m`);

/** The whole sheet: the title, the four columns (before rendered, before wireframe, after rendered, after wireframe), the measures side by side. */
async function drawSheet(key: string, before: Before, after: { block: string; metrics: Metrics }, error: SurfaceError | null, overlap: readonly number[],
  afterLevels: readonly number[], beforeLevels: readonly number[], distance: number, panel: number, detail: { image: ImageBitmap; radius: number } | null): Promise<string> {
  const left = await bitmapOf(before.block), right = await bitmapOf(after.block);
  const top = 92, lineHeight = 21;
  const detailRoom = detail ? panel + 40 : 0;
  const b = before.metrics, a = after.metrics;
  const rows: [string, string, string, string][] = [
    ['Triangles', n(b.triangles), n(a.triangles), change(b.triangles, a.triangles)],
    ['Vertices', n(b.vertices), n(a.vertices), change(b.vertices, a.vertices)],
    ['Index', b.index, a.index, ''],
    ['Geometry bytes', n(b.geometryBytes), n(a.geometryBytes), change(b.geometryBytes, a.geometryBytes)],
    ['Bytes per vertex', n(b.bytesPerVertex), n(a.bytesPerVertex), change(b.bytesPerVertex, a.bytesPerVertex)],
    ['Draw calls', n(b.draws), n(a.draws), change(b.draws, a.draws)],
    ['Levels of detail (triangles)', b.levels.map((l, i) => `L${i} ${n(l.triangles)}`).join(' · '), a.levels.map((l, i) => `L${i} ${n(l.triangles)}`).join(' · '), ''],
    ['Level error from L0', beforeLevels.map((e, i) => `L${i + 1} ${mm(e)}`).join(' · ') || '—', afterLevels.map((e, i) => `L${i + 1} ${mm(e)}`).join(' · ') || '—', ''],
    ['Hidden triangles', b.hidden === null ? 'n/a' : n(b.hidden), a.hidden === null ? 'n/a' : n(a.hidden), ''],
    ['Solids', b.solids || '—', a.solids || '—', ''],
    ['Size (m)', b.size.map((v) => v.toFixed(2)).join(' × '), a.size.map((v) => v.toFixed(2)).join(' × '), ''],
  ];
  const textRows = rows.length + 5;
  const width = panel * 4 + PAD * 5, height = top + panel * VIEWS.length + PAD * (VIEWS.length - 1) + PAD * 2 + textRows * lineHeight + 40 + detailRoom;
  const page = document.createElement('canvas');
  page.width = width; page.height = height;
  const g = page.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, height);
  g.fillStyle = '#141e28'; g.font = 'bold 20px Segoe UI, sans-serif';
  g.fillText(key, PAD, 30);
  g.font = '15px Segoe UI, sans-serif';
  const heads = ['Before · rendered', 'Before · wireframe (hidden edges removed)', 'After · rendered', 'After · wireframe (hidden edges removed)'];
  heads.forEach((h, i) => g.fillText(h, PAD + i * (panel + PAD), top - 12));
  g.drawImage(left, PAD, top);
  g.drawImage(right, PAD * 3 + panel * 2, top);
  // A rule between before and after.
  g.fillStyle = '#c8ccd2'; g.fillRect(PAD * 2.5 + panel * 2 - 1, top, 2, panel * VIEWS.length + PAD * (VIEWS.length - 1));
  g.fillStyle = '#141e28';
  let y = top + panel * VIEWS.length + PAD * (VIEWS.length - 1) + PAD * 2 + 16;
  const columns = [PAD, PAD + 260, PAD + 260 + (width - 260 - PAD * 2 - 110) / 2, width - PAD - 100];
  g.font = 'bold 14px Segoe UI, sans-serif';
  ['Measure', 'Before', 'After', 'Change'].forEach((h, i) => g.fillText(h, columns[i]!, y));
  g.font = '14px Segoe UI, sans-serif';
  const clip = (text: string, room: number): string => { let t = text; while (t.length > 3 && g.measureText(t).width > room) t = `${t.slice(0, -2)}…`; return t; };
  for (const row of rows) {
    y += lineHeight;
    row.forEach((cell, i) => g.fillText(clip(cell, (columns[i + 1] ?? width) - columns[i]! - 10), columns[i]!, y));
  }
  y += lineHeight;
  g.fillText(clip(`Attributes before: ${b.attributes}`, width - PAD * 2), PAD, y); y += lineHeight;
  g.fillText(clip(`Attributes after: ${a.attributes}`, width - PAD * 2), PAD, y); y += lineHeight;
  const px = (metres: number): string => (metres / metresPerPixel(distance)).toFixed(2);
  g.font = 'bold 14px Segoe UI, sans-serif';
  g.fillText(error
    ? `Surface moved (two-sided Hausdorff): max ${mm(error.max)}, mean ${mm(error.mean)} — ${px(error.max)} px at ${distance.toFixed(1)} m (35° view, 1080 lines), at (${error.at.map((v) => v.toFixed(1)).join(', ')}) m`
    : 'Surface moved: not measurable (no triangles on one side)', PAD, y);
  y += lineHeight;
  g.fillText(`Silhouette overlap per view: ${overlap.map((o, i) => `${VIEWS[i]!.name} ${(o * 100).toFixed(2)} %`).join(' · ')}`, PAD, y);
  if (detail) {
    y += lineHeight + 8;
    g.fillText(`Where the surface moved most, ${detail.radius.toFixed(1)} m round the point (circled): before | after`, PAD, y);
    g.drawImage(detail.image, PAD, y + 10);
  }
  return page.toDataURL('image/png').split(',')[1]!;
}

/** One object captured: its two columns of views, its measures, its triangles; after a change, measured against what it was and its sheet drawn. */
export async function optimizationCapture(id: string, panel: number, before: Before | null, distance: number | null, crop: number | null = null, centre: readonly [number, number, number] | null = null): Promise<Capture> {
  const entry = catalogueEntry(id);
  if (!entry) throw new Error(`no object "${id}"`);
  const { row, object, pieces } = entry;
  const metrics = metricsOf(row, object);
  const framing = !centre && before?.framing ? before.framing : framingOf(object, crop, centre);
  const soup = triangleSoup(object);
  const block = await drawBlock(object, framing, panel);
  const levels = levelErrors(pieces);
  const at = distance ?? framing.distance;
  if (!before) return { key: stableKey(id), metrics, framing, block, soup: soupToBase64(soup), levelErrors: levels, distance: at };
  const old = soupFromBase64(before.soup);
  const error = surfaceError(old, soup);
  const overlap = overlapOf(silhouettes(old, framing, 256), silhouettes(soup, framing, 256));
  // The close-up wide enough to show what is round the point, and the gap itself many pixels across.
  const radius = error ? Math.max(1.5, error.max * 25) : 0;
  const detail = error && error.max > 0 ? { image: await drawDetail(old, soup, error.at, radius, panel), radius } : null;
  const sheet = await drawSheet(stableKey(id), before, { block, metrics }, error, overlap, levels, before.levelErrors, at, panel, detail);
  return { key: stableKey(id), metrics, framing, block, soup: soupToBase64(soup), sheet, error, overlap, levelErrors: levels, distance: at };
}
