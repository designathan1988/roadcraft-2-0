import { DEFAULT_BRUSH, type ElementBrush, type ElementKind } from '@world/elements';
import { LANDSCAPE_KINDS, type LandscapeKind, type SignType } from '@world/landscape';
import { POLE_KINDS, POLE_LAMP_MODES, type PoleKind, type PoleLampMode } from '@world/utilities';
import { PAINT_KINDS, type PaintKind } from '@world/terrainPaint';
import { DEFAULT_TREE_BRUSH, type TreeBrush, type TreeKind } from '@world/trees';

/** What the player has chosen in the tools' panels and the game reads when the tool acts */

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  } catch {
    // Not kept: the default stands.
  }
  return fallback;
}

function keep(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Not kept between sessions; it still applies now.
  }
}

const KIND_KEY = 'roadcraft.streetscapeKind';
let kind: LandscapeKind = stored(KIND_KEY, LANDSCAPE_KINDS, 'tree');

export function streetscapeKind(): LandscapeKind {
  return kind;
}

export function setStreetscapeKind(next: LandscapeKind): void {
  kind = next;
  keep(KIND_KEY, next);
}

const LAMP_KEY = 'roadcraft.poleLamps';
const POLE_KIND_KEY = 'roadcraft.poleKind';

/** What the pole tool builds, as the player chose it in its panel: the kind of pole - urban (the arm over the street, the secondary
 *  rack, the light under the wires) or rural - and the street lights on them; kept between sessions. */
export interface PoleChoices {
  kind(): PoleKind;
  setKind(next: PoleKind): void;
  lamps(): PoleLampMode;
  setLamps(next: PoleLampMode): void;
}

/** The pole tool's choices, read from the last session: one made by the game (`main.ts`), handed to the tool and to its panel. */
export function createPoleChoices(): PoleChoices {
  let kind: PoleKind = stored(POLE_KIND_KEY, POLE_KINDS, 'urban');
  let lamps: PoleLampMode = stored(LAMP_KEY, POLE_LAMP_MODES, 'alternate');
  return {
    kind: () => kind,
    setKind(next) { kind = next; keep(POLE_KIND_KEY, next); },
    lamps: () => lamps,
    setLamps(next) { lamps = next; keep(LAMP_KEY, next); },
  };
}

/** What a click of the pole tool does: build a run, or remove the pole under it. */
export const POLE_TOOL_MODES = ['build', 'remove'] as const;
export type PoleToolMode = (typeof POLE_TOOL_MODES)[number];
let poleMode: PoleToolMode = 'build';

export function poleToolMode(): PoleToolMode {
  return poleMode;
}

/** Not kept between sessions: the tool always opens building. */
export function setPoleToolMode(next: PoleToolMode): void {
  poleMode = next;
}

/** The tree brush (Landscape > Terrain > Trees, `world/trees.ts`) */
export const TREE_MODES = ['plant', 'one', 'cut'] as const;
export type TreeMode = (typeof TREE_MODES)[number];
let treeModeNow: TreeMode = 'plant';
let treeKindNow: TreeKind = 'mixed';
const TREE_BRUSH_KEY = 'roadcraft.treeBrush';
let treeBrushNow: TreeBrush = (() => {
  try { return { ...DEFAULT_TREE_BRUSH, ...((JSON.parse(localStorage.getItem(TREE_BRUSH_KEY) ?? '{}') ?? {}) as Partial<TreeBrush>) }; } catch { return DEFAULT_TREE_BRUSH; }
})();
export function treeMode(): TreeMode { return treeModeNow; }
export function setTreeMode(next: TreeMode): void { treeModeNow = next; }
export function treeKind(): TreeKind { return treeKindNow; }
export function setTreeKind(next: TreeKind): void { treeKindNow = next; }
export function treeBrush(): TreeBrush { return treeBrushNow; }
export function setTreeBrush(change: Partial<TreeBrush>): void {
  treeBrushNow = { ...treeBrushNow, ...change };
  try { localStorage.setItem(TREE_BRUSH_KEY, JSON.stringify(treeBrushNow)); } catch { /* not kept */ }
}

/** The gully brush (Paisagem > Terreno > Ravinas, `world/gullies.ts`): cutting gullies, or wiping them away. Not kept between sessions. */
let gullyErasing = false;
export function gullyErase(): boolean {
  return gullyErasing;
}
export function setGullyErase(next: boolean): void {
  gullyErasing = next;
}

/** The element brush (Paisagem > Terreno > Elementos, `world/elements.ts`): which kind it lays, whether it lays or erases */
export type ElementBrushMode = 'lay' | 'eraseKind' | 'eraseAll';
let elementKindNow: ElementKind = 'stones';
let elementModeNow: ElementBrushMode = 'lay';
const ELEMENT_BRUSH_KEY = 'roadcraft.elementBrush';
let elementBrushes: Partial<Record<ElementKind, ElementBrush>> = (() => {
  try { return (JSON.parse(localStorage.getItem(ELEMENT_BRUSH_KEY) ?? '{}') ?? {}) as Partial<Record<ElementKind, ElementBrush>>; } catch { return {}; }
})();
export function elementKind(): ElementKind { return elementKindNow; }
export function elementMode(): ElementBrushMode { return elementModeNow; }
export function setElementMode(next: ElementBrushMode): void { elementModeNow = next; }
export function elementBrush(kind: ElementKind = elementKindNow): ElementBrush {
  return { ...DEFAULT_BRUSH[kind], ...(elementBrushes[kind] ?? {}) };
}
export function setElementBrush(change: Partial<ElementBrush>): void {
  elementBrushes = { ...elementBrushes, [elementKindNow]: { ...elementBrush(), ...change } };
  try { localStorage.setItem(ELEMENT_BRUSH_KEY, JSON.stringify(elementBrushes)); } catch { /* not kept */ }
}
export function setElementKind(next: ElementKind): void {
  elementKindNow = next;
}

const PAINT_KEY = 'roadcraft.paintKind';
let paint: PaintKind = stored(PAINT_KEY, PAINT_KINDS, 'sand');

/** The ground the terrain brush paints in its Paint mode. */
export function paintKind(): PaintKind {
  return paint;
}

export function setPaintKind(next: PaintKind): void {
  paint = next;
  keep(PAINT_KEY, next);
}

/** Total width of the roads the road tool lays, whole metres (the 1 m subgrid), or null for the class's own. */
let width: number | null = null;
const ROAD_WIDTH_RANGE = [6, 60] as const;

export function roadWidth(): number | null {
  return width;
}

export function setRoadWidth(next: number | null): void {
  width = next === null ? null : Math.max(ROAD_WIDTH_RANGE[0], Math.min(ROAD_WIDTH_RANGE[1], Math.round(next)));
}

/** The block grid the road tool lays in one click (`editor/blocks.ts`) */
export const blockGridChoice = { cols: 3, rows: 2, blockMetres: 100, angle: 0, armed: false };

/** What the sign tool puts down next: its kind and its words; and the next street name. */
export const signChoice: { type: SignType; text: string; streetName: string } = { type: 'stop', text: '', streetName: '' };

/** The demolish tool: knock a building down at once, or strike it (and streets) with a chosen force. */
export const strikeChoice: { mode: 'demolish' | 'strike' | 'shoot'; strength: number } = { mode: 'demolish', strength: 5 };

const ZONE_COLOUR_KEY = 'roadcraft.zoneColours';
let zoneColours = stored(ZONE_COLOUR_KEY, ['on', 'off'] as const, 'on') === 'on';
/** Whether zoned land is tinted with its use's colour outside the Zoning tool. */
export function zoneColoursShown(): boolean { return zoneColours; }
export function setZoneColoursShown(on: boolean): void { zoneColours = on; keep(ZONE_COLOUR_KEY, on ? 'on' : 'off'); }

const ROAD_GRID_KEY = 'roadcraft.roadGrid';
let roadGrid = stored(ROAD_GRID_KEY, ['on', 'off'] as const, 'off') === 'on';
const gridListeners = new Set<() => void>();
/** Whether the universal grid (`world/grid.ts`) is drawn over the whole map, with any tool */
export function roadGridShown(): boolean { return roadGrid; }
export function setRoadGridShown(on: boolean): void {
  roadGrid = on;
  keep(ROAD_GRID_KEY, on ? 'on' : 'off');
  for (const listener of gridListeners) listener();
}
/** Called whenever the grid is shown or hidden (the map redrawn). */
export function onRoadGridChange(listener: () => void): void { gridListeners.add(listener); }
