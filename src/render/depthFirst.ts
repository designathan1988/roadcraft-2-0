import { type Camera, type Material, type Mesh, MeshBasicMaterial, type Object3D, type Side, type WebGLRenderer } from 'three';

/**
 * THE FAR MASSES' DEPTH DRAWN BEFORE THE SCENE (a depth prepass): the masses standing for the town from afar (`massCells.ts`) drawn into the depth
 * alone, so every fragment they cover - a mass behind another, the roads, lots and trees behind them - fails the depth test before it is shaded
 * (early Z) once the colour pass draws it. The picture is the same: the masses are opaque and written whole, and the colour pass draws them again.
 *
 * Pushed back a little (`polygonOffset`): another program works out the same vertices' depth, and DO NOT count on it to the bit - an equal depth
 * from two programs is not promised without `invariant`, and drivers under ANGLE and Metal break it even with it (WebKit bug 293683,
 * https://bugs.webkit.org/show_bug.cgi?id=293683; Khronos, https://community.khronos.org/t/depth-prepass-causes-z-fighting/7512). The masses'
 * own fragments lie in front of it and pass; what lies within the offset behind them is shaded and then covered, as without it.
 */

export interface DepthFirst {
  /** What is drawn first (null: nothing): its meshes shown, opaque and written to the depth, in the depth alone. */
  root: Object3D | null;
  /** `camera`'s view of the root's meshes into the target bound now, over its depth as it stands (cleared by the caller); the renderer's clearing left as it was. */
  draw(renderer: WebGLRenderer, camera: Camera): void;
  dispose(): void;
}

/** Whether a material hides what is behind it wherever it draws: opaque, nothing cut out, its depth written. */
const occludes = (material: Material): boolean =>
  material.visible && !material.transparent && material.alphaTest === 0 && !material.alphaToCoverage && material.depthWrite && material.depthTest && material.colorWrite;

export function createDepthFirst(): DepthFirst {
  /** One depth material for each side drawn (`Material.side`), made for the renderer's depth: three negates a polygon offset's factor in a reversed depth, not its units (r186 `WebGLState.setPolygonOffset`). */
  const depths = new Map<Side, MeshBasicMaterial>();
  let reversed: boolean | null = null;
  const depthOf = (side: Side): MeshBasicMaterial => {
    let depth = depths.get(side);
    if (!depth) {
      depth = new MeshBasicMaterial({ colorWrite: false, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: reversed ? -2 : 2 });
      depth.name = 'depth-first';
      depths.set(side, depth);
    }
    return depth;
  };
  /** A mesh's materials in the depth alone, made once for each array it draws with (its groups' indices kept); null: it does not hide what is behind it. */
  const arrays = new WeakMap<readonly Material[], Material[] | null>();
  const depthMaterial = (material: Material | Material[]): Material | Material[] | null => {
    if (!Array.isArray(material)) return occludes(material) ? depthOf(material.side) : null;
    let made = arrays.get(material);
    if (made === undefined) {
      made = material.every(occludes) ? material.map((m) => depthOf(m.side)) : null;
      arrays.set(material, made);
    }
    return made;
  };
  /** The meshes swapped for the pass, each with its own material; those that hide nothing, hidden for it. */
  const swapped: (Mesh | Material | Material[])[] = [];
  const hidden: Object3D[] = [];
  return {
    root: null,
    draw(renderer, camera) {
      const root = this.root;
      if (!root) return;
      // Not drawn where the scene does not draw it (a layer switched off above it).
      for (let o: Object3D | null = root; o; o = o.parent) if (!o.visible) return;
      const isReversed = renderer.capabilities.reversedDepthBuffer;
      if (reversed !== isReversed) { reversed = isReversed; for (const d of depths.values()) d.dispose(); depths.clear(); }
      root.traverseVisible((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const depth = depthMaterial(mesh.material);
        if (depth) swapped.push(mesh, mesh.material);
        else hidden.push(mesh);
      });
      if (!swapped.length) { hidden.length = 0; return; }
      for (let i = 0; i < swapped.length; i += 2) {
        const mesh = swapped[i] as Mesh;
        mesh.material = depthMaterial(swapped[i + 1] as Material | Material[])!;
      }
      for (const o of hidden) o.visible = false;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      try {
        renderer.render(root, camera);
      } finally {
        renderer.autoClear = autoClear;
        // The colour written again: three's `clear` keeps the colour mask the last material left (r186 `WebGLRenderer.clear` sets the depth's and stencil's, not the colour's).
        renderer.state.buffers.color.setMask(true);
        for (let i = 0; i < swapped.length; i += 2) (swapped[i] as Mesh).material = swapped[i + 1] as Material | Material[];
        for (const o of hidden) o.visible = true;
        swapped.length = 0;
        hidden.length = 0;
      }
    },
    dispose() {
      for (const d of depths.values()) d.dispose();
      depths.clear();
    },
  };
}

/** The scene drawn into the target bound now, `first` drawn into its depth before it (`DepthFirst`): cleared once, as three would clear it. */
export function renderDepthFirst(renderer: WebGLRenderer, scene: Object3D, camera: Camera, first: DepthFirst | null): void {
  if (!first?.root) { renderer.render(scene, camera); return; }
  const autoClear = renderer.autoClear;
  // The clear three makes at the start of `render` with no background (the game's sky is a mesh, `environment.ts`): made first, then none.
  if (autoClear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
  renderer.autoClear = false;
  try {
    first.draw(renderer, camera);
    renderer.render(scene, camera);
  } finally {
    renderer.autoClear = autoClear;
  }
}
