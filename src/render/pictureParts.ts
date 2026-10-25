import type { BufferGeometry, Material, Side, Texture } from 'three';

/**
 * The part of a model an impostor takes its pictures of: shared by the pictures (`plantImpostors.ts`) and the materials that take them
 * (`impostorBake.ts`), so neither imports the other.
 */

/** One part of a model to take pictures of, as its own material draws it. */
export interface PicturePart {
  /** Its position and normal; `color` where it has vertex colours; `uv` where it has a `map`; `aCorner` for leaf cards (`billboard`). */
  readonly geometry: BufferGeometry;
  /** Its colour texture (sRGB, read linear), times its vertex colours; none: its vertex colours alone (white where it has none). */
  readonly map?: Texture | null;
  /** Texels of the map with less alpha than this are cut, from the colour, the normal and the shadow's outline alike (0: none). */
  readonly alphaTest?: number;
  /** Its normal: the geometry's own, interpolated (`vertex`; turned to the eye on a two-sided part), or each face's (`faceted`, a flat-shaded body). */
  readonly normals: 'vertex' | 'faceted';
  /** The side its material draws; its shadow's outline is taken with the side three r186 casts it with (`WebGLShadowMap` shadowSide: FrontSide by its back faces). */
  readonly side: Side;
  /** Leaf cards: each corner put off its card's centre in the view by `aCorner` (`lowPolyTrees.ts`). */
  readonly billboard?: boolean;
  /** Whether it throws the model's shadow. */
  readonly casts: boolean;
  /** The material the part is drawn with near: its pictures taken with it (`bakeWithMaterial`) - its colour as that material makes it, after
   *  every patch of its own (its vertex colours, its maps, its alpha test, a thin part's tone), its normal as it shades - in place of the
   *  plain colour and normal above (`map`, `alphaTest`, `normals` then unread; `side` its own). */
  readonly material?: Material;
  /** A thin part pre-filtered at draw time (`buildings/thinParts.ts` prefilterThinParts: its bar's width, metres, and the tone behind it): its
   *  raw colour and these taken into the pictures, the tone applied where the picture is drawn, by its own pixel there (`COLOUR_MAP_STILL`). */
  readonly thin?: { readonly bar: number; readonly behind: number };
}
