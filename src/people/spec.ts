import cast from './cast.json';

/**
 * A person as the game and its saves know them: a name, a mood and the body of the cast they are drawn as (`cast.json`, the sixteen
 * bodies of `public/models/citizens/people`). Older saves carry what this record no longer has: a body id of the cast's former names, or
 * the body sliders and outfit of the old Person Creator. A person saved with either opens as the body of the cast it stands for, or the
 * nearest one (`normalizePerson`).
 */
export interface PersonSpec {
  readonly id: number;
  readonly name: string;
  /** Resting expression, -1 subdued through 0 neutral to 1 cheerful. */
  readonly mood?: number;
  /** The cast's body (`cast.json` id). */
  readonly model: string;
}

interface CastRow { readonly id: string; readonly wardrobe: string; readonly ageBand: string; readonly gender: string }
const CAST: readonly CastRow[] = cast as CastRow[];

/** The body ids older saves carry (the cast's names until 2026-10-24) and the body each one is named now: the same body. */
export const FORMER_BODY_IDS: Readonly<Record<string, string>> = {
  mh_34: 'female-adult-casual', mh_55: 'female-adult-sport-casual', mh_44: 'female-adult-smart-casual', mh_48: 'female-adult-business',
  mh_14: 'female-young-casual', mh_64: 'female-senior-casual', mh_00: 'female-child-casual', mh_08: 'female-child-sport-casual',
  mh_38: 'male-adult-casual', mh_59: 'male-adult-sport-casual', mh_45: 'male-adult-smart-casual', mh_51: 'male-adult-business',
  mh_18: 'male-young-casual', mh_67: 'male-senior-casual', mh_04: 'male-child-casual', mh_11: 'male-child-sport-casual',
};

/** The age an old save's age slider (0..1) stood for, in years (its knots: 1, 11, 18, 25 and 90 years). */
const AGE_KNOTS: readonly (readonly [number, number])[] = [[0, 1], [0.1875, 11], [0.44, 18], [0.5, 25], [1, 90]];
function yearsOf(slider: number): number {
  const a = Math.min(1, Math.max(0, slider));
  for (let i = 1; i < AGE_KNOTS.length; i++) {
    const [a0, y0] = AGE_KNOTS[i - 1]!, [a1, y1] = AGE_KNOTS[i]!;
    if (a <= a1) return y0 + ((a - a0) / (a1 - a0)) * (y1 - y0);
  }
  return 90;
}

/** The cast's age band of an age in years, as the cast was chosen (children 6-12, the young 17-28, adults 30-58, seniors 66-84). */
const bandOf = (years: number): string => (years < 15 ? 'child' : years < 29 ? 'young' : years < 62 ? 'adult' : 'senior');

/** The wardrobe an old save's outfit name reads as: a suit or a dress for business, a sports suit for sport, everyday clothes otherwise. */
function wardrobeOf(outfit: unknown): string {
  const name = typeof outfit === 'string' ? outfit : '';
  if (/elegant|cocktail|_suit_|business/.test(name)) return 'business';
  if (/sport/.test(name)) return 'sport-casual';
  return 'casual';
}

/** The body of the cast nearest a person an old save describes by sliders: their sex, age band and wardrobe, in that order of weight. */
function nearestBody(body: Record<string, unknown>, look: Record<string, unknown>): string {
  const gender = typeof body['gender'] === 'number' && body['gender'] >= 0.5 ? 'm' : 'f';
  const band = bandOf(yearsOf(typeof body['age'] === 'number' ? body['age'] : 0.5));
  const wardrobe = wardrobeOf(look['outfit']);
  const score = (c: CastRow): number => (c.gender === gender ? 4 : 0) + (c.ageBand === band ? 2 : 0) + (c.wardrobe === wardrobe ? 1 : 0);
  return CAST.reduce((best, c) => (score(c) > score(best) ? c : best)).id;
}

/** The body a saved id names: the cast's own, or the one a former id is now; null when it names none. */
function castBody(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const id = Object.hasOwn(FORMER_BODY_IDS, model) ? FORMER_BODY_IDS[model]! : model;
  return CAST.some((c) => c.id === id) ? id : null;
}

/** A person read from outside (a save, a file): every field brought into range, every unknown dropped; a body outside the cast refused. */
export function normalizePerson(raw: unknown): PersonSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['id'] !== 'number' || !Number.isInteger(o['id']) || o['id'] < 0 || o['id'] > 2 ** 31) return null;
  const record = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null ? x as Record<string, unknown> : {});
  const model = castBody(o['model']) ?? nearestBody(record(o['body']), record(o['look']));
  return {
    id: o['id'],
    name: typeof o['name'] === 'string' ? o['name'].slice(0, 40) : '',
    ...(typeof o['mood'] === 'number' && Number.isFinite(o['mood']) ? { mood: Math.max(-1, Math.min(1, o['mood'])) } : {}),
    model,
  };
}
