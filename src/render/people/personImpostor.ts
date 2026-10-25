import {
  BufferAttribute, BufferGeometry, DoubleSide, InstancedBufferAttribute, InstancedMesh, MeshStandardMaterial, Sphere, Vector3, Vector4,
  type Texture,
} from 'three';
import type { CookedImpostor } from './cookedPerson';

/**
 * A PERSON'S FAR PICTURE: past the coarsest mesh a figure is a card of two triangles turned to the eye, showing the one of its
 * `frames` yaw views (in its file's atlas, `cookedPerson.ts` CookedImpostor) nearest the direction it is seen from. Standing, as a
 * figure a few pixels tall is read; lit flat as a cylinder facing the viewer. It casts nothing: no far figure ever did.
 */

/** Device pixels a figure stands under before it is a card (its error against the coarsest mesh is past a pixel anyway). */
export const IMPOSTOR_PIXELS = 8;

const VERTEX_PARS = /* glsl */ `
uniform vec4 uFrame;
uniform float uFrames;
uniform vec2 uCard;
varying vec2 vImpUv;`;

/** In place of three's `begin_vertex`: the card's corner in the model's frame, turned to the eye; its frame by the yaw it is seen from. */
const VERTEX_MAIN = /* glsl */ `
vec3 transformed = vec3(0.0);
{
  vec3 foot = instanceMatrix[3].xyz;
  mat3 shape = mat3(instanceMatrix);
  mat3 toModel = inverse(shape);
  vec3 eyeWorld = cameraPosition;
  if (projectionMatrix[2][3] == 0.0) eyeWorld = foot + vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) * 1.0e5;
  vec3 eye = toModel * (eyeWorld - foot);
  vec3 level = normalize(vec3(eye.x, 0.0, eye.z) + vec3(1e-6, 0.0, 0.0));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), level));
  transformed = right * position.x * uCard.x + vec3(0.0, (position.y + 0.5) * uCard.y, 0.0);
  // The frame taken from the yaw the eye sees it from: the cook's camera k stood at yaw k * 2pi / frames.
  float yaw = atan(level.x, level.z);
  float frame = mod(floor(yaw / 6.28318530718 * uFrames + 0.5), uFrames);
  vImpUv = vec2(uFrame.x + (frame + position.x + 0.5) * uFrame.z, uFrame.y + (position.y + 0.5) * uFrame.w);
}`;

/** In place of three's `beginnormal_vertex`: lit as a cylinder facing the viewer. */
const NORMAL_MAIN = /* glsl */ `
vec3 objectNormal;
{
  vec3 foot = instanceMatrix[3].xyz;
  mat3 toModel = inverse(mat3(instanceMatrix));
  vec3 eyeWorld = cameraPosition;
  if (projectionMatrix[2][3] == 0.0) eyeWorld = foot + vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) * 1.0e5;
  vec3 eye = toModel * (eyeWorld - foot);
  objectNormal = normalize(vec3(eye.x, 0.0, eye.z) + vec3(1e-6, 0.0, 0.0));
}`;

const FRAGMENT_PARS = /* glsl */ `
uniform vec4 uFrame;
uniform float uFrameTexels;
varying vec2 vImpUv;`;

/** In place of three's `map_fragment`: the frame's texels, never a mip so coarse the next frame bleeds in. */
const MAP_MAIN = /* glsl */ `
{
  vec2 texels = vec2(textureSize(map, 0));
  vec2 dx = dFdx(vImpUv) * texels, dy = dFdy(vImpUv) * texels;
  float lod = clamp(0.5 * log2(max(dot(dx, dx), dot(dy, dy))), 0.0, log2(uFrameTexels) - 2.0);
  vec4 texel = textureLod(map, vImpUv, lod);
  diffuseColor *= texel;
}`;

/** One quad: the card's corners, x and y in -0.5..0.5. */
function cardGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export interface PersonImpostor {
  readonly mesh: InstancedMesh;
  /** Room for at least `needed` instances (doubled), the written ones kept. */
  grow(needed: number): void;
  dispose(): void;
}

/**
 * The card mesh of one cooked body: `atlas` holds its frames at `frame` (texels, rows from the top), `atlasSize` across; the card
 * stands `height` metres tall in the model's frame, as wide as the frames' aspect. `capacity` instances to start with.
 */
export function createPersonImpostor(atlas: Texture, frame: CookedImpostor, atlasSize: number, height: number, capacity: number): PersonImpostor {
  const material = new MeshStandardMaterial({ map: atlas, roughness: 0.85, metalness: 0, side: DoubleSide, alphaTest: 0.5, transparent: false });
  // The frame strip in uv (v up: the KTX2's rows are bottom first), one frame `z` wide and `w` tall.
  const uFrame = { value: new Vector4(frame.x / atlasSize, 1 - (frame.y + frame.height) / atlasSize, frame.width / atlasSize, frame.height / atlasSize) };
  const uCard = { value: new Vector3(height * frame.width / frame.height, height, 0) };
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uFrame'] = uFrame;
    shader.uniforms['uFrames'] = { value: frame.frames };
    shader.uniforms['uCard'] = uCard;
    shader.uniforms['uFrameTexels'] = { value: frame.height };
    shader.vertexShader = `${VERTEX_PARS}\n${shader.vertexShader}`
      .replace('#include <beginnormal_vertex>', NORMAL_MAIN)
      .replace('#include <begin_vertex>', VERTEX_MAIN);
    shader.fragmentShader = `${FRAGMENT_PARS}\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', MAP_MAIN);
  };
  material.customProgramCacheKey = () => 'person-impostor-v3';
  const geometry = cardGeometry();
  // The card's own sphere: a figure's height round its foot, for `fitInstances` to widen by the instances' places.
  geometry.boundingSphere = new Sphere(new Vector3(0, height / 2, 0), height * 0.75);
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.visible = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.boundingSphere = new Sphere();
  return {
    mesh,
    grow(needed) {
      let room = Math.max(1, mesh.instanceMatrix.count);
      while (room < needed) room *= 2;
      const matrices = new InstancedBufferAttribute(new Float32Array(room * 16), 16);
      matrices.array.set(mesh.instanceMatrix.array);
      // DO NOT `dispose` the mesh to let its old buffer go (`riggedCitizens.ts` growLevel): the old one stays on the GPU till the context goes.
      mesh.instanceMatrix = matrices;
    },
    dispose() {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
