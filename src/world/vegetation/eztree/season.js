// Seasons: what a plant's leaves do over the year, and how it wears as it dies.
//
// The year is `options.season.time`, a fraction from 0 to 1:
//   0 midwinter, 0.25 spring, 0.5 midsummer, 0.75 autumn (and 1 = 0, midwinter again)
//
// Everything here is a pure function of the options and a leaf's index: no
// random numbers are drawn, so turning the seasons never changes a tree's shape.

export const SeasonResponse = {
  // Deciduous growth sheds its leaves, evergreen growth keeps them
  Auto: 'auto',
  // Buds in spring, turns in autumn, bare in winter
  Deciduous: 'deciduous',
  // Keeps its leaves, a little duller in winter
  Evergreen: 'evergreen',
  // No seasons (the wet tropics, sea life)
  None: 'none',
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * A repeatable pseudo-random number in [0, 1) for an index
 * @param {number} index
 * @param {number} salt Distinct salts give independent numbers
 */
export function hash01(index, salt = 0) {
  let h = (Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * How wintry a time of year is: 1 at midwinter, 0 from spring to autumn
 * @param {number} time Fraction of the year (0 = midwinter)
 */
export function winterness(time) {
  const t = time - Math.floor(time);
  return smooth(0.6, 1.0, 0.5 + 0.5 * Math.cos(2 * Math.PI * t));
}

/**
 * The state of the foliage for the tree's options
 * @param {import('./options').default} options
 * @returns {{
 *  active: boolean,   // whether leaves need per-leaf season data at all
 *  foliage: number,   // share of the leaves on the tree (0 bare .. 1 full)
 *  spring: number,    // fresh spring green (0..1)
 *  autumn: number,    // progress of the autumn turn (0..1)
 *  fall: number,      // progress of the leaf fall (0..1)
 *  blossom: number,   // share of the leaves that are blossom right now
 *  dull: number,      // winter dullness of evergreen foliage (0..1)
 *  health: number,    // 1 healthy .. 0 dead
 * }}
 */
export function seasonState(options) {
  const season = options.season ?? {};
  const health = clamp01(options.health ?? 1);
  const state = {
    active: health < 1,
    foliage: 1,
    spring: 0,
    autumn: 0,
    fall: 0,
    blossom: 0,
    dull: 0,
    health,
  };
  if (!season.enabled) return state;

  let response = season.response ?? SeasonResponse.Auto;
  if (response === SeasonResponse.Auto) {
    response =
      options.type === 'evergreen'
        ? SeasonResponse.Evergreen
        : SeasonResponse.Deciduous;
  }
  if (response === SeasonResponse.None) return state;

  const time = season.time ?? 0.5;
  const t = time - Math.floor(time);
  state.active = true;

  if (response === SeasonResponse.Evergreen) {
    state.dull = 0.3 * winterness(t);
    return state;
  }

  const leafOut = smooth(0.16, 0.3, t);
  state.fall = smooth(0.8, 0.93, t);
  state.foliage = leafOut * (1 - state.fall);
  state.spring = leafOut * (1 - smooth(0.28, 0.42, t));
  state.autumn = smooth(0.62, 0.82, t);
  state.blossom =
    clamp01(season.blossom ?? 0) * smooth(0.15, 0.2, t) * (1 - smooth(0.27, 0.34, t));
  return state;
}

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const DEAD_LEAF = rgb(0x7a5a32);
const WINTER_GREEN = rgb(0x56603f);

/**
 * What one leaf does in the given state
 * @param {ReturnType<typeof seasonState>} state
 * @param {import('./options').default} options
 * @param {number} index The leaf's index in the skeleton
 * @returns {{ keep: boolean, color: number[], mix: number }} Whether the leaf
 * is on the tree, and the colour it has turned (blended over its own colour
 * by `mix`, 0 to 1)
 */
export function leafSeason(state, options, index) {
  const season = options.season ?? {};
  const rank = hash01(index, 1); // order of budding and falling
  const turn = hash01(index, 2); // how early this leaf turns
  const pick = hash01(index, 3); // which colour it turns, whether it is blossom

  // Blossom: opens on the bare twigs before the leaves, then gives way to them
  if (pick < state.blossom) {
    return { keep: true, color: rgb(season.blossomTint ?? 0xffd7e8), mix: 0.95 };
  }

  const keep = rank < state.foliage * state.health * state.health;
  let color = [1, 1, 1];
  let mix = 0;

  if (state.autumn > 0) {
    const tints = season.autumnTints ?? [0xe0a020, 0xd2691e, 0xa8321e];
    const list = Array.isArray(tints) ? tints : Object.values(tints);
    const turned = clamp01(state.autumn * 1.7 - turn * 0.7);
    color = rgb(list[Math.min(list.length - 1, Math.floor(pick * list.length))]);
    mix = 0.95 * turned;
    // the last leaves wither brown before they drop
    const withered = clamp01(state.fall * 1.5 - turn * 0.5);
    color = color.map((c, k) => c + (DEAD_LEAF[k] - c) * withered * 0.8);
  } else if (state.spring > 0) {
    color = rgb(season.springTint ?? 0xb9d86a);
    mix = 0.6 * state.spring;
  } else if (state.dull > 0) {
    color = WINTER_GREEN;
    mix = state.dull;
  }

  // A dying tree's remaining leaves are brown
  const dying = (1 - state.health) * 0.85;
  if (dying > 0) {
    color = color.map((c, k) => (c * mix + DEAD_LEAF[k] * dying) / Math.max(1e-6, mix + dying));
    mix = clamp01(mix + dying);
  }

  return { keep, color, mix };
}

/**
 * Whether a twig (a branch of the last level) is still on a tree of the given
 * health: a dying tree sheds its fine branches
 * @param {number} health 1 healthy .. 0 dead
 * @param {number} index The branch's index in the skeleton
 */
export function twigAlive(health, index) {
  if (health >= 1) return true;
  return hash01(index, 7) < 1 - 0.75 * (1 - clamp01(health));
}

/**
 * The bark of a tree of the given health: dead wood bleaches to grey
 * @param {number} tint The bark tint (0xRRGGBB)
 * @param {number} health 1 healthy .. 0 dead
 * @returns {number} 0xRRGGBB
 */
export function barkTint(tint, health) {
  const k = 0.7 * (1 - clamp01(health));
  if (k <= 0) return tint;
  const from = rgb(tint);
  const to = rgb(0xa39d92);
  const c = from.map((v, i) => Math.round(255 * (v + (to[i] - v) * k)));
  return (c[0] << 16) | (c[1] << 8) | c[2];
}
