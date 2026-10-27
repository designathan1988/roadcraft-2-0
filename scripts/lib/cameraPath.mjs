// THE 10 KM CITY AND THE FIXED CAMERA PATH shared by the camera bench (`scripts/bench-camera.mjs`) and the code graph's runtime layer
// (`scripts/codegraph/runtime.mjs`): the same city of a fixed seed, opened through `measureCity.mjs` in a visible Chrome window at one size,
// and the same path, driven through the camera rig's own API (`__roadcraft.setView`) one animation frame at a time, never by gestures, so
// two runs and two checkouts move the camera identically.
//
// The 10 km city: the large city of seed 7 over a radius of 8 850 m (`largeCity.ts`; ~249 000 buildings, the acceptance city of
// `scripts/look/final-200k.json`). Generated on the spot the first time; the game keeps a generated city in its derived store (IndexedDB) by the
// generator's code hash, so a persistent profile (`node_modules/.cache/bench-profile`) reads it back on later runs instead of making it again.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCity } from './measureCity.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const VIEWPORT = { width: 1920, height: 1080 };
/** The cities a run can open: the 10 km city, and the small city (1.6 km) to tell what grows with the map from what grows with the view. */
export const CITIES = {
  large: { label: '10 km city (large, seed 7, radius 8850 m)', ask: { seed: 7, size: 'large', radiusMetres: 8850 } },
  small: { label: 'small city (seed 7)', ask: { seed: 7, size: 'small' } },
};

/** The path's segments, in order: each a name, a length in seconds, and the view at a share `t` of it (0..1) from the city's frame `c`
 *  (its centre, the zoom that fits it, the default bearing and tilt). Zooms are multiples of the fitting zoom: x1 the whole city, x8 a
 *  district, x48 a street. Pans run along the bearing's cross axis, so the view sweeps new ground for the whole segment. */
export const PATH = [
  { name: 'district-pan', seconds: 8, view: (c, t) => ({ ...c.along(-0.08 + 0.16 * t), zoom: c.fit * 8, azimuth: c.azimuth, elevation: c.elevation }) },
  { name: 'street-pan', seconds: 8, view: (c, t) => ({ ...c.along(-0.012 + 0.024 * t), zoom: c.fit * 48, azimuth: c.azimuth, elevation: 0.55 }) },
  { name: 'zoom-in', seconds: 3, view: (c, t) => ({ ...c.along(0), zoom: c.fit * 8 * 6 ** ease(t), azimuth: c.azimuth, elevation: c.elevation }) },
  { name: 'zoom-in-settle', seconds: 4, view: (c) => ({ ...c.along(0), zoom: c.fit * 48, azimuth: c.azimuth, elevation: c.elevation }) },
  { name: 'zoom-out', seconds: 3, view: (c, t) => ({ ...c.along(0), zoom: c.fit * 48 / 6 ** ease(t), azimuth: c.azimuth, elevation: c.elevation }) },
  { name: 'zoom-out-settle', seconds: 4, view: (c) => ({ ...c.along(0), zoom: c.fit * 8, azimuth: c.azimuth, elevation: c.elevation }) },
  { name: 'orbit', seconds: 8, view: (c, t) => ({ ...c.along(0), zoom: c.fit * 8, azimuth: c.azimuth + Math.PI * t, elevation: c.elevation }) },
  { name: 'whole-map', seconds: 3, view: (c, t) => ({ ...c.along(0), zoom: c.fit * 8 / 8 ** ease(t), azimuth: c.azimuth + Math.PI, elevation: c.elevation }) },
  { name: 'whole-map-settle', seconds: 4, view: (c) => ({ ...c.along(0), zoom: c.fit, azimuth: c.azimuth + Math.PI, elevation: c.elevation }) },
];
/** The segments where the camera moves without a zoom: the drag the acceptance's pan and orbit numbers are read on. */
export const DRAG_SEGMENTS = ['district-pan', 'street-pan', 'orbit'];
/** Smooth start and stop of a zoom (also defined in the page: the views run there, `goTo`, `runSegment`). */
function ease(t) { return t * t * (3 - 2 * t); }

/** A Chrome window with the city open, the game in its measure mode (the simulation's clock held: the same sun and the same traffic each
 *  run), the camera at the path's first view and the scene settled there. `init`: a script for the page before the game's code. */
export async function openPathCity({ city = 'large', init = null, headless = false, beforeGoto = null } = {}) {
  const chosen = CITIES[city];
  if (!chosen) throw new Error(`city: ${Object.keys(CITIES).join(' | ')}`);
  const { browser, page } = await openCity({
    ...VIEWPORT, init, headless, beforeGoto, city: false, settle: false, profile: join(ROOT, 'node_modules', '.cache', 'bench-profile'),
  });
  const t0 = Date.now();
  await page.evaluate((ask) => { performance.clearMarks(); window.__cityAt = undefined; window.__roadcraft.generateCity(ask); }, chosen.ask);
  await page.waitForFunction(() => {
    const e = performance.getEntriesByName('city:applied')[0];
    if (e && window.__cityAt === undefined) window.__cityAt = e.startTime;
    return window.__cityAt !== undefined;
  }, null, { timeout: 1_800_000, polling: 500 });
  await page.waitForFunction(() => { const c = document.getElementById('loading-curtain'); return !!c && getComputedStyle(c).display === 'none'; }, null, { timeout: 900_000, polling: 500 });
  const openedS = (Date.now() - t0) / 1000;
  // The first-run dialogs, if any (`scripts/look/final-200k.json`).
  for (const name of ['Começar a construir', 'Continuar']) {
    const button = page.getByRole('button', { name });
    if (await button.count()) await button.first().click();
  }
  await page.evaluate(() => window.__roadcraft.measure(true));
  const frame = await page.evaluate(() => {
    const b = window.__roadcraft.bounds(), v = window.__roadcraft.view();
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, w: b.maxX - b.minX, fit: b.fitZoom, azimuth: v.azimuth, elevation: v.elevation };
  });
  await goTo(page, frame, PATH[0], 0);
  const settled = await page.evaluate(() => window.__measure.settle(4000, 180_000));
  return { browser, page, frame, openedS, settled, city: chosen.label };
}

/** The view of `segment` at share `t`, set at once (the path's start, a segment's first frame). */
export function goTo(page, frame, segment, t) {
  return page.evaluate(([f, src, share]) => {
    const view = viewOf(f, src, share);
    window.__roadcraft.setView(view);
    function viewOf(c, code, at) {
      const fn = new Function('c', 't', `const ease = (u) => u * u * (3 - 2 * u); return (${code})(c, t);`);
      const along = (s) => ({ x: c.x - Math.sin(c.azimuth) * s * c.w, y: c.y + Math.cos(c.azimuth) * s * c.w });
      return fn({ ...c, along }, at);
    }
  }, [frame, segment.view.toString(), t]);
}

/** Runs one segment in the page: every animation frame the view at the share of the segment's time gone (the page's clock), until it ends;
 *  every 100 ms whether the buildings' levels have all landed (`notLanded`), so a zoom's time to its final levels is read. Resolves with
 *  the page's start and end times (ms) and the landing samples. */
export function runSegment(page, frame, segment) {
  return page.evaluate(([f, code, seconds]) => new Promise((done) => {
    const fn = new Function('c', 't', `const ease = (u) => u * u * (3 - 2 * u); return (${code})(c, t);`);
    const along = (s) => ({ x: f.x - Math.sin(f.azimuth) * s * f.w, y: f.y + Math.cos(f.azimuth) * s * f.w });
    const c = { ...f, along };
    const handle = window.__roadcraft.scene();
    const landing = [];
    let start = null, lastSample = -Infinity;
    const step = (now) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / (seconds * 1000));
      window.__roadcraft.setView(fn(c, t));
      if (now - lastSample >= 100) {
        lastSample = now;
        landing.push([Math.round(now - start), handle.buildingLevels().notLanded ?? 0]);
      }
      if (t < 1) requestAnimationFrame(step);
      else done({ start, end: now, landing });
    };
    requestAnimationFrame(step);
  }), [frame, segment.view.toString(), segment.seconds]);
}

/** Installed in the page before the game's code (Playwright `addInitScript`): `window.__longTasks` the long tasks; `window.__glCount` keeps the bytes WebGL uploads (buffers and
 *  textures, each by the region it writes: a sub-range's own bytes, a texture region's width x height x depth x its texel's bytes) and the
 *  programs linked, so the bench's recorder (`main.ts` benchFrames) reads them at every frame's end. DO NOT count a sub-update by its source
 *  array's whole length: one row of a large array counted as the array read 18 GB of uploads in a move that sent ~28 MB/s (STATE, 2026-10-27). */
export function glCounter() {
  const count = { bytes: 0, bufferBytes: 0, textureBytes: 0, uploads: 0, programs: 0 };
  window.__glCount = count;
  // The long tasks too (> 50 ms on the main thread, https://w3c.github.io/longtasks/): start and length, read by the bench per segment.
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  } catch (error) { console.warn(`no long tasks observed: ${error.message}`); }
  const CHANNELS = { 0x1908: 4, 0x1907: 3, 0x8227: 2, 0x1903: 1, 0x8d99: 4, 0x8d98: 3, 0x8228: 2, 0x8d94: 1, 0x1902: 1, 0x84f9: 1, 0x1906: 1, 0x1909: 1, 0x190a: 2 };
  const TYPE = { 0x1401: 1, 0x1400: 1, 0x1403: 2, 0x1402: 2, 0x1405: 4, 0x1404: 4, 0x1406: 4, 0x140b: 2 };
  const PACKED = { 0x8363: 2, 0x8033: 2, 0x8034: 2, 0x84fa: 4, 0x8368: 4, 0x8c3b: 4, 0x8c3e: 4, 0x8dad: 8 };
  const texel = (format, type) => PACKED[type] ?? (CHANNELS[format] ?? 4) * (TYPE[type] ?? 1);
  const typed = (v) => v && typeof v.byteLength === 'number';
  const source = (v) => v && typeof v === 'object' && !typed(v) && (v.width ?? v.videoWidth ?? v.displayWidth);
  const dims = (v) => (v.videoWidth ?? v.displayWidth ?? v.width) * (v.videoHeight ?? v.displayHeight ?? v.height);
  const add = (kind, bytes) => { if (!(bytes > 0)) return; count.bytes += bytes; count[kind] += bytes; count.uploads++; };
  const bufferBytes = (data, srcOffset = 0, length = 0) => { const per = data.BYTES_PER_ELEMENT ?? 1; return length ? length * per : data.byteLength - srcOffset * per; };
  const wrap = (proto, name, measure) => {
    const original = proto[name];
    if (typeof original !== 'function') return;
    proto[name] = function (...a) { measure(a); return original.apply(this, a); };
  };
  for (const ctor of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!ctor) continue;
    const p = ctor.prototype;
    wrap(p, 'bufferData', (a) => { if (typed(a[1])) add('bufferBytes', bufferBytes(a[1], a[3] ?? 0, a[4] ?? 0)); });
    wrap(p, 'bufferSubData', (a) => { if (typed(a[2])) add('bufferBytes', bufferBytes(a[2], a[3] ?? 0, a[4] ?? 0)); });
    wrap(p, 'texImage2D', (a) => {
      if (a.length >= 8) { if (a[8] !== null && a[8] !== undefined) add('textureBytes', a[3] * a[4] * texel(a[6], a[7])); }
      else if (source(a[5])) add('textureBytes', dims(a[5]) * texel(a[3], a[4]));
    });
    wrap(p, 'texSubImage2D', (a) => {
      if (a.length >= 8 && typeof a[4] === 'number' && typeof a[5] === 'number' && !source(a[6])) add('textureBytes', a[4] * a[5] * texel(a[6], a[7]));
      else if (source(a[6])) add('textureBytes', dims(a[6]) * texel(a[4], a[5]));
    });
    wrap(p, 'texImage3D', (a) => { if (a[9] !== null && a[9] !== undefined) add('textureBytes', a[3] * a[4] * a[5] * texel(a[7], a[8])); });
    wrap(p, 'texSubImage3D', (a) => { add('textureBytes', a[5] * a[6] * a[7] * texel(a[8], a[9])); });
    wrap(p, 'compressedTexImage2D', (a) => { const d = a.findLast((v) => typed(v)); if (d) add('textureBytes', d.byteLength); });
    wrap(p, 'compressedTexSubImage2D', (a) => { const d = a.findLast((v) => typed(v)); if (d) add('textureBytes', d.byteLength); });
    wrap(p, 'linkProgram', () => { count.programs++; });
  }
}
