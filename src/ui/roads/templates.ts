import { KeptList } from '@core/keptList';
import type { RoadProfileSpec } from '@world/roads/profile';
import { type RoadTemplate, normalizeTemplate } from '@world/roads/templates';
import { unitFactor } from '@world/rescale';
import { METERS_PER_UNIT } from '@world/units';
import { catalogRoads } from '@world/roads/catalog';
import { profileSwatch } from './profileSwatch';

/** The player's own road templates, kept in this browser for every map, as Cities */
const kept = new KeptList('roadcraft.roadTemplates', 'road template');

/** A stored entry as a template in this build's unit, or null when this build cannot read it (it stays stored). */
const readTemplate = (raw: unknown): RoadTemplate | null => normalizeTemplate(inThisUnit(raw));

/** The same list while nothing was saved or deleted, so the catalogue can tell it is unchanged. */
export function savedTemplates(): readonly RoadTemplate[] {
  return kept.readShared(readTemplate);
}

/** Saves a template under a name, replacing one of the same name; null when it cannot be built or was not kept. */
export function saveTemplate(name: string, type: number, profile: RoadProfileSpec): RoadTemplate | null {
  const template = normalizeTemplate({ id: `user:${Date.now().toString(36)}`, name, type, profile });
  if (!template) return null;
  const written = kept.update((entries) => [...entries.filter((e) => readable(e)?.name !== template.name), withUnit(template)]);
  if (!written) return null;
  photographTemplate(template);
  return template;
}

/** The photos of the player's own roads, by template id: each taken once, as the road is saved. */
const photos = new KeptList('roadcraft.roadTemplatePhotos', 'road template photo');
interface TemplatePhoto { readonly id: string; readonly photo: string }
const readPhoto = (raw: unknown): TemplatePhoto | null =>
  (raw && typeof raw === 'object' && typeof (raw as TemplatePhoto).id === 'string' && typeof (raw as TemplatePhoto).photo === 'string' ? raw as TemplatePhoto : null);

/** The scale every road card is drawn at: the widest road the game ships (`lab/interfacePhotos.ts` takes the shipped cards' photos at it). */
export function catalogSpan(): number {
  return Math.max(...catalogRoads().map((r) => r.profile.elements.reduce((sum, e) => sum + e.width, 0)));
}
/** A road card's photo, px. */
export const CARD_PHOTO = { width: 124, height: 64 } as const;

/** The road's card photographed, once, as it is saved; a road saved before the photos were kept is photographed once, the first time its card
 *  is asked for (`templatePhoto`), and kept. DO NOT photograph a card as the catalogue opens. */
function photographTemplate(template: RoadTemplate): string {
  const photo = profileSwatch(template.profile, catalogSpan(), CARD_PHOTO.width, CARD_PHOTO.height);
  if (!photos.update((entries) => [...entries.filter((e) => readPhoto(e)?.id !== template.id), { id: template.id, photo }])) {
    console.warn(`[templates] the photo of the road "${template.name ?? template.id}" could not be kept`);
  }
  return photo;
}

/** The kept photo of one of the player's own roads. */
export function templatePhoto(template: RoadTemplate): string {
  return photos.readShared(readPhoto).find((p) => p.id === template.id)?.photo ?? photographTemplate(template);
}

/** Deletes one template, the rest as they were; false when nothing could be written. */
export function deleteTemplate(id: string): boolean {
  const gone = kept.update((entries) => entries.filter((e) => readable(e)?.id !== id));
  if (gone) photos.update((entries) => entries.filter((e) => readPhoto(e)?.id !== id));
  return gone;
}

/** An entry as read, for matching it by name or id; an entry that cannot be read matches nothing and stays. */
function readable(entry: unknown): RoadTemplate | null {
  try {
    return readTemplate(entry);
  } catch (error) {
    console.warn('[templates] a road template this build cannot read; kept as it is', error);
    return null;
  }
}

/** A template as stored: with the world unit its widths are in. */
const withUnit = (t: RoadTemplate): RoadTemplate & { unit: number } => ({ ...t, unit: METERS_PER_UNIT });

/** A stored template's widths in this build's unit; absent `unit`: 0.4 m, every template before 2026-10-10. */
function inThisUnit(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const t = raw as { unit?: unknown; profile?: { elements?: unknown } };
  const factor = unitFactor(t.unit);
  if (factor === 1 || !t.profile || !Array.isArray(t.profile.elements)) return raw;
  const elements = t.profile.elements.map((e: unknown) => (e && typeof e === 'object' && typeof (e as { width?: unknown }).width === 'number'
    ? { ...(e as object), width: (e as { width: number }).width * factor } : e));
  return { ...t, profile: { ...t.profile, elements } };
}
