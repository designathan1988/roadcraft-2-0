// The code graph's sample (tests/codegraph/codegraph.spec.ts): each function shows one thing the indexer must see.
import { type Camera, type DataTexture, type MeshBasicMaterial, type Scene, type WebGLRenderer } from 'three';

/** Not three's: a render of our own, which costs nothing on the GPU by itself. */
interface Painter { render(): void }

export function helper(): void {}
export function later(): void {}
export function deferredWork(): void {}

/** three's costly calls and needsUpdate writes, a guarded call, an unguarded one, and two stored callbacks. */
export function draw(r: WebGLRenderer, s: Scene, c: Camera, p: Painter, m: MeshBasicMaterial, t: DataTexture, on: boolean): void {
  r.render(s, c);
  p.render();
  r.compile(s, c);
  r.setRenderTarget(null);
  m.needsUpdate = true;
  t.needsUpdate = true;
  if (on) helper();
  later();
  setTimeout(() => deferredWork(), 0);
  void Promise.resolve().then(function thenWork() { deferredWork(); });
}

/** A call after an early return runs only under a condition. */
export function early(x: number): void {
  if (x > 1) return;
  helper();
}

/** A recursion entered from a root: ping and pong call each other in loops; the leaf allocates in a loop. */
export function entry(): void { ping(3); }
export function ping(n: number): void { for (let i = 0; i < n; i++) pong(n - 1); }
export function pong(n: number): void {
  for (let i = 0; i < n; i++) ping(n - 1);
  leaf();
}
export function leaf(): number {
  let total = 0;
  for (let i = 0; i < 4; i++) total += new Map<number, number>([[i, i]]).size;
  return total;
}
