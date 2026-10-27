import { BoxGeometry, Group, type Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, PerspectiveCamera, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';

import { createDepthFirst, renderDepthFirst } from '@render/depthFirst';

/** THE FAR MASSES' DEPTH DRAWN FIRST (`depthFirst.ts`): what draws in the depth alone, and what is left as it was */

interface Drawn { readonly root: Object3D; readonly materials: Map<string, Material | Material[]>; readonly shown: Set<string>; readonly autoClear: boolean }

/** A renderer that records what each `render` would draw. */
function recorder(reversed: boolean): { renderer: WebGLRenderer; drawn: Drawn[]; clears: number; masks: boolean[] } {
  const drawn: Drawn[] = [];
  const masks: boolean[] = [];
  const out = { renderer: null as unknown as WebGLRenderer, drawn, clears: 0, masks };
  const renderer = {
    autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
    capabilities: { reversedDepthBuffer: reversed },
    state: { buffers: { color: { setMask: (on: boolean) => masks.push(on) } } },
    clear: () => { out.clears++; },
    render(root: Object3D) {
      const materials = new Map<string, Material | Material[]>();
      const shown = new Set<string>();
      root.traverseVisible((o) => { if ((o as Mesh).isMesh) { materials.set(o.name, (o as Mesh).material); shown.add(o.name); } });
      drawn.push({ root, materials, shown, autoClear: renderer.autoClear });
    },
  };
  out.renderer = renderer as unknown as WebGLRenderer;
  return out;
}

const mesh = (name: string, material: Material | Material[]): Mesh => Object.assign(new Mesh(new BoxGeometry(), material), { name });

describe('the far masses drawn into the depth first', () => {
  it('draws the opaque masses in the depth alone, pushed back, and leaves every mesh as it was', () => {
    const massing = new MeshStandardMaterial();
    const base = new MeshStandardMaterial();
    const glass = new MeshStandardMaterial({ transparent: true, opacity: 0.5 });
    const root = new Group();
    const cell = mesh('cell', massing), plate = mesh('plate', [base]), ghost = mesh('ghost', glass), off = mesh('off', massing);
    off.visible = false;
    root.add(cell, plate, ghost, off);
    const first = createDepthFirst();
    first.root = root;
    const { renderer, drawn, masks } = recorder(true);
    first.draw(renderer, new PerspectiveCamera());

    expect(drawn).toHaveLength(1);
    const pass = drawn[0]!;
    expect(pass.root).toBe(root);
    // The opaque masses in a depth material; one that lets the view through (a ghost) and one hidden not drawn.
    expect([...pass.shown].sort()).toEqual(['cell', 'plate']);
    const depth = pass.materials.get('cell') as MeshBasicMaterial;
    expect(depth.colorWrite).toBe(false);
    expect(depth.polygonOffset).toBe(true);
    // Away from the eye in a reversed depth: three negates the factor itself, the units given negative (r186 `WebGLState.setPolygonOffset`).
    expect(depth.polygonOffsetFactor).toBeGreaterThan(0);
    expect(depth.polygonOffsetUnits).toBeLessThan(0);
    expect((pass.materials.get('plate') as Material[])[0]).toBe(depth);
    expect(pass.autoClear).toBe(false);

    // Every mesh as it was after it, the colour written again.
    expect(cell.material).toBe(massing);
    expect((plate.material as Material[])[0]).toBe(base);
    expect(ghost.visible).toBe(true);
    expect(off.visible).toBe(false);
    expect(renderer.autoClear).toBe(true);
    expect(masks.at(-1)).toBe(true);
  });

  it('draws nothing under a group the scene does not draw', () => {
    const scene = new Group();
    const root = new Group();
    root.add(mesh('cell', new MeshStandardMaterial()));
    scene.add(root);
    scene.visible = false;
    const first = createDepthFirst();
    first.root = root;
    const { renderer, drawn } = recorder(false);
    first.draw(renderer, new PerspectiveCamera());
    expect(drawn).toHaveLength(0);
  });

  it('clears once, before the masses, and draws the scene over their depth', () => {
    const scene = new Group();
    const root = new Group();
    root.add(mesh('cell', new MeshStandardMaterial()));
    scene.add(root, mesh('road', new MeshStandardMaterial()));
    const first = createDepthFirst();
    first.root = root;
    const rec = recorder(false);
    renderDepthFirst(rec.renderer, scene, new PerspectiveCamera(), first);
    expect(rec.clears).toBe(1);
    expect(rec.drawn.map((d) => d.root)).toEqual([root, scene]);
    // Neither draw clears what the other drew; the renderer's own clearing given back.
    expect(rec.drawn.every((d) => !d.autoClear)).toBe(true);
    expect(rec.renderer.autoClear).toBe(true);
    // A standard depth: the units away from the eye as given.
    expect((rec.drawn[0]!.materials.get('cell') as MeshBasicMaterial).polygonOffsetUnits).toBeGreaterThan(0);
  });
});
