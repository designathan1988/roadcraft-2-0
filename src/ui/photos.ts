/**
 * THE INTERFACE'S PHOTOS, TAKEN ONCE (`scripts/interface-photos.mjs`, on the lab page that never starts the game; `lab/interfacePhotos.ts`):
 * one PNG an option of a menu - the Builder's models and parts, the finishes, the plan shapes, the road classes, the road catalogue's roads -
 * shown by the menu as it is. NOTHING of the interface is drawn as it opens (`eslint-rules/no-live-interface.js` refuses it).
 */
const FILES = import.meta.glob<string>('./photos/*/*.png', { eager: true, query: '?url', import: 'default' });

/** The shelves photographed, each its own folder. */
export type PhotoShelf = 'builder' | 'finish' | 'plan' | 'roadClass' | 'road';

/** An option's file name: its id with the characters a file name cannot hold written out (`lot:`, `city:`). */
const photoFile = (id: string): string => `${id.replace(/[^A-Za-z0-9_-]/g, (c) => `~${c.charCodeAt(0).toString(16)}`)}.png`;

/** The URL of an option's photo; none for an option with nothing to photograph (it keeps its glyph). */
export function interfacePhoto(shelf: PhotoShelf, id: string): string | undefined {
  return FILES[`./photos/${shelf}/${photoFile(id)}`];
}

/** An option's photo that every build has (`tests/ui/interfacePhotos.spec.ts` holds the set whole); its absence is a defect, told by name. */
export function requiredPhoto(shelf: PhotoShelf, id: string): string {
  const url = interfacePhoto(shelf, id);
  if (!url) throw new Error(`No photo of ${shelf} "${id}" (src/ui/photos/${shelf}/${photoFile(id)}): run \`npm run photos\``);
  return url;
}
