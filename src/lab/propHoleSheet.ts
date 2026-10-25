import {
  ACESFilmicToneMapping, AmbientLight, BackSide, Box3, type BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute, HemisphereLight, Mesh, MeshStandardMaterial,
  PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer, type Material,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { barrierModel } from '../render/barriers';
import { createSceneryKit } from '../render/scenery';
import { signalHeadModel } from '../render/signals';

/**
 * THE PROPS' FACE AUDIT (`scripts/prop-ladder-sheet.mjs holes`): every street prop's model drawn alone with its own material (one side, as the
 * game draws it), close, from eight sides, from below and from inside where it is hollow, over a magenta ground: wherever the magenta shows
 * through the model's outline a face is missing or turned away. A second row a prop: the same views with the material two-sided, so a face
 * turned the wrong way shows (present there, missing above). Its shadow's faces (three r186 casts a FrontSide material with its back faces):
 * a third row, the back faces alone, drawn as the shadow pass draws them.
 */

const PANEL = 220;
/** The views: eight sides 15 degrees up, then from below. */
const SIDES = Array.from({ length: 8 }, (_, k) => ({ azimuth: (k * Math.PI) / 4, elevation: (15 * Math.PI) / 180, label: `yaw ${k * 45}` }));
const BELOW = { azimuth: Math.PI / 6, elevation: -(60 * Math.PI) / 180, label: 'below' };

/** A hollow prop's inside: where the eye stands and what it looks at, model units (the phone's hood, open to +Z). */
interface Inside { readonly eye: readonly [number, number, number]; readonly at: readonly [number, number, number] }
/** A part of a tall prop looked at close (a lamp's head is a few pixels of a panel framing the whole 9 m column): the box the views frame. */
interface Focus { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }

/** One geometry of several, with the attributes every part has (position, normal, colour; white where a part has none, the lens). */
function together(parts: readonly BufferGeometry[]): BufferGeometry {
  const plain = parts.map((g) => {
    const c = g.index ? g.toNonIndexed() : g.clone();
    for (const name of Object.keys(c.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') c.deleteAttribute(name);
    if (!c.getAttribute('color')) c.setAttribute('color', new Float32BufferAttribute(new Float32Array(c.getAttribute('position').count * 3).fill(1), 3));
    return c;
  });
  const merged = mergeGeometries(plain);
  for (const g of plain) g.dispose();
  if (!merged) throw new Error('the parts could not be merged');
  return merged;
}

/**
 * A model's open edges, measured: its corners joined by place (a millimetre), every edge only one triangle has (a hole's rim or an end left
 * open), joined into rims by the corners they share; the rims all of whose corners lie on the ground or under it (y at most a millimetre:
 * a foot's open bottom on the footway), and each other rim's box, model units - where an opening is that the ground does not close.
 */
function openEdges(geometry: BufferGeometry): string {
  const position = geometry.getAttribute('position');
  const ids = new Map<string, number>(), corner: number[] = [], ys: number[] = [], xs: number[] = [], zs: number[] = [];
  for (let v = 0; v < position.count; v++) {
    const key = `${Math.round(position.getX(v) * 1000)},${Math.round(position.getY(v) * 1000)},${Math.round(position.getZ(v) * 1000)}`;
    let id = ids.get(key);
    if (id === undefined) { ids.set(key, id = xs.length); xs.push(position.getX(v)); ys.push(position.getY(v)); zs.push(position.getZ(v)); }
    corner.push(id);
  }
  const index = geometry.index;
  const at = (i: number): number => corner[index ? index.getX(i) : i]!;
  const triangles = (index ? index.count : position.count) / 3;
  const uses = new Map<string, number>();
  for (let t = 0; t < triangles; t++) {
    const a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
    if (a === b || b === c || a === c) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const open = [...uses].filter(([, n]) => n === 1).map(([key]) => key.split(',').map(Number) as [number, number]);
  // The rims: open edges joined by their shared corners.
  const parent = new Map<number, number>();
  const root = (v: number): number => { let r = v; while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!; return r; };
  for (const [p, q] of open) { if (!parent.has(p)) parent.set(p, p); if (!parent.has(q)) parent.set(q, q); parent.set(root(p), root(q)); }
  const rims = new Map<number, number[]>();
  for (const v of parent.keys()) { const r = root(v); const list = rims.get(r); if (list) list.push(v); else rims.set(r, [v]); }
  const grounded = [...rims.values()].filter((rim) => rim.every((v) => ys[v]! <= 0.001));
  const raised = [...rims.values()].filter((rim) => rim.some((v) => ys[v]! > 0.001));
  const box = (rim: number[]): string => {
    const f = (a: number[]): string => `${Math.min(...rim.map((v) => a[v]!)).toFixed(3)}..${Math.max(...rim.map((v) => a[v]!)).toFixed(3)}`;
    return `x ${f(xs)} y ${f(ys)} z ${f(zs)}`;
  };
  return `${open.length} open edges in ${rims.size} rims; ${grounded.length} rims on or under the ground (y <= 0.001)` +
    (raised.length ? `; ${raised.length} above it: ${raised.map(box).join(' | ')}` : '; none above it');
}

export async function propHoleAudit(only: readonly string[] = []): Promise<{ readonly png: string; readonly rows: readonly string[] }> {
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setPixelRatio(1);
  renderer.setSize(PANEL, PANEL, false);
  const kit = createSceneryKit();
  const lampHead = together([kit.furniture.lamp, kit.lampLens]);
  const signal = signalHeadModel('red');
  const all: { name: string; geometry: BufferGeometry; inside?: Inside; focus?: Focus }[] = [
    { name: 'lamp', geometry: kit.furniture.lamp },
    { name: 'lamp lens', geometry: kit.lampLens },
    { name: 'bin', geometry: kit.furniture.bin },
    { name: 'bench', geometry: kit.furniture.bench },
    { name: 'hydrant', geometry: kit.furniture.hydrant },
    { name: 'postbox', geometry: kit.furniture.postbox },
    // Under the hood, a person's eyes at the phone, looking up and into it.
    { name: 'phone', geometry: kit.furniture.phone, inside: { eye: [0, 1.45, 0.22], at: [0, 1.75, -0.2] } },
    { name: 'drain', geometry: kit.furniture.drain },
    { name: 'tree pit', geometry: kit.treePit },
    // The lamp's light, drawn with glow materials (`scenery.ts`): its faces looked at as the others'.
    { name: 'lamp pool', geometry: kit.pool },
    { name: 'lamp beam', geometry: kit.beam },
    // The traffic signal's head, its red lit (`signals.ts` signalHeadShapes), and every barrier 4 m long (`barriers.ts`).
    { name: 'signal head', geometry: signal },
    // The tall props' heads close: the lamp's arm, housing and lens together (the lens lies against the housing's underside, `propGeometry.ts`
    // lampLensGeometry), and the signal's arm end, housing, visors and lenses.
    { name: 'lamp head (with lens)', geometry: lampHead, focus: { min: [-0.3, 8.4, -0.4], max: [2.6, 9.4, 0.4] } },
    { name: 'signal housing', geometry: signal, focus: { min: [2.9, 4.6, -0.45], max: [4.1, 6.4, 0.45] } },
    ...(['fence', 'wall', 'hedge', 'guardrail', 'railing'] as const).map((kind) => ({ name: kind, geometry: barrierModel(kind, 4) })),
  ];
  const props = all.filter((p) => only.length === 0 || only.includes(p.name));
  const scene = new Scene();
  scene.background = new Color(0xff00ff);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  scene.add(new HemisphereLight(0xe6e4da, 0x6a6b4c, 0.8), new AmbientLight(0xdfe9f2, 0.2));
  const sun = new DirectionalLight(0xfff0cf, 3.2);
  sun.position.set(-1, 2, 1.2);
  scene.add(sun);
  const own = kit.props;
  const twoSided = own.clone();
  twoSided.side = DoubleSide;
  // The shadow pass's faces: the back ones alone, flat (three r186 `WebGLShadowMap` shadowSide: FrontSide -> BackSide).
  const shadowFaces = new MeshStandardMaterial({ color: 0x202020, side: BackSide, roughness: 1, metalness: 0 });
  const looks: { label: string; material: Material }[] = [
    { label: 'as drawn (one side)', material: own }, { label: 'two-sided', material: twoSided }, { label: 'shadow faces', material: shadowFaces },
  ];
  const columns = SIDES.length + 2;
  const page = document.createElement('canvas');
  page.width = 150 + columns * (PANEL + 4);
  page.height = props.length * looks.length * (PANEL + 4) + 24;
  const g = page.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
  g.fillStyle = '#000'; g.font = '14px sans-serif';
  [...SIDES, BELOW, { label: 'inside' }].forEach((v, c) => g.fillText(v.label, 150 + c * (PANEL + 4) + 4, 16));
  const rows: string[] = [];
  const magenta = (): number => {
    // Magenta pixels inside the panel's middle (the model's own box on the screen is not known here: the share of the whole panel).
    const pixels = new Uint8Array(PANEL * PANEL * 4);
    const gl = renderer.getContext();
    gl.readPixels(0, 0, PANEL, PANEL, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 240 && pixels[i + 1]! < 20 && pixels[i + 2]! > 240) n++;
    return n;
  };
  props.forEach((prop, p) => {
    prop.geometry.computeBoundingBox();
    const box = prop.focus ? new Box3(new Vector3(...prop.focus.min), new Vector3(...prop.focus.max)) : prop.geometry.boundingBox!;
    const centre = box.getCenter(new Vector3()), size = box.getSize(new Vector3()).length();
    const byLook: number[][] = [];
    looks.forEach((look, l) => {
      const row = p * looks.length + l;
      const y = 24 + row * (PANEL + 4);
      g.fillStyle = '#000';
      g.fillText(prop.name, 4, y + 20);
      g.fillText(look.label, 4, y + 40);
      const mesh = new Mesh(prop.geometry, look.material);
      scene.add(mesh);
      const counts: number[] = [];
      [...SIDES, BELOW].forEach((v, c) => {
        // Close: the model's box diagonal across most of the panel.
        const camera = new PerspectiveCamera(35, 1, size / 200, size * 20);
        const distance = (size * 0.62) / Math.tan((35 * Math.PI) / 360);
        camera.position.set(Math.sin(v.azimuth) * Math.cos(v.elevation), Math.sin(v.elevation), Math.cos(v.azimuth) * Math.cos(v.elevation)).multiplyScalar(distance).add(centre);
        camera.lookAt(centre);
        renderer.render(scene, camera);
        counts.push(magenta());
        g.drawImage(canvas, 150 + c * (PANEL + 4), y);
      });
      if (prop.inside) {
        const camera = new PerspectiveCamera(70, 1, 0.01, 50);
        camera.position.set(...prop.inside.eye);
        camera.lookAt(new Vector3(...prop.inside.at));
        renderer.render(scene, camera);
        counts.push(magenta());
        g.drawImage(canvas, 150 + (columns - 1) * (PANEL + 4), y);
      }
      rows.push(`${prop.name} ${look.label}: magenta pixels by view ${counts.join(' ')}`);
      byLook.push(counts);
      scene.remove(mesh);
    });
    // Seen through as drawn and not two-sided: a face missing on its drawn side (turned away, or none behind it).
    rows.push(`${prop.name} SEEN THROUGH (one-sided minus two-sided) by view: ${byLook[0]!.map((n, v) => n - byLook[1]![v]!).join(' ')}`);
    rows.push(`${prop.name} OPEN EDGES: ${openEdges(prop.geometry)}`);
  });
  lampHead.dispose();
  signal.dispose();
  twoSided.dispose();
  shadowFaces.dispose();
  pmrem.dispose();
  kit.dispose();
  renderer.dispose();
  return { png: page.toDataURL('image/png'), rows };
}
