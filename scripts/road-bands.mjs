// THE ROADS' TRIANGLES BY BAND, read off the optimisation sheets' own files (`optimization-sheet.mjs`): each object's pieces by their label
// (`<stage>.json` metrics.pieces: verge, footway, kerb, asphalt...), and its upright faces from its triangle soup (`<stage>.tri`, nine floats a
// triangle, y up) split in two: the skirts that hang below the carriageway, and the step faces that stand on it (the kerb's face, a median's).
//
// `node scripts/road-bands.mjs <sheet folder> [--stage=before|after] [--match=<slug pattern>]`: a Markdown table on stdout.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const stage = flag('stage', 'after');
const match = new RegExp(flag('match', ''), 'i');
if (!folder) {
  console.error('usage: node scripts/road-bands.mjs <sheet folder> [--stage=before|after] [--match=<slug pattern>]');
  process.exit(2);
}

/** A face this near upright (its normal's y under this) is a wall, a skirt or a kerb's face. */
const UPRIGHT = 0.2;
/** A face reaching this far under the carriageway hangs below it: a skirt. */
const BELOW = 0.01;

/** The carriageway's height: the median height of the level faces, weighed by their area. */
function deckOf(soup) {
  const level = [];
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const n = normal(soup, t);
    if (Math.abs(n.y) < 0.9) continue;
    level.push({ y: (soup[t + 1] + soup[t + 4] + soup[t + 7]) / 3, w: n.area });
  }
  if (level.length === 0) return 0;
  level.sort((a, b) => a.y - b.y);
  const half = level.reduce((s, f) => s + f.w, 0) / 2;
  let sum = 0;
  for (const f of level) { sum += f.w; if (sum >= half) return f.y; }
  return level[level.length - 1].y;
}

function normal(s, t) {
  const ux = s[t + 3] - s[t], uy = s[t + 4] - s[t + 1], uz = s[t + 5] - s[t + 2];
  const vx = s[t + 6] - s[t], vy = s[t + 7] - s[t + 1], vz = s[t + 8] - s[t + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return { y: len > 0 ? ny / len : 0, area: len / 2 };
}

const lines = ['| Object | Total | Verge | Footway | Kerb | Asphalt | Median | Other | Skirts (below the carriageway) | Step faces (on it) |', '|---|---|---|---|---|---|---|---|---|---|'];
const cell = (b) => (b.triangles ? `${b.triangles} (${b.vertices} v)` : '0');
for (const slug of readdirSync(folder).sort()) {
  const json = join(folder, slug, `${stage}.json`), tri = join(folder, slug, `${stage}.tri`);
  if (!match.test(slug) || !existsSync(json) || !existsSync(tri)) continue;
  const record = JSON.parse(readFileSync(json, 'utf8'));
  const bands = { verge: { triangles: 0, vertices: 0 }, footway: { triangles: 0, vertices: 0 }, kerb: { triangles: 0, vertices: 0 }, asphalt: { triangles: 0, vertices: 0 }, median: { triangles: 0, vertices: 0 }, other: { triangles: 0, vertices: 0 } };
  for (const piece of record.metrics.pieces) {
    const label = piece.label;
    const band = label.startsWith('verge') ? 'verge' : label.startsWith('footway') ? 'footway' : label.startsWith('kerb') ? 'kerb'
      : label.startsWith('asphalt') ? 'asphalt' : label.startsWith('median') ? 'median' : 'other';
    bands[band].triangles += piece.triangles;
    bands[band].vertices += piece.vertices;
  }
  const buffer = readFileSync(tri);
  const soup = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const deck = deckOf(soup);
  let skirts = 0, steps = 0;
  for (let t = 0; t + 8 < soup.length; t += 9) {
    if (Math.abs(normal(soup, t).y) >= UPRIGHT) continue;
    const low = Math.min(soup[t + 1], soup[t + 4], soup[t + 7]);
    if (low < deck - BELOW) skirts++; else steps++;
  }
  lines.push(`| ${record.key} | ${record.metrics.triangles} (${record.metrics.vertices} v) | ${cell(bands.verge)} | ${cell(bands.footway)} | ${cell(bands.kerb)} | ${cell(bands.asphalt)} | ${cell(bands.median)} | ${cell(bands.other)} | ${skirts} | ${steps} |`);
}
console.log(lines.join('\n'));
