import {
  type BufferGeometry, Color, Matrix4, Mesh, MeshStandardMaterial, OrthographicCamera, Scene, ShaderChunk, Vector2, Vector4, WebGLRenderTarget,
  type Material, type Texture, type WebGLRenderer,
} from 'three';
import { DEPTH_GLSL } from '../depthConvention';
import { SUN_CASCADES } from '../sunCascades';
import { BAKE_SAMPLES, bakeMaterialsOf } from '../impostorBake';
import { FRAMES, FRAME_PX } from '../impostorShaders';
import type { PicturePart } from '../pictureParts';
import {
  COLOUR_MAP_STILL, FRAGMENT_PARS, PICTURE_PX, SET_MODELS, STILL_READ_GLSL, colourNormal, layoutOf, pictureOf, pictureQuad, stillOf, takePictureFrames,
  vertexMain, vertexPars, waitForPictures,
} from '../plantImpostors';
import type { PartKind } from './chunk';
import { THIN_PROPS } from './facadeProps';
import { posePart } from './partPose';
import { THIN_TONE_GLSL } from './thinParts';

export { PICTURE_PX } from '../plantImpostors';

/**
 * THE SMALL PROPS' FAR PICTURES (`kit.ts` PICTURED): each kind's model taken from 8 x 8 directions over the upper hemi-octahedron and drawn as
 * one quad an instance where it spans under `PICTURE_PX`, as the street props are (`plantImpostors.ts` createImpostors; Ryan Brucks, "Octahedral
 * Impostors", shaderbits.com, 2018), with the street props' own chunks: from the part's pose (`partPose.ts`), its instance's tint, its near
 * material's surface. A set a surface (roughness, metalness, sky's share): one material each, one program for them all. Each set holds what its
 * pictures are read by and no more: frames `PICTURE_PX` texels wide (never drawn wider: no texel magnified), their finest level alone (a still
 * set reads no other, `STILL_READ_GLSL`), no shadow outline (a picture casts nothing: its model's coarsest level casts for it, `partCells.ts`),
 * the colour and the normal, the normal's alpha the model's depth on the frame.
 *
 * THE DEPTH: a quad through the model's middle stood behind the wall a condenser hangs on, its edge by the wall hidden at a slant; each pixel
 * of the picture writes its model's own depth instead, taken with the picture (pixel depth offset: Brucks's impostor baker,
 * https://80.lv/articles/impostor-baker-for-ue4/), in the game's depth convention (`depthConvention.ts` DEPTH_GLSL).
 *
 * THE SUN'S SHADOW is read where the model's surface is, as its mesh reads it, not on the quad: the quad stands in the model's middle, behind the
 * faces the sun lights, and the model's own shadow (its coarsest level casts) darkened its picture (a bush a third darker at 36 m, the ladder
 * sheets, 2026-10-25).
 *
 * A THIN PROP (`facadeProps.ts` THIN_PROPS: a chair's, an airer's, a table's, a bike's bars) is toned by its bar and the tone behind as its mesh
 * is (`thinParts.ts` prefilterThinParts), after its instance's colour: the numbers its model's, a uniform a model (its one part is thin all over),
 * by the metres a pixel spans on the model's surface there, as its mesh's derivatives take them (the quad faces the eye: a chair's seat seen
 * along it spans ten times its metres, and its picture came out bluer than its model, the ladder sheets, 2026-10-25).
 */

/** The order a picture is drawn in: first of the blended things (three r186 sorts them by `renderOrder`, then back to front), over what is
 *  drawn solid, as its model is drawn before them. DO NOT leave it at a part's 0: a plant behind a balcony's glass parapet (`glassRail`, blended)
 *  sorted after it and was drawn over the glass, vivid where its model is seen through it, pale (the tower sheets, 2026-10-25). */
export const PICTURE_ORDER = -1;

/** Texels across one frame of a picture: the most a picture is drawn across. */
const FRAME = PICTURE_PX;

/** `source` with `from` replaced by `to`, thrown when `from` is not in it: the shared code changed under this file. */
function patched(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`partPictures: "${from}" is not in the shared picture code`);
  return source.replace(from, to);
}

/** The bake's normal (`impostorBake.ts` bakeWithMaterial): its alpha given to the depth, -1..1 of the radius along the frame (the camera
 *  stands two radii off the model's middle, `bake`), 0.5 + half that. */
const BAKE_NORMAL = 'gNormal = vec4(normalize(transpose(mat3(viewMatrix)) * normal) * 0.5 + 0.5, 1.0);';
const BAKE_DEPTH = BAKE_NORMAL.replace(', 1.0);', ', clamp(0.5 + 0.5 * (vViewPosition.z - 2.0 * uPictureRadius) / uPictureRadius, 0.0, 1.0));');

/** The picture's frame in the view, flat for its quad: its model's middle, the frame's direction times the radius, its plane's normal, the radius. */
const FRAME_VARYINGS = /* glsl */ `
  flat varying vec3 vPictureCentre;
  flat varying vec3 vPictureAxis;
  flat varying vec3 vPicturePlane;
  flat varying float vPictureReach;
`;

/** After three's `project_vertex`: the frame `vertexMain` chose (its nearest), in the view. */
const FRAME_VERTEX = /* glsl */ `
  {
    #ifdef USE_INSTANCING
    mat4 pictureView = modelViewMatrix * instanceMatrix;
    #else
    mat4 pictureView = modelViewMatrix;
    #endif
    mat3 pictureTurn = mat3(pictureView);
    vec3 facing = hemiOctaDecode(vWeights.x > 0.5 ? vFrame1 : vWeights.y > 0.5 ? vFrame2 : vFrame3);
    vPictureCentre = (pictureView * vec4(aSphere.xyz, 1.0)).xyz;
    vPictureAxis = pictureTurn * facing * aSphere.w;
    vPicturePlane = normalize(transpose(inverse(pictureTurn)) * facing);
    vPictureReach = aSphere.w * max(length(pictureTurn[0]), max(length(pictureTurn[1]), length(pictureTurn[2])));
  }
`;

/** The still read's normal (`colourNormal`) with its cover read off the colour (the normal's alpha is the depth): the depth and the world's
 *  normal kept for the surface (`DEPTH_WRITE`) and the sun (`PICTURE_SUN`). */
const PART_NORMAL = patched(
  patched(colourNormal(stillOf('uNormals'), true), 'packed.rgb / max(packed.a, 1e-4)', 'packed.rgb / max(impostorColour.a, 1e-4)'),
  'nonPerturbedNormal = normal;',
  'nonPerturbedNormal = normal;\n    pictureDepth = packed.a / max(impostorColour.a, 1e-4);\n    pictureSunNormal = world / max(length(world), 1e-6);',
);

/** Where the sun's shadow is read (`PICTURE_SUN`): from the quad to the model's surface, and the surface's normal, the world's axes. */
const SUN_GLOBALS = /* glsl */ `
  vec3 pictureSunShift = vec3(0.0);
  vec3 pictureSunNormal = vec3(0.0, 1.0, 0.0);
`;

/** The sun's cascades' coordinate (`sunCascades.ts` sunCascadeCoordOf): its world position and normal the surface's. */
const CASCADE_GRAZING = 'float grazing = 1.0 - clamp( - dot( vSunCascadeNormal, sunAxis ), 0.0, 1.0 );';
const CASCADE_COORD = 'return shadowMatrix * vec4( vSunCascadeWorld + vSunCascadeNormal * normalBias * ( 0.4 + 2.6 * grazing ), 1.0 );';
/** Three's own directional shadow's coordinate (r186 `lights_fragment_begin`), for a scene whose sun is not the cascades: moved to the surface. */
const DIRECTIONAL_COORD = 'vDirectionalShadowCoord[ i ] )';

/** The shadow's chunks as they are (the game's cascades or three's own) read at the model's surface (`pictureSunShift`, `pictureSunNormal`). */
function pictureSun(fragment: string): string {
  const pars = ShaderChunk.shadowmap_pars_fragment;
  const cascaded = pars.includes(CASCADE_COORD);
  const sunPars = !cascaded ? pars : patched(patched(pars, CASCADE_GRAZING, CASCADE_GRAZING.replace('vSunCascadeNormal', 'pictureSunNormal')), CASCADE_COORD,
    'return shadowMatrix * vec4( vSunCascadeWorld + pictureSunShift + pictureSunNormal * normalBias * ( 0.4 + 2.6 * grazing ), 1.0 );');
  // Three's own reads its coordinate made in the vertex: the matrices that made it, to move it (`shadowmap_pars_vertex` holds them; the cascades'
  // fragment holds them for their own count).
  const matrices = `#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0${cascaded ? ` && NUM_DIR_LIGHT_SHADOWS != ${SUN_CASCADES}` : ''}
  uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif`;
  const lights = patched(ShaderChunk.lights_fragment_begin, DIRECTIONAL_COORD, '( vDirectionalShadowCoord[ i ] + directionalShadowMatrix[ i ] * vec4( pictureSunShift, 0.0 ) ) )');
  return fragment
    .replace('#include <shadowmap_pars_fragment>', `${sunPars}\n${matrices}`)
    .replace('#include <lights_fragment_begin>', lights);
}

/** After the normal: the depth of the model's surface where the eye's ray through this pixel meets it - the frame's plane at the picture's depth,
 *  held inside the model's sphere (a ray nearly along that plane meets it far off) - written as the window depth the same view gives it: the quad's
 *  own depth here moved by the difference of the two clip depths, in the game's convention (`DEPTH_GLSL` depthToClipZ). */
const DEPTH_WRITE = /* glsl */ `
  {
    vec3 quadPoint = -vViewPosition;
    vec3 ray = isOrthographic ? vec3(0.0, 0.0, -1.0) : normalize(quadPoint);
    vec3 onPlane = vPictureCentre - vPictureAxis * (pictureDepth * 2.0 - 1.0);
    float along = dot(onPlane - quadPoint, vPicturePlane) / dot(ray, vPicturePlane);
    vec3 fromCentre = quadPoint - vPictureCentre;
    float middle = dot(ray, fromCentre);
    float chord = sqrt(max(middle * middle - dot(fromCentre, fromCentre) + vPictureReach * vPictureReach, 0.0));
    vec3 surface = quadPoint + ray * clamp(along, -middle - chord, -middle + chord);
    vec4 surfaceClip = projectionMatrix * vec4(surface, 1.0), quadClip = projectionMatrix * vec4(quadPoint, 1.0);
    gl_FragDepth = gl_FragCoord.z + (surfaceClip.z / surfaceClip.w - quadClip.z / quadClip.w) / (depthToClipZ(1.0) - depthToClipZ(0.0));
    // The view's turn undone (a rigid view): the world's axes.
    mat3 toWorld = transpose(mat3(viewMatrix));
    pictureSunShift = toWorld * (surface - quadPoint);
    // A thin model's tone (its bar and the tone behind, \`uPartThin\` by its block) after its instance's colour, by the metres a pixel spans on its
    // surface as its mesh's \`thinMetresPerPixel\` takes them: the quad's steps across the pixel, at the surface's depth, carried along the eye's
    // ray onto the surface's plane (the picture's normal), summed on the world's axes.
    vec3 stepX = dFdx(quadPoint), stepY = dFdy(quadPoint);
    vec2 partThin = uPartThin[int(vBlock.x + vBlock.y * uBlocks.x + 0.5)];
    if (partThin.x > 0.0) {
      vec3 facing = normalize(normal);
      float scale = isOrthographic ? 1.0 : surface.z / quadPoint.z;
      float across = dot(ray, facing);
      across = sign(across) * max(abs(across), 1e-3);
      vec3 onX = stepX * scale - ray * (dot(stepX * scale, facing) / across);
      vec3 onY = stepY * scale - ray * (dot(stepY * scale, facing) / across);
      float metres = max(length(abs(toWorld * onX) + abs(toWorld * onY)) * 0.7071, 1e-4);
      diffuseColor.rgb = thinTone(diffuseColor.rgb, partThin.x, partThin.y, metres);
    }
  }
`;

/** The still read's declarations (`FRAGMENT_PARS`) for frames of `FRAME` texels. */
const PART_FRAGMENT_PARS = patched(FRAGMENT_PARS, `#define FRAME_PX ${FRAME_PX.toFixed(1)}`, `#define FRAME_PX ${FRAME.toFixed(1)}`);

/** A building part's far picture: its quad, its set's material (drawn from the parts' poses), its model's diagonal. */
export interface PartPicture {
  /** Four corners, the model's sphere and its block on the atlas (`plantImpostors.ts` pictureQuad). */
  readonly quad: BufferGeometry;
  readonly material: MeshStandardMaterial;
  /** Its model's diagonal, model units: its picture's sphere's diameter (`pictureOf`), what it spans on the screen by. */
  readonly across: number;
  /** Whether its set's pictures are taken (`takeWaitingPictures`): until then its model is drawn. */
  ready(): boolean;
}

export interface PartPictures {
  /** Each pictured kind's picture. */
  readonly of: ReadonlyMap<PartKind, PartPicture>;
  /** The sets' atlases: what the pictures hold on the GPU. */
  readonly textures: readonly Texture[];
  dispose(): void;
}

/** The pictures of `kinds`, their models `geometry` drawn near by `material` (their pictures taken with it, `impostorBake.ts` bakeWithMaterial),
 *  taken at the next `takeWaitingPictures`. */
export function createPartPictures<K extends PartKind>(kinds: readonly K[], geometry: Readonly<Record<K, BufferGeometry>>, material: Readonly<Record<K, Material>>): PartPictures {
  const bySurface = new Map<string, K[]>();
  for (const kind of kinds) {
    const near = material[kind];
    if (!(near instanceof MeshStandardMaterial)) throw new Error(`partPictures: ${kind}'s material has no surface to draw its picture with`);
    const key = `${near.roughness}|${near.metalness}|${near.envMapIntensity}`;
    bySurface.set(key, [...(bySurface.get(key) ?? []), kind]);
  }
  const of = new Map<PartKind, PartPicture>();
  const sets = [...bySurface.values()].map((group) => pictureSet(group.map((kind) => ({ kind, geometry: geometry[kind], material: material[kind] as MeshStandardMaterial }))));
  for (const set of sets) for (const [kind, picture] of set.pictures) of.set(kind, picture);
  return {
    of,
    textures: sets.flatMap((set) => set.textures),
    dispose() { for (const set of sets) set.dispose(); },
  };
}

/** One set: the models of one surface, one atlas, one material. */
function pictureSet(models: readonly { readonly kind: PartKind; readonly geometry: BufferGeometry; readonly material: MeshStandardMaterial }[]): {
  readonly pictures: readonly (readonly [PartKind, PartPicture])[]; readonly textures: readonly Texture[]; dispose(): void;
} {
  if (models.length > SET_MODELS) throw new Error(`partPictures: ${models.length} models of one surface (${SET_MODELS} at most)`);
  const parts: PicturePart[] = models.map(({ kind, geometry, material }) => {
    const thin = THIN_PROPS.find(([k]) => k === kind);
    return { geometry, normals: 'vertex', side: material.side, casts: false, material, ...(thin ? { thin: { bar: thin[1], behind: thin[2] } } : {}) };
  });
  const pictures = parts.map((part) => pictureOf({ parts: [part] }));
  const blocks = layoutOf(models.length);
  const block = FRAMES * FRAME;
  const atlas = new WebGLRenderTarget(blocks.x * block, blocks.y * block, { count: 2, depthBuffer: false, generateMipmaps: false });
  // Each thin model's bar and tone behind, the numbers its mesh is toned by (`prefilterThinParts`: three decimals); none a solid model's.
  const thin = Array.from({ length: SET_MODELS }, (_, k) => {
    const t = parts[k]?.thin;
    return t ? new Vector2(Number(t.bar.toFixed(3)), Number(t.behind.toFixed(3))) : new Vector2();
  });
  const uniforms = {
    uAlbedo: { value: atlas.textures[0]! },
    uNormals: { value: atlas.textures[1]! },
    // The still read's third picture and its levels: none here (the thin tone by uniform, `DEPTH_WRITE`; the finest level alone).
    uThinParts: { value: null },
    uHasThin: { value: 0 },
    uPerMip: { value: 0 },
    uBlocks: { value: new Vector2(blocks.x, blocks.y) },
    uCullView: { value: new Matrix4() },
    // Not thinned (`PictureLook.thin` false), every size drawn (no band): the part's cells choose (`partCells.ts` levelAt).
    uThin: { value: new Vector4(0, 540, 2048, 0) },
    uBand: { value: new Vector2(0, Number.MAX_VALUE) },
    uPartThin: { value: thin },
  };
  const near = models[0]!.material;
  const drawn = new MeshStandardMaterial({ roughness: near.roughness, metalness: near.metalness, envMapIntensity: near.envMapIntensity, transparent: true });
  drawn.name = `building-part-pictures-${models.map((m) => m.kind).join('-')}`;
  drawn.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars(false, true)}\n${FRAME_VARYINGS}`)
      .replace('#include <begin_vertex>', vertexMain(false, true))
      .replace('#include <project_vertex>', `#include <project_vertex>\n${FRAME_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PART_FRAGMENT_PARS}\nuniform sampler2D uAlbedo;\nuniform sampler2D uNormals;\nflat varying mat3 vNormalToWorld;
uniform sampler2D uThinParts;\nuniform float uHasThin;\nuniform float uPerMip;\nuniform vec2 uPartThin[${SET_MODELS}];\nuniform mat4 projectionMatrix;
${THIN_TONE_GLSL}\n${STILL_READ_GLSL}\n${DEPTH_GLSL}\n${FRAME_VARYINGS}\n${SUN_GLOBALS}`)
      .replace('#include <map_fragment>', COLOUR_MAP_STILL)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\nfloat pictureDepth = 0.5;\n${PART_NORMAL}\n${DEPTH_WRITE}`);
    shader.fragmentShader = pictureSun(shader.fragmentShader);
  };
  // One program for every set: their atlases, blocks, tones and surfaces are uniforms.
  drawn.customProgramCacheKey = () => 'building-part-picture';
  posePart(drawn);

  // Measured by its sphere's diameter (`vertexMain`'s band, none here).
  const quads = pictures.map((picture, k) => pictureQuad(picture, k, blocks, 2 * picture.radius));

  let baked = false;
  /** The pictures taken, once, between draws: every frame of every model multisampled as the game draws (`BAKE_SAMPLES`), copied onto the atlas. */
  const bake = (renderer: WebGLRenderer): void => {
    unwait();
    baked = true;
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    const scene = new Scene();
    const radii = pictures.map((picture) => ({ value: picture.radius }));
    const colours = parts.map((part, k) => {
      const { colour, outline } = bakeMaterialsOf(part);
      outline.dispose();
      return withDepth(colour, radii[k]!);
    });
    const was = {
      target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
      shadows: renderer.shadowMap.autoUpdate, colour: renderer.getClearColor(new Color()),
    };
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    const taken = new WebGLRenderTarget(atlas.width, atlas.height, { count: 2, depthBuffer: true, generateMipmaps: false, samples: BAKE_SAMPLES });
    takePictureFrames(renderer, taken, FRAME, { scene, camera, pictures, blocks }, (k) => { scene.add(new Mesh(parts[k]!.geometry, colours[k]!)); }, null);
    scene.clear();
    renderer.initRenderTarget(atlas);
    for (let i = 0; i < atlas.textures.length; i++) renderer.copyTextureToTexture(taken.textures[i]!, atlas.textures[i]!);
    taken.dispose();
    renderer.setRenderTarget(was.target);
    renderer.setClearColor(was.colour, was.alpha);
    renderer.autoClear = was.autoClear;
    renderer.shadowMap.autoUpdate = was.shadows;
    for (const m of colours) m.dispose();
  };
  const unwait = waitForPictures(bake);
  const ready = (): boolean => baked;
  return {
    pictures: models.map(({ kind }, k) => [kind, { quad: quads[k]!, material: drawn, across: 2 * pictures[k]!.radius, ready }] as const),
    textures: atlas.textures,
    dispose() {
      unwait();
      for (const q of quads) q.dispose();
      drawn.dispose();
      atlas.dispose();
    },
  };
}

/** A part's bake material (`bakeMaterialsOf`) writing its depth on the frame into its normal's alpha (`BAKE_DEPTH`), its radius `radius`. */
function withDepth(bake: Material, radius: { value: number }): Material {
  const own = bake.onBeforeCompile.bind(bake), key = bake.customProgramCacheKey.bind(bake);
  bake.onBeforeCompile = (shader, renderer) => {
    own(shader, renderer);
    shader.uniforms['uPictureRadius'] = radius;
    shader.fragmentShader = patched(patched(shader.fragmentShader, '#include <common>', '#include <common>\nuniform float uPictureRadius;'), BAKE_NORMAL, BAKE_DEPTH);
  };
  bake.customProgramCacheKey = () => `${key()}|depth`;
  return bake;
}
