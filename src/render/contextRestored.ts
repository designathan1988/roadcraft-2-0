import type { WebGLRenderer } from 'three';

/** WHAT LIVES ONLY ON THE GPU, DRAWN AGAIN WHEN A LOST CONTEXT COMES BACK: three makes a render target's storage again where it is next drawn
 *  into, but never draws it again by itself - a picture taken once (`plantImpostors.ts`, `buildings/partPictures.ts`) holds nothing after it. */

/** `again` told each time the renderer's context is restored; the function returned stops it. */
export function onContextRestored(renderer: WebGLRenderer, again: () => void): () => void {
  const canvas = renderer.domElement;
  canvas.addEventListener('webglcontextrestored', again);
  return () => canvas.removeEventListener('webglcontextrestored', again);
}
