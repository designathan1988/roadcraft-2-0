import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BufferGeometry, MeshStandardMaterial } from 'three';

import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { type BuildingChunk, emitChunk } from '@render/buildings/buildingMesh';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';

/** THE BUILDINGS DRAW WHAT HEAD db9da0c7 DREW: the hidden faces left out, nothing seen moved, shrunk, dropped or repainted.
 *  `buildingsVisibleSame.head.json` holds what HEAD's own code made (written by this file's `measure`, run at db9da0c7): each part model's
 *  box and triangles, and of the house, the apartments and the tower (at their detail, from afar and cut open at levels 0 and 1) the parts
 *  put, each finish's box and every shell triangle. A triangle is its three corners to 0.1 mm, sorted, hashed (FNV-1a 32).
 *  TO MAKE IT AGAIN: every run writes the measures of the code at hand to `<os tmpdir>/buildingsVisibleSame.now.json` (`NOW_OUT`). In a
 *  checkout of the commit the golden is to hold (`git worktree add --detach <dir> <commit>`), copy this file to its tests/render, run
 *  `npx vitest run tests/render/buildingsVisibleSame.spec.ts` there (the comparisons fail there for want of the golden: the measures are
 *  written all the same) and copy that file here as `buildingsVisibleSame.head.json`. */

type Box = [number, number, number, number, number, number];
interface Measured {
  partKinds: string[];
  kit: Record<string, { box: Box; triangles: string }>;
  furniture: Record<string, string>;
  views: Record<string, { parts: Record<string, number>; finishes: Record<string, Box>; shell: string }>;
}

/** 0.1 mm steps; -0 as 0 (a box's side at the origin is either). */
const r4 = (v: number): number => Math.round(v * 1e4) + 0;

/** FNV-1a over the 9 corners' coordinates (0.1 mm), the corners sorted so a triangle hashes the same however it is wound or started. */
function triangleHash(c: readonly number[]): number {
  const corners = [0, 1, 2].map((k) => [r4(c[3 * k]!), r4(c[3 * k + 1]!), r4(c[3 * k + 2]!)] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  let h = 0x811c9dc5;
  for (const p of corners) {
    for (const v of p) {
      let x = v | 0;
      for (let k = 0; k < 4; k++) { h ^= x & 0xff; h = Math.imul(h, 0x01000193) >>> 0; x >>= 8; }
    }
  }
  return h >>> 0;
}

/** Hashes as a sorted list, packed (base64 of little-endian u32). */
const pack = (hashes: number[]): string => Buffer.from(Uint32Array.from(hashes.sort((a, b) => a - b)).buffer).toString('base64');
const unpack = (s: string): number[] => { const b = Buffer.from(s, 'base64'); return Array.from(new Uint32Array(b.buffer, b.byteOffset, b.length / 4)); };

function geometryTriangles(g: BufferGeometry): number[] {
  const p = g.getAttribute('position'), out: number[] = [];
  const n = g.index ? g.index.count : p.count;
  for (let i = 0; i < n; i += 3) {
    const c: number[] = [];
    for (let k = 0; k < 3; k++) { const v = g.index ? g.index.getX(i + k) : i + k; c.push(p.getX(v), p.getY(v), p.getZ(v)); }
    out.push(triangleHash(c));
  }
  return out;
}

function boxOf(values: ArrayLike<number>, stride = 3): Box {
  const b: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i += stride) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k]!, values[i + k]!); b[k + 3] = Math.max(b[k + 3]!, values[i + k]!); }
  return b.map(r4) as Box;
}

const PRESETS = ['house', 'apartments', 'tower'] as const;

/** What the code makes: the measures `buildingsVisibleSame.head.json` holds of HEAD. */
function measure(): Measured {
  const kit = createBuildingKit();
  const furniture = kit.furniture().geometry;
  const out: Measured = { partKinds: [...PART_KINDS], kit: {}, furniture: {}, views: {} };
  for (const kind of PART_KINDS) {
    const g = kit.geometry[kind];
    out.kit[kind] = { box: boxOf(g.getAttribute('position').array), triangles: pack(geometryTriangles(g)) };
  }
  for (const [kind, g] of Object.entries(furniture)) out.furniture[kind] = pack(geometryTriangles(g));
  const view = (chunk: BuildingChunk): Measured['views'][string] => {
    const parts: Record<string, number> = {};
    for (const kind of PART_KINDS) if (chunk.parts[kind]?.count) parts[kind] = chunk.parts[kind].count;
    const finishes: Record<string, Box> = {};
    const shell: number[] = [];
    for (const [finish, s] of Object.entries(chunk.shells)) {
      finishes[finish] = boxOf(s!.position);
      for (let t = 0; t < s!.index.length; t += 3) {
        const c: number[] = [];
        for (let k = 0; k < 3; k++) { const v = s!.index[t + k]! * 3; c.push(s!.position[v]!, s!.position[v + 1]!, s!.position[v + 2]!); }
        shell.push(triangleHash(c));
      }
    }
    return { parts, finishes, shell: pack(shell) };
  };
  for (const key of PRESETS) {
    const i = BLUEPRINTS.findIndex((bp) => bp.key === key);
    const b = { ...JSON.parse(JSON.stringify(BLUEPRINTS[i]!.body)), id: i + 1, x: 0, y: 0, rotation: 0.3 } as Building;
    out.views[`${key}/near`] = view(emitChunk(b, () => 0));
    out.views[`${key}/far`] = view(emitChunk(b, () => 0, undefined, undefined, undefined, true));
    for (const cut of [0, 1]) out.views[`${key}/cut${cut}`] = view(emitChunk({ ...b, cutaway: cut, cutView: { x: 0.6, y: 0.8 } } as Building, () => 0));
  }
  kit.dispose();
  return out;
}

/** The members of `now` not in `head`, as multisets: what was added or moved. */
function notIn(now: number[], head: number[]): number {
  const left = new Map<number, number>();
  for (const h of head) left.set(h, (left.get(h) ?? 0) + 1);
  let extra = 0;
  for (const h of now) { const n = left.get(h) ?? 0; if (n > 0) left.set(h, n - 1); else extra++; }
  return extra;
}

const GOLDEN = 'tests/render/buildingsVisibleSame.head.json';
/** Where each run puts the measures of the code at hand (see the head of this file). */
const NOW_OUT = join(tmpdir(), 'buildingsVisibleSame.now.json');
/** The code at hand, measured once a run. */
let measuredNow: Measured | null = null;
const nowMeasured = (): Measured => (measuredNow ??= measure());

/** The faces left out, by model: the balcony railing's side rails' ends on the wall (4), the condenser's braces' upper ends in its arms
 *  (4), the pot's body top and soil under the rim's top (28), the table post's ends in its foot and under its top (16), the dish's arm
 *  and mount backs on the wall (4), a bicycle triangle inside another part (2); the furniture's faces inside a closed solid. */
const LEFT_OUT: Readonly<Record<string, number>> = { railing: 4, acUnit: 4, pot: 28, table: 16, dish: 4, bike: 2 };

describe('the buildings as drawn now', () => {
  it('are measured, their measures written for a golden to be made of them', () => {
    const now = nowMeasured();
    writeFileSync(NOW_OUT, JSON.stringify(now));
    expect(Object.keys(now.views)).toHaveLength(PRESETS.length * 4);
  });
});

describe('the buildings draw what HEAD drew, its hidden faces left out', () => {
  let HEAD_: Measured;
  let now: Measured;
  beforeAll(() => {
    HEAD_ = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Measured;
    now = nowMeasured();
  });

  it('has the same part kinds (no kind added to carry a part in another look)', () => {
    expect(now.partKinds).toEqual(HEAD_.partKinds);
  });

  it('keeps every part model the size it was, its triangles HEAD\'s but the hidden ones', () => {
    for (const kind of HEAD_.partKinds) {
      expect(now.kit[kind]!.box, kind).toEqual(HEAD_.kit[kind]!.box);
      const mine = unpack(now.kit[kind]!.triangles), theirs = unpack(HEAD_.kit[kind]!.triangles);
      expect(notIn(mine, theirs), `${kind}: triangles not in HEAD's model`).toBe(0);
      expect(theirs.length - mine.length, `${kind}: triangles left out`).toBe(LEFT_OUT[kind] ?? 0);
    }
  });

  it('keeps every piece of furniture HEAD\'s triangles but the buried ones', () => {
    for (const kind of Object.keys(HEAD_.furniture)) {
      const mine = unpack(now.furniture[kind]!), theirs = unpack(HEAD_.furniture[kind]!);
      expect(notIn(mine, theirs), `${kind}: triangles not in HEAD's model`).toBe(0);
    }
  });

  it('puts every part HEAD put, of the same kind (a canopy\'s drip in concrete, a gourmet\'s in the fins\' paint)', () => {
    for (const key of Object.keys(HEAD_.views)) expect(now.views[key]!.parts, key).toEqual(HEAD_.views[key]!.parts);
  });

  it('lays every shell triangle where HEAD laid it, each finish over the same box', () => {
    for (const key of Object.keys(HEAD_.views)) {
      expect(now.views[key]!.finishes, key).toEqual(HEAD_.views[key]!.finishes);
      expect(notIn(unpack(now.views[key]!.shell), unpack(HEAD_.views[key]!.shell)), `${key}: shell triangles not in HEAD's`).toBe(0);
    }
  });

  it('draws a balcony railing\'s front rail and bottom rail to its side rails\' middles, as HEAD, and a roof railing with its five posts', () => {
    const kit = createBuildingKit();
    const faceSpan = (g: BufferGeometry, keep: (x: number, y: number, z: number) => boolean): [number, number] => {
      const p = g.getAttribute('position');
      let lo = Infinity, hi = -Infinity;
      for (let v = 0; v < p.count; v++) if (keep(p.getX(v), p.getY(v), p.getZ(v))) { lo = Math.min(lo, p.getX(v)); hi = Math.max(hi, p.getX(v)); }
      return [r4(lo), r4(hi)];
    };
    // The front rail's front face (z 1.025, y 0.94 to 1), the bottom rail's (z 1.015, y 0.10 to 0.14).
    expect(faceSpan(kit.geometry.railing, (_, y, z) => Math.abs(z - 1.025) < 1e-6 && y > 0.93)).toEqual([r4(-0.5), r4(0.5)]);
    expect(faceSpan(kit.geometry.railing, (_, y, z) => Math.abs(z - 1.015) < 1e-6 && y < 0.15)).toEqual([r4(-0.5), r4(0.5)]);
    // Every post's two faces across the run, at -0.5, -0.25, 0, 0.25 and 0.5, each 2 cm wide.
    const p = kit.geometry.roofRailing.getAttribute('position');
    const xs = new Set<number>();
    for (let v = 0; v < p.count; v++) if (p.getY(v) < 0.04) xs.add(r4(p.getX(v)));
    expect([...xs].sort((a, b) => a - b)).toEqual([-0.51, -0.49, -0.26, -0.24, -0.01, 0.01, 0.24, 0.26, 0.49, 0.51].map(r4));
    // The concrete parts in the slab's concrete, the fins in the trim's paint (coloured per instance).
    const concrete = kit.material.concrete as MeshStandardMaterial, fin = kit.material.fin as MeshStandardMaterial;
    expect([concrete.color.getHex(), concrete.roughness]).toEqual([0xcfc9bd, 0.82]);
    expect([fin.color.getHex(), fin.roughness]).toEqual([0xffffff, 0.7]);
    kit.dispose();
  });
});
