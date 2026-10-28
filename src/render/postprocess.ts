import {
  Color, DepthTexture, type DirectionalLight, FloatType, HalfFloatType, Matrix4, Mesh, NoBlending,
  RGFormat, SRGBColorSpace, Scene, ShaderMaterial, UnsignedByteType, Vector2, Vector3, WebGLRenderTarget, type Camera, type WebGLRenderer,
} from 'three';
import { FullScreenQuad, type Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { m, perM } from '@world/units';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import type { QualityLevel, QualitySettings } from './quality';
import { fullScreenTriangle } from './uploads';
import { createCanyonLight } from './canyonLight';
import { DEPTH_GLSL } from './depthConvention';
import { ALL_EFFECTS_ON, type PostSwitches } from './effectSwitches';
import { type DepthFirst, renderDepthFirst } from './depthFirst';
import type { CameraSolids } from '@world/buildings/cameraSolids';

/** The post chain: ambient occlusion, then anti-aliasing */


export interface PostChain {
  readonly enabled: boolean;
  /** What the scene is drawn into (null: the screen): shaders are compiled ahead for it. */
  readonly target: WebGLRenderTarget | null;
  /** Settles once the chain's own programs (its passes') are built: a quality change holds the last picture until then (`renderer.ts` compileChanged). */
  readonly ready: Promise<void>;
  /** Every render target the chain holds (the scene's, the composer's two, the masks, the occlusion's), for the video memory count (`targetBytes.ts`). */
  targets(): readonly WebGLRenderTarget[];
  render(delta: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** How dark it is, 0 by day to 1 at night: the bloom is for lights in the dark (lamps, headlights, lit windows). */
  setNight(dark: number): void;
  /** How much of the light on the ground comes straight from the sun (`SceneEnvironment.directShare`): the street light's sun (`canyonLight.ts`). */
  setDirectShare(share: number): void;
  /** The view's centre (map x, y), the town's solids and where they changed since the last call (null: anywhere) */
  followTown(cx: number, cy: number, solids: (() => CameraSolids) | null, changed: readonly (readonly [number, number, number, number])[] | null): void;
  /** Towards the sun, that the air and the street light are lit from */
  setAtmosphere(sun: Vector3,
    /** How far in front of the camera the view's equivalent eye stands (`uEyeShift`): 0 in perspective. */
    eyeShift?: number): void;
  /** Passes switched off from the effects panel (`effectSwitches.ts`): skipped by the composer from the next frame. */
  setSwitches(switches: PostSwitches): void;
  dispose(): void;
}

/** Told round every composer pass drawn (the lab's per-pass GPU timing, `lab/gpu`): set on the scene's `userData[POST_PASS_HOOK]`; absent, the passes draw as ever. */
export interface PostPassHook { before(pass: string): void; after(pass: string): void }
export const POST_PASS_HOOK = 'postPassHook';

export function createPostChain(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  quality: QualitySettings,
  level: QualityLevel,
  /** Drawn into the scene's depth before it (`depthFirst.ts`): the far masses, so what they cover is not shaded. */
  first: DepthFirst | null = null,
): PostChain {
  if (!quality.postProcessing) {
    // A canvas made for the chain has no multisampling of its own (`renderer.ts`): the scene multisampled in a target, then tone mapped onto it, as the canvas did.
    const plain = renderer.getContext().getContextAttributes()?.antialias === false ? plainChain(renderer, scene, camera, first) : null;
    return {
      enabled: false,
      target: plain?.target ?? null,
      ready: Promise.resolve(),
      targets: () => (plain ? [plain.target] : []),
      render() {
        if (plain) plain.render();
        else renderDepthFirst(renderer, scene, camera, first);
      },
      setSize(width, height, pixelRatio) {
        // Otherwise the renderer's own resize is enough.
        plain?.setSize(width, height, pixelRatio);
      },
      setNight() {
        /* no bloom without the chain */
      },
      setDirectShare() {
        /* no street light without the chain */
      },
      followTown() {
        /* no street light without the chain */
      },
      setAtmosphere() {
        /* no air without the chain */
      },
      setSwitches() {
        /* no passes without the chain */
      },
      dispose() {
        plain?.dispose();
      },
    };
  }

  const size = renderer.getSize(new Vector2());
  // The scene is drawn into ITS OWN target, which keeps its depth
  const ratio = renderer.getPixelRatio();
  const sceneTarget = new WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), {
    type: HalfFloatType,
    // A float depth buffer: the reversed Z the renderer draws with keeps its precision only in floats
    depthTexture: new DepthTexture(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), FloatType),
    // Multisampled, its depth resolved into the texture the occlusion reads (three's `resolveDepthBuffer`).
    samples: Math.min(quality.msaa, renderer.capabilities.maxSamples),
    // DO NOT keep the multisampled buffers once resolved: nothing reads them after the scene pass (the passes read the resolved colour and depth), and the driver may drop them instead of storing them (three's `invalidateFramebuffer` after the resolve).
    storeMultisampledColorBuffer: false,
    storeMultisampledDepthBuffer: false,
  });
  /** DO NOT hand the composer the scene's multisampled target again: it clones it */
  const target = new WebGLRenderTarget(Math.max(1, size.x * ratio), Math.max(1, size.y * ratio), { type: HalfFloatType, depthBuffer: false });
  /** The scene's resolved picture into the composer's buffer the passes read (`scenePass`). */
  const copyQuad = new FullScreenQuad(new ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, opacity: { value: 1 } },
    vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
    blending: NoBlending, depthTest: false, depthWrite: false,
  }));
  const composer = new EffectComposer(renderer, target);
  /** The programs being built ahead (`compileAsync` below): the chain is not taken apart until they are done. */
  const warming: Promise<unknown>[] = [];
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);
  // The passes, for the browser checks (a pass switched off to find what draws a defect).
  if (import.meta.env.DEV) Object.assign(window, { __composer: composer });
  const scenePass = new RenderPass(scene, camera);
  // Cleared below, before the masses' depth is drawn into it (`first`).
  scenePass.clear = false;
  composer.addPass(scenePass);
  /** The depth the scene was drawn with THIS frame. */
  const sceneDepth: DepthTexture | null = sceneTarget.depthTexture;
  /** Whether the first pass after the scene reads the scene's own target (`sceneReader`): then nothing is copied out of it. */
  let sceneRead = (): boolean => false;
  {
    const draw = scenePass.render.bind(scenePass);
    scenePass.render = (...args: Parameters<RenderPass['render']>) => {
      // Into the scene's own target; its resolved picture copied into the buffer the next pass reads only where that pass does not read the target itself.
      const [gl, writeBuffer, readBuffer, delta, mask] = args;
      // Cleared as the pass would clear it (`RenderPass.clear`), then the far masses' depth (`depthFirst.ts`), then the scene over it.
      gl.setRenderTarget(sceneTarget);
      gl.clear(gl.autoClearColor, gl.autoClearDepth, gl.autoClearStencil);
      first?.draw(gl, camera);
      draw(gl, writeBuffer, sceneTarget, delta, mask);
      if (!sceneRead()) {
        (copyQuad.material as ShaderMaterial).uniforms['tDiffuse']!.value = sceneTarget.texture;
        const previous = gl.getRenderTarget();
        gl.setRenderTarget(readBuffer);
        copyQuad.render(gl);
        gl.setRenderTarget(previous);
      }
    };
  }

  let gtao: GTAOPass | null = null;
  if (quality.ambientOcclusion) {
    gtao = new GTAOPass(scene, camera, size.x, size.y);
    // DO NOT let it copy the picture and blend into it (`OUTPUT.Default`, two full passes): its denoised occlusion is multiplied in by the canyon pass that reads the picture next (`canyonLight.ts` tAO).
    gtao.output = GTAOPass.OUTPUT.Off;
    gtao.needsSwap = false;
    // Tuned for world units where a kerb is 0.4 high and a pier is 15 tall.
    gtao.updateGtaoMaterial({
      radius: level === 'ultra' ? 1.3 : 1.0,
      distanceExponent: 1.6,
      thickness: 0.8,
      scale: 1.05,
      // Eight samples on every tier: the Poisson denoise takes the noise out, and sixteen at the scene's half resolution
      // (the AO's default) cost the pass about a third more for an edge no player can tell apart (the lab's passes, 2026-10-20).
      samples: 8,
      screenSpaceRadius: false,
    });
    gtao.blendIntensity = 0.85;
    // The denoise: half the Poisson taps of three's default (16), the noise it takes out is under an edge no player can tell apart (the lab's passes, 2026-10-20).
    gtao.updatePdMaterial({ samples: 8 });
    // An occlusion factor is a smooth 0..1, not an HDR colour: half floats held 12.4 MB of it at the half resolution. An 8-bit channel is enough for both the denoise and the multiply (`canyonLight.ts` reads the denoised target).
    {
      const width = gtao.gtaoRenderTarget.width, height = gtao.gtaoRenderTarget.height;
      gtao.gtaoRenderTarget.dispose();
      gtao.pdRenderTarget.dispose();
      gtao.gtaoRenderTarget = new WebGLRenderTarget(width, height, { depthBuffer: false });
      gtao.pdRenderTarget = new WebGLRenderTarget(width, height, { depthBuffer: false });
      gtao.pdMaterial.uniforms['tDiffuse']!.value = gtao.gtaoRenderTarget.texture;
    }
    // The occlusion is worked out from the depth the scene was just drawn with (normals rebuilt from it).
    const pass = gtao;
    const draw = pass.render.bind(pass);
    pass.render = (...args: Parameters<GTAOPass['render']>) => {
      const depth = sceneDepth;
      if (depth && pass.depthTexture !== depth) pass.setGBuffer(depth);
      draw(...args);
    };
    // At the scene's resolution, or half of it (`QualitySettings.aoFull`): scaled up, the half one blurs every edge the occlusion lies along
    const resize = pass.setSize.bind(pass);
    const share = quality.aoFull ? 1 : 2;
    pass.setSize = (width: number, height: number) => resize(Math.max(1, Math.ceil(width / share)), Math.max(1, Math.ceil(height / share)));
    composer.addPass(gtao);
    // GTAO's denoise shader is the slowest program to link on a cold start.
    gtao.setGBuffer(sceneTarget.depthTexture!);
    const quad = fullScreenTriangle();
    const warm = new Scene();
    warm.add(new Mesh(quad, gtao.gtaoMaterial), new Mesh(quad, gtao.pdMaterial));
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(gtao.gtaoRenderTarget);
    warming.push(renderer.compileAsync(warm, camera).catch((error: unknown) => {
      console.error('Ambient occlusion shader precompile failed', error);
    }).finally(() => quad.dispose()));
    renderer.setRenderTarget(previous);
  }

  // The light the town shuts out of its streets, and the sun's contact shadows (`canyonLight.ts`)
  let sunLights: DirectionalLight[] | null = null;
  const canyon = quality.ambientOcclusion
    ? createCanyonLight(camera, () => sceneDepth, () => (sunLights ??= ['sun', 'sun-cascade-1'].map((name) => scene.getObjectByName(name) as DirectionalLight | undefined).filter((light): light is DirectionalLight => light !== undefined)))
    : null;
  if (canyon) {
    const pass = canyon.pass;
    const shade = pass.render.bind(pass);
    // The scene's own resolved picture read directly (no copy), with the occlusion multiplied in as GTAO's blend did (dst * mix(1, ao, intensity)).
    pass.render = (gl, writeBuffer, readBuffer, delta, mask) => {
      canyon.setOcclusion(gtao?.enabled ? gtao.pdRenderTarget.texture : null, gtao?.blendIntensity ?? 0);
      shade(gl, writeBuffer, pass.enabled ? sceneTarget : readBuffer, delta, mask);
    };
    sceneRead = () => pass.enabled;
    composer.addPass(pass);
    const quad = fullScreenTriangle();
    const warm = new Scene();
    warm.add(new Mesh(quad, canyon.pass.material));
    // For the target it draws into (the composer's: no tone mapping, its colour space): compiled for another, its program was built again at its first draw (9 s, wprof7).
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(composer.renderTarget1);
    warming.push(renderer.compileAsync(warm, camera).catch((error: unknown) => {
      console.error('Street light shader precompile failed', error);
    }).finally(() => quad.dispose()));
    renderer.setRenderTarget(previous);
  }

  // Light that is brighter than white spills a little round itself: the sun on glass, lit windows and lamps at night.
  const bloomStrength = level === 'ultra' ? 0.22 : 0.18;
  const bloom = new UnrealBloomPass(new Vector2(size.x, size.y), bloomStrength, 0.32, 1.05);
  // The glow is low frequency: its ten mips at half the screen's width are indistinguishable and 45.6 MB → 11.4 at 2560 wide, and the bright pass and blurs cost a quarter of the fragments.
  {
    const resize = bloom.setSize.bind(bloom);
    bloom.setSize = (width: number, height: number) => resize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
  }
  shareBloomBlur(bloom.separableBlurMaterials as ShaderMaterial[]);
  bloom.enabled = false;
  composer.addPass(bloom);
  // Its shaders built now, in parallel (KHR_parallel_shader_compile), not at the first dusk
  {
    // FullScreenQuad's own triangle (position and uv, no normals)
    const quad = fullScreenTriangle();
    const warm = new Scene();
    for (const material of [bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial, bloom.blendMaterial]) {
      warm.add(new Mesh(quad, material));
    }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(bloom.renderTargetsHorizontal[0]!);
    warming.push(renderer.compileAsync(warm, camera).catch(() => {}).finally(() => quad.dispose()));
    renderer.setRenderTarget(previous);
  }
  // The air round the map (`AIR`): the backdrop and the haze by distance, on the linear image before tone mapping.
  const air = quality.airPass ? new ShaderPass(AIR) : null;
  /** Whether its program is built (compiled ahead below): until then the pass is not drawn. */
  let airReady = false;
  if (air) {
    const pass = air;
    const shade = pass.render.bind(pass);
    pass.render = (...args: Parameters<ShaderPass['render']>) => {
      pass.uniforms['tDepth']!.value = sceneDepth;
      shade(...args);
    };
    composer.addPass(air);
    // Its program built now, in parallel
    {
      const quad = fullScreenTriangle();
      const warm = new Scene();
      warm.add(new Mesh(quad, air.material));
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(composer.renderTarget1);
      // Not drawn until it is built: drawn while the driver still builds it, the frame waits all the same
      warming.push(renderer.compileAsync(warm, camera).catch(() => {}).finally(() => { quad.dispose(); airReady = true; }));
      renderer.setRenderTarget(previous);
    }
  }
  const smaa = quality.smaa ? new SMAAPass() : null;
  if (smaa) {
    // three ships SMAA at its *Medium* preset
    const tune = (material: ShaderMaterial, defines: Record<string, string>): void => {
      Object.assign(material.defines as Record<string, string>, defines);
      material.needsUpdate = true;
    };
    const pass = smaa as unknown as {
      _materialEdges: ShaderMaterial;
      _materialWeights: ShaderMaterial;
    };
    tune(pass._materialEdges, { SMAA_THRESHOLD: '0.04' });
    tune(pass._materialWeights, { SMAA_MAX_SEARCH_STEPS: '16' });
    // DO NOT keep three's half-float edges and weights: SMAA's own are RG8 and RGBA8 (Jimenez et al., SMAA.hlsl: edgesTex R8G8, blendTex R8G8B8A8), four and eight bytes a pixel less.
    const targets = smaa as unknown as { _edgesRT: WebGLRenderTarget; _weightsRT: WebGLRenderTarget; _uniformsWeights: Record<string, { value: unknown }>; _uniformsBlend: Record<string, { value: unknown }> };
    targets._edgesRT.dispose();
    targets._weightsRT.dispose();
    targets._edgesRT = new WebGLRenderTarget(1, 1, { depthBuffer: false, type: UnsignedByteType, format: RGFormat });
    targets._edgesRT.texture.name = 'SMAAPass.edges';
    targets._weightsRT = new WebGLRenderTarget(1, 1, { depthBuffer: false, type: UnsignedByteType });
    targets._weightsRT.texture.name = 'SMAAPass.weights';
    targets._uniformsWeights['tDiffuse']!.value = targets._edgesRT.texture;
    targets._uniformsBlend['tDiffuse']!.value = targets._weightsRT.texture;
    composer.addPass(smaa);
  }
  // The output and the grade in ONE pass: tone mapping, the sRGB transfer and the film grade
  const output = new OutputPass();
  // A raw shader gets no renderer defines: the depth convention written in (the OutputPass rewrites `defines` itself).
  output.material.fragmentShader = (renderer.capabilities.reversedDepthBuffer ? '#define USE_REVERSED_DEPTH_BUFFER\n' : '') + GRADED_OUTPUT_FRAGMENT;
  output.uniforms['uSharpen'] = { value: quality.sharpen };
  // How much each pixel may be sharpened, from the scene's depth, worked out in the output itself (no mask target of its own).
  output.uniforms['tDepth'] = { value: sceneDepth };
  output.uniforms['uProjectionInverse'] = { value: new Matrix4() };
  output.uniforms['uSharpSpan'] = { value: new Vector2(m(0.1), m(0.3)) };
  {
    const draw = output.render.bind(output);
    output.render = (...args: Parameters<OutputPass['render']>) => {
      (output.uniforms['uProjectionInverse']!.value as Matrix4).copy(camera.projectionMatrixInverse);
      draw(...args);
    };
  }
  // The OutputPass's material is raw GLSL ES 1.00 (no `textureSize`): the texel is a uniform, set with the size (`setSize`).
  output.uniforms['uTexel'] = { value: new Vector2(1 / Math.max(1, size.x * ratio), 1 / Math.max(1, size.y * ratio)) };
  output.material.needsUpdate = true;
  composer.addPass(output);
  // DO NOT build the passes' programs ahead here, nor set the OutputPass's state and defines before its first draw: with that warm-up the whole picture
  // came out washed out (18 % of the district's pixels changed against the approved look; bisected to 80074433, and the picture back with it removed, 2026-10-22).
  // Each pass told to the lab's observer when one is set (`PostPassHook`).
  for (const [pass, name] of [[scenePass, 'scene'], [gtao, 'gtao'], [canyon?.pass, 'canyon'], [bloom, 'bloom'], [air, 'atmosphere'], [smaa, 'smaa'], [output, 'output']] as [Pass | null | undefined, string][]) {
    if (!pass) continue;
    const draw = pass.render.bind(pass);
    pass.render = (...args: Parameters<Pass['render']>) => {
      const hook = scene.userData[POST_PASS_HOOK] as PostPassHook | undefined;
      if (!hook) { draw(...args); return; }
      hook.before(name);
      try { draw(...args); } finally { hook.after(name); }
    };
  }

  /** The sun's share of the light on the ground (`setDirectShare`), until it is known. */
  let directShare = DIRECT_SHARE;
  /** How dark it is (`setNight`): the bloom is drawn only in the dark. */
  let night = 0;
  /** The passes the effects panel left on (`setSwitches`). */
  let switches: PostSwitches = ALL_EFFECTS_ON;

  return {
    enabled: true,
    target: sceneTarget,
    ready: Promise.allSettled(warming).then(() => undefined),
    // The occlusion's two targets too (its `normalRenderTarget` is never bound once `setGBuffer` is handed the scene's depth: no GPU memory)
    // The bloom's bright pass and its five mips each way (made at construction, on or off) and SMAA's edges and weights (r186 `_edgesRT`, `_weightsRT`)
    targets: () => [sceneTarget, composer.renderTarget1, composer.renderTarget2, ...(gtao ? [gtao.gtaoRenderTarget, gtao.pdRenderTarget] : []),
      bloom.renderTargetBright, ...bloom.renderTargetsHorizontal, ...bloom.renderTargetsVertical,
      ...(smaa ? [(smaa as unknown as { _edgesRT: WebGLRenderTarget })._edgesRT, (smaa as unknown as { _weightsRT: WebGLRenderTarget })._weightsRT] : [])],
    render(delta) {
      if (air) {
        camera.updateMatrixWorld();
        (air.uniforms['uProjectionInverse'] as { value: Matrix4 }).value.copy(camera.projectionMatrixInverse);
        (air.uniforms['uCameraWorld'] as { value: Matrix4 }).value.copy(camera.matrixWorld);
        // The air round the map is always drawn: the pass runs once it is built.
        air.enabled = airReady && switches.atmosphere;
      }
      if (gtao) gtao.enabled = switches.ambientOcclusion;
      if (canyon) canyon.pass.enabled = switches.canyonLight;
      bloom.enabled = night > 0.05 && switches.bloom;
      if (smaa) smaa.enabled = switches.smaa;
      (output.uniforms['uSharpen'] as { value: number }).value = switches.sharpen ? quality.sharpen : 0;
      composer.render(delta);
    },
    setNight(dark) {
      night = dark;
      bloom.enabled = dark > 0.05;
      bloom.strength = bloomStrength * Math.min(1, dark);
      if (air) (air.uniforms['uDark'] as { value: number }).value = dark;
    },
    setDirectShare(share) {
      if (Math.abs(share - directShare) < 0.005) return;
      directShare = share;
    },
    setSwitches(next) {
      switches = next;
    },
    followTown(cx, cy, solids, changed) {
      canyon?.follow(cx, cy, solids, changed);
    },
    setAtmosphere(sun, eyeShift = 0) {
      canyon?.setSun(sun, directShare);
      if (!air) return;
      const u = air.uniforms as Record<string, { value: unknown }>;
      u['uEyeShift']!.value = eyeShift;
      (u['uSunDir']!.value as Vector3).copy(sun).normalize();
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      // DO NOT size the bloom again in CSS pixels
      composer.setSize(width, height);
      sceneTarget.setSize(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio));
      (output.uniforms['uTexel']!.value as Vector2).set(1 / Math.max(1, width * pixelRatio), 1 / Math.max(1, height * pixelRatio));
    },
    dispose() {
      // After the programs built ahead are done (`warming`) - the canyon's is one of them.
      void Promise.allSettled(warming).then(disposeAll);
    },
  };
  function disposeAll(): void {
    canyon?.dispose();
    composer.dispose();
    target.dispose();
    sceneTarget.dispose();
    copyQuad.dispose();
    copyQuad.material.dispose();
    gtao?.dispose();
    bloom.dispose();
    smaa?.dispose();
    output.dispose();
    air?.dispose();
  }
}

/** The scene without the chain on a canvas with no multisampling: into a multisampled target three draws as it draws the canvas, then copied onto the canvas as it is. */
export function plainTarget(width: number, height: number, samples: number): WebGLRenderTarget {
  const target = new WebGLRenderTarget(width, height, {
    type: UnsignedByteType,
    colorSpace: SRGBColorSpace,
    // The reversed Z keeps its precision only in a float depth buffer.
    depthTexture: new DepthTexture(width, height, FloatType),
    samples,
  });
  // DO NOT tone map it after the transparent things are blended (a linear target and an OutputPass): three draws a target it takes for the XR layer as it draws the canvas, every material tone mapped and sRGB encoded, blended 8 bits a channel in sRGB (WebGLPrograms toneMapping and outputColorSpace).
  (target as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  // Kept as the shader wrote it, as the canvas keeps it: no sRGB storage decoding it on the copy (three's own XR targets are linear too, WebGLTextures forceLinearTransfer).
  target.texture.internalFormat = 'RGBA8';
  return target;
}

function plainChain(renderer: WebGLRenderer, scene: Scene, camera: Camera, first: DepthFirst | null): { target: WebGLRenderTarget; render(): void; setSize(width: number, height: number, pixelRatio: number): void; dispose(): void } {
  const size = renderer.getDrawingBufferSize(new Vector2());
  // Four samples: a browser's own for an antialiased canvas.
  const target = plainTarget(Math.max(1, size.x), Math.max(1, size.y), Math.min(4, renderer.capabilities.maxSamples));
  const copy = new FullScreenQuad(new ShaderMaterial({
    uniforms: { tDiffuse: { value: target.texture }, opacity: { value: 1 } },
    vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
    blending: NoBlending, depthTest: false, depthWrite: false, toneMapped: false,
  }));
  return {
    target,
    render() {
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderDepthFirst(renderer, scene, camera, first);
      renderer.setRenderTarget(null);
      copy.render(renderer);
      renderer.setRenderTarget(previous);
    },
    setSize(width, height, pixelRatio) {
      target.setSize(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio));
    },
    dispose() {
      target.dispose();
      copy.dispose();
      copy.material.dispose();
    },
  };
}

/** The sun's share of the light on the ground until it is known (`setDirectShare`). */
const DIRECT_SHARE = 0.62;

/** THE AIR round the map, on the image (no clouds and no fog since 2026-10-28, MISSION.md item 4): the backdrop where no scene is drawn, the haze by distance over it. */
const AIR = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProjectionInverse: { value: new Matrix4() },
    uCameraWorld: { value: new Matrix4() },
    uDark: { value: 0 },
    uSunDir: { value: new Vector3(0.5, 0.8, 0.3).normalize() },
    // How far in front of the camera the view's equivalent eye stands, units (`setAtmosphere`): 0 in perspective
    uEyeShift: { value: 0 },
    // The void round the map: its deep blue, the paler air towards the horizon, and the abyss below
    uSkyDeep: { value: new Color(0x0c1a2c) },
    uSkyGlow: { value: new Color(0x3d5a82) },
    uSkyLow: { value: new Color(0x0a1830) },
    // The sky seen from near the ground: pale at the horizon, deeper above.
    uSkyHorizon: { value: new Color(0x86bdf0) },
    uSkyHigh: { value: new Color(0x2a66c8) },
    // Below the map: a deep navy, never black (the player, 2026-10-09: "I do not want it black, it is dark blue")
    uAbyss: { value: new Color(0x0b1a33) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 uProjectionInverse;
    uniform mat4 uCameraWorld;
    uniform float uDark;
    uniform vec3 uSunDir;
    uniform float uEyeShift;
    uniform vec3 uSkyDeep;
    uniform vec3 uSkyGlow;
    uniform vec3 uSkyLow;
    uniform vec3 uSkyHorizon;
    uniform vec3 uSkyHigh;
    uniform vec3 uAbyss;
    varying vec2 vUv;
    ${DEPTH_GLSL}
    vec3 worldAt(vec2 uv, float depth) {
      vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depthToClipZ(depth), 1.0);
      return (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
    }
    float hash3(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float noise3(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0)), f.x), f.y),
        f.z);
    }
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      bool sky = depthIsBackground(depth);
      vec3 ro = worldAt(vUv, DEPTH_NEAR);
      vec3 hit = worldAt(vUv, sky ? depthNearlyFar() : depth);
      vec3 rd = normalize(hit - ro);
      float tScene = sky ? 1e7 : length(hit - ro);
      vec3 colour = src.rgb;
      // The air between the eye and what the pixel sees: from the view's
      // equivalent eye (\`uEyeShift\`). Measured from the orthographic camera,
      // 5 000 units back whatever the zoom
      float tAir = max(tScene - uEyeShift, 0.0);
      vec3 eye = ro + rd * uEyeShift;
      // THE AIR round the map while it is built, seen as a model over the void (the player, 2026-10-07).
      {
        float zen = acos(clamp(abs(rd.y), 0.0, 1.0));
        float air = 1.0 / (cos(zen) + 0.15 * pow(max(93.885 - degrees(zen), 1e-3), -1.253));
        float glow = 1.0 - exp(-air * 0.12);
        float sunSide = pow(max(dot(rd, uSunDir), 0.0), 3.0);
        vec3 haze = mix(uSkyGlow, uSkyGlow * vec3(1.4, 1.18, 0.9), sunSide * 0.6) * (1.0 - 0.85 * uDark);
        // Brought down near the ground the view gets a SKY: pale blue at the horizon deepening upwards
        float low = 1.0 - smoothstep(${m(100).toFixed(2)}, ${m(260).toFixed(2)}, ro.y);
        vec3 horizon = mix(uSkyHorizon, uSkyHorizon * vec3(1.12, 1.04, 0.92), sunSide * 0.5) * (1.0 - 0.85 * uDark);
        vec3 overhead = uSkyHigh * (1.0 - 0.7 * uDark);
        haze = mix(haze, horizon, low);
        if (sky) {
          vec3 backdrop = mix(uSkyDeep, haze, glow);
          backdrop = mix(backdrop, mix(horizon, overhead, smoothstep(0.0, 0.5, rd.y)), low * step(0.0, rd.y));
          // Below the horizon: a deeper blue at once, going down into the earth's own dark brown (the player, 2026-10-07).
          backdrop = mix(backdrop, uSkyLow, smoothstep(0.0, 0.3, -rd.y) * 0.85);
          backdrop = mix(backdrop, uAbyss, smoothstep(0.18, 0.8, -rd.y) * 0.9);
          // A faint veil of high haze, fixed in the sky.
          float veil = noise3(rd * 4.0 + 3.1) * 0.6 + noise3(rd * 9.0 + 7.7) * 0.4;
          colour = backdrop * (0.88 + 0.24 * veil);
        } else {
          // By the real distance, as air is: the whole map seen from afar takes it on, ground seen close up none
          const float HAZE_BETA = ${perM(3.912 / 30000).toExponential(6)};
          const float HAZE_H = ${m(1200).toFixed(2)};
          float hazeY0 = max(eye.y, 0.0), hazeY1 = max(eye.y + rd.y * tAir, 0.0);
          float hazeDepth = abs(rd.y) > 1e-4
            ? HAZE_H * (exp(-hazeY1 / HAZE_H) - exp(-hazeY0 / HAZE_H)) / -rd.y
            : tAir * exp(-hazeY0 / HAZE_H);
          float amount = (1.0 - exp(-HAZE_BETA * max(hazeDepth, 0.0))) * 0.55;
          colour = mix(colour, haze * (1.0 + 0.6 * glow), amount);
        }
      }
      gl_FragColor = vec4(colour, src.a);
    }
  `,
};

/** A film grade on the display image: a gentle S-curve of contrast, colour kept rich without neon */
const GRADED_OUTPUT_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D tDiffuse;
  uniform float uSharpen;
  uniform highp sampler2D tDepth;
  uniform mat4 uProjectionInverse;
  uniform vec2 uSharpSpan;
  uniform vec2 uTexel;
  ${DEPTH_GLSL}

  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>

  varying vec2 vUv;

  // The OutputPass's own work: tone mapping and colour space, by its defines.
  vec4 display(vec4 c) {
    #ifdef LINEAR_TONE_MAPPING
      c.rgb = LinearToneMapping( c.rgb );
    #elif defined( REINHARD_TONE_MAPPING )
      c.rgb = ReinhardToneMapping( c.rgb );
    #elif defined( CINEON_TONE_MAPPING )
      c.rgb = CineonToneMapping( c.rgb );
    #elif defined( ACES_FILMIC_TONE_MAPPING )
      c.rgb = ACESFilmicToneMapping( c.rgb );
    #elif defined( AGX_TONE_MAPPING )
      c.rgb = AgXToneMapping( c.rgb );
    #elif defined( NEUTRAL_TONE_MAPPING )
      c.rgb = NeutralToneMapping( c.rgb );
    #elif defined( CUSTOM_TONE_MAPPING )
      c.rgb = CustomToneMapping( c.rgb );
    #endif
    #ifdef SRGB_TRANSFER
      c = sRGBTransferOETF( c );
    #endif
    return c;
  }

  vec3 viewAt(vec2 uv, float depth) {
    vec4 v = uProjectionInverse * vec4(uv * 2.0 - 1.0, depthToClipZ(depth), 1.0);
    return v.xyz / v.w;
  }
  // Where the image may be sharpened, 1 to 0: the ground a pixel spans across, small enough (none on the background).
  float sharpMask() {
    float depth = texture2D(tDepth, vUv).r;
    if (depth == DEPTH_FAR) return 0.0;
    float span = length(viewAt(vUv + vec2(uTexel.x, 0.0), depth) - viewAt(vUv, depth));
    return 1.0 - smoothstep(uSharpSpan.x, uSharpSpan.y, span);
  }

  void main() {
    vec4 src = display(texture2D(tDiffuse, vUv));
    vec3 c = src.rgb;
    // SHARPENING, AMD FidelityFX CAS (ffx_cas.h, the sharpen-only path)
    float sharpen = uSharpen > 0.0 ? uSharpen * sharpMask() : 0.0;
    if (sharpen > 0.0) {
      vec2 texel = uTexel;
      // CAS works on the picture as it is seen (display space): DO NOT round-trip every tap through pow(2.2)/pow(1/2.2) - ten powers a pixel, five of them on the centre - for the same result.
      vec3 cl = c;
      vec3 b = display(texture2D(tDiffuse, vUv + vec2(0.0, -texel.y))).rgb;
      vec3 d = display(texture2D(tDiffuse, vUv + vec2(-texel.x, 0.0))).rgb;
      vec3 f = display(texture2D(tDiffuse, vUv + vec2(texel.x, 0.0))).rgb;
      vec3 h = display(texture2D(tDiffuse, vUv + vec2(0.0, texel.y))).rgb;
      vec3 mn = min(min(min(d, cl), min(f, b)), h);
      vec3 mx = max(max(max(d, cl), max(f, b)), h);
      vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
      float w = amp.g * (-1.0 / mix(8.0, 5.0, uSharpen));
      cl = clamp(((b + d + f + h) * w + cl) / (1.0 + 4.0 * w), 0.0, 1.0);
      c = mix(c, cl, sharpen / max(uSharpen, 1e-4));
    }
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Contrast, an S round the middle grey.
    c = mix(c, smoothstep(0.0, 1.0, c), 0.25);
    // Vibrance: the dull colours gain more than the vivid.
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
    float sat = mx - mn;
    c = mix(vec3(l), c, 1.0 + 0.3 * (1.0 - sat));
    // Split toning: warm highlights, cool shadows.
    c += mix(vec3(0.0), vec3(0.02, 0.008, -0.014), smoothstep(0.15, 0.85, l));
    // Vignette.
    vec2 d = vUv - 0.5;
    c *= mix(1.0, 0.78, smoothstep(0.3, 0.85, dot(d, d) * 2.4));
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
  }
`;

/** DO NOT build a program for each of the bloom's blur radii: three's UnrealBloomPass (r186 `_getSeparableBlurMaterial`) writes the radius's pairs of taps into a define (`KERNEL_PAIRS` 3, 5, 7, 9, 11), five programs for one shader (the ~300 programs, prova motor-programas, 2026-10-18). One program for all: the arrays at the widest's length, padded with nothing, and the loop stopped at each one's own pairs (a uniform), the same taps summed in the same order. */
export function shareBloomBlur(materials: readonly ShaderMaterial[]): void {
  const most = Math.max(...materials.map((m) => Number(m.defines['KERNEL_PAIRS'])));
  for (const material of materials) {
    const pairs = Number(material.defines['KERNEL_PAIRS']);
    const offsets = material.uniforms['gaussianOffsets']!.value as number[];
    const weights = material.uniforms['gaussianWeights']!.value as number[];
    material.uniforms['gaussianOffsets']!.value = [...offsets, ...new Array<number>(most - offsets.length).fill(0)];
    material.uniforms['gaussianWeights']!.value = [...weights, ...new Array<number>(most - weights.length).fill(0)];
    material.uniforms['uPairs'] = { value: pairs };
    material.defines['KERNEL_PAIRS'] = most;
    const loop = 'for ( int i = 0; i < KERNEL_PAIRS; i ++ ) {';
    if (!material.fragmentShader.includes(loop)) throw new Error('[postprocess] the bloom blur shader is not the one shared (three r186 UnrealBloomPass)');
    material.fragmentShader = material.fragmentShader
      .replace('uniform float centerWeight;', 'uniform float centerWeight; uniform int uPairs;')
      .replace(loop, `${loop} if ( i >= uPairs ) break;`);
    material.needsUpdate = true;
  }
}
