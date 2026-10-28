import { AmbientLight, Box3, Color, DirectionalLight, PerspectiveCamera, SRGBColorSpace, Scene, Vector3, type WebGLRenderer, WebGLRenderTarget } from 'three';

import type { Building } from '@world/buildings/types';
import { assembleBuildingMeshes, emitChunk } from './buildingMesh';
import { buildSignature, disposeSignature, drawsSignature } from './signature';
import { type BuildingKit, createBuildingKit } from './kit';

/**
 * A BUILDING'S PHOTO, TAKEN ONCE: the Builder's options by `lab/builderPhotos.ts` (written beside the menu, `ui/photos/`), a design the player
 * saves at the moment it is saved (`buildingsWiring.ts`). The menu only shows photos; DO NOT take one as a menu opens (2026-10-27: the
 * Builder photographed every option as it opened, the game at 4 frames a second).
 *
 * Drawn by the renderer it is given into a target of its own. DO NOT draw it in a second WebGL context beside the game's: the baked surfaces
 * let their texels go once the game's context has them (`surfaceTextures.ts` letTexelsGo), and a second context sent each of them as storage
 * with nothing in it - every wall and roof black; it also held a second copy of every texture of the kit.
 */

/** The photos' side, px. */
const PHOTO_SIZE = 224;

/** How a photo frames its subject: a roof from above, a wall part on two bays of its ground storey, any other thing whole. */
export type PhotoView = 'roof' | 'wall' | 'model';

export interface PhotoStudio {
  /** The building's photo as a PNG; null when it builds nothing (its option keeps its glyph). */
  photograph(sample: Building, view: PhotoView): Promise<Blob | null>;
  dispose(): void;
}

/** sRGB bytes to linear light, and 4096 steps of linear light back to sRGB bytes (IEC 61966-2-1), for the colour taken out of its alpha. */
const LINEAR_IN = Float32Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const SRGB_OUT = Uint8Array.from({ length: 4096 }, (_, v) => { const c = v / 4095; return Math.round(255 * (c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); });

export function createPhotoStudio(gl: WebGLRenderer): PhotoStudio {
  // Encoded to sRGB as it is written (an sRGB target): the shader writes linear light into a target, and 8 bits of it band the shadows.
  const target = new WebGLRenderTarget(PHOTO_SIZE, PHOTO_SIZE, { colorSpace: SRGBColorSpace, samples: 4, depthBuffer: true, generateMipmaps: false });
  const kit: BuildingKit = createBuildingKit();
  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 1.15));
  const sun = new DirectionalLight(0xffffff, 1.5);
  sun.position.set(-3, 6, -2);
  scene.add(sun);
  const camera = new PerspectiveCamera(30, 1, 0.5, 4000);

  /** The scene drawn into the target, the renderer left as it was (its target, clear, planes, and the frame's counts: `info.autoReset` may be off). */
  const draw = (): void => {
    const counts = { ...gl.info.render };
    const was = { target: gl.getRenderTarget(), colour: gl.getClearColor(new Color()), alpha: gl.getClearAlpha(), autoClear: gl.autoClear, planes: gl.clippingPlanes };
    try {
      gl.setRenderTarget(target);
      gl.setClearColor(0x000000, 0);
      gl.clippingPlanes = [];
      gl.autoClear = false;
      gl.clear(true, true, true);
      gl.render(scene, camera);
    } finally {
      gl.setRenderTarget(was.target);
      gl.setClearColor(was.colour, was.alpha);
      gl.autoClear = was.autoClear;
      gl.clippingPlanes = was.planes;
      Object.assign(gl.info.render, counts);
    }
  };

  /** The target's pixels as a PNG, read back without stalling a frame (`readRenderTargetPixelsAsync`, a fence), turned upright and their colour
   *  taken out of the alpha it was blended with (the target holds it multiplied in; a PNG holds it apart). */
  const encode = async (): Promise<Blob | null> => {
    const pixels = new Uint8Array(PHOTO_SIZE * PHOTO_SIZE * 4);
    await gl.readRenderTargetPixelsAsync(target, 0, 0, PHOTO_SIZE, PHOTO_SIZE, pixels);
    const image = new ImageData(PHOTO_SIZE, PHOTO_SIZE);
    for (let y = 0; y < PHOTO_SIZE; y++) {
      for (let x = 0; x < PHOTO_SIZE; x++) {
        const i = ((PHOTO_SIZE - 1 - y) * PHOTO_SIZE + x) * 4, o = (y * PHOTO_SIZE + x) * 4;
        const a = pixels[i + 3]!;
        image.data[o + 3] = a;
        for (let c = 0; c < 3; c++) {
          image.data[o + c] = a === 0 ? 0 : a === 255 ? pixels[i + c]! : SRGB_OUT[Math.min(4095, Math.round((LINEAR_IN[pixels[i + c]!]! * 255 / a) * 4095))]!;
        }
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    return new Promise((done) => canvas.toBlob(done, 'image/png'));
  };

  return {
    async photograph(sample, view) {
      const chunk = emitChunk(sample, () => 0);
      const meshes = assembleBuildingMeshes([chunk], kit);
      // A signature building's body is drawn with its own parts, as in the town (`layer.ts`); the shared kit draws only its lot.
      const floor = drawsSignature(sample) ? chunk.signatureFloor : undefined;
      const signature = floor !== undefined ? buildSignature(sample, floor) : null;
      // A part that builds nothing keeps its glyph: an empty tile is a defect.
      if (meshes.triangles === 0 && !signature) {
        meshes.dispose();
        return null;
      }
      scene.add(meshes.group);
      if (signature) meshes.group.add(signature);
      try {
        const bounds = new Box3().setFromObject(meshes.group);
        const centre = bounds.getCenter(new Vector3());
        const size = bounds.getSize(new Vector3());
        // A wall part is framed on two bays of the ground storey, not the block.
        const radius = view === 'wall'
          ? 0.5 * Math.hypot(Math.min(size.x, 7.5), Math.min(size.y, 5))
          : 0.5 * Math.hypot(size.x, size.y, size.z);
        if (view === 'wall') {
          centre.y = bounds.min.y + Math.min(size.y, 5) * 0.62;
          // The front wall: the face nearest the camera's side of the box.
          centre.z = bounds.max.z;
        }
        const dir = view === 'roof' ? new Vector3(0.5, 1.05, 0.62) : view === 'wall' ? new Vector3(0.28, 0.12, 1) : new Vector3(0.62, 0.6, 0.62);
        dir.normalize();
        const distance = (Math.max(radius, 0.8) / Math.sin((camera.fov * Math.PI) / 360)) * 1.08;
        camera.position.copy(centre).addScaledVector(dir, distance);
        camera.lookAt(centre);
        camera.updateProjectionMatrix();
        // Its programs built off the frame (`compileAsync`, KHR_parallel_shader_compile), then drawn.
        await gl.compileAsync(scene, camera);
        if (gl.getContext().isContextLost()) return null;
        draw();
        return await encode();
      } finally {
        scene.remove(meshes.group);
        if (signature) { meshes.group.remove(signature); disposeSignature(signature); }
        meshes.dispose();
      }
    },
    dispose() {
      target.dispose();
      kit.dispose();
    },
  };
}
