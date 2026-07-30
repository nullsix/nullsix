// MARROW — seedable PRNG (mulberry32).
//
// Two flavours of the same generator:
//   * pure/state-passing (`nextFloat`, `nextInt`, `shuffle`, `pick`) — what the engine uses,
//     so the whole PRNG lives in game state as one JSON-safe int32 (`state.rng`).
//   * stateful convenience (`createRng`) — for sims, the UI, anything outside the engine.
//
// Imports nothing (layering law: rng.js is a leaf).

const UINT32 = 4294967296;

/**
 * Normalise any seed (number or string) into the int32 the generator carries as state.
 */
export function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed | 0;
  const str = String(seed);
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * mulberry32, pure. -> { value: float in [0,1), rngState: next int32 state }
 */
export function nextFloat(rngState) {
  const a = (rngState + 0x6d2b79f5) | 0;
  let t = a ^ (a >>> 15);
  t = Math.imul(t, t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / UINT32, rngState: a };
}

/**
 * Pure integer in [0, n). n <= 0 yields 0 and still burns a step (keeps call sites simple).
 */
export function nextInt(rngState, n) {
  const r = nextFloat(rngState);
  const value = n > 0 ? Math.floor(r.value * n) : 0;
  return { value, rngState: r.rngState };
}

/**
 * Pure Fisher-Yates. Returns a new array; the input is untouched.
 */
export function shuffle(array, rngState) {
  const shuffled = array.slice();
  let s = rngState;
  for (let i = shuffled.length - 1; i > 0; i--) {
    const r = nextInt(s, i + 1);
    s = r.rngState;
    const j = r.value;
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return { shuffled, rngState: s };
}

/**
 * Pure uniform pick. -> { value, index, rngState }; empty array gives value undefined.
 */
export function pick(array, rngState) {
  const r = nextInt(rngState, array.length);
  return { value: array[r.value], index: r.value, rngState: r.rngState };
}

/**
 * Stateful generator: rng() -> float, rng.int(n), rng.shuffle(arr), rng.state (current int32).
 * Handy outside the engine; the engine itself never holds a closure like this because its
 * state has to survive JSON round-trips.
 */
export function createRng(seed) {
  let s = hashSeed(seed);
  const rng = () => {
    const r = nextFloat(s);
    s = r.rngState;
    return r.value;
  };
  rng.int = (n) => {
    const r = nextInt(s, n);
    s = r.rngState;
    return r.value;
  };
  rng.shuffle = (arr) => {
    const r = shuffle(arr, s);
    s = r.rngState;
    return r.shuffled;
  };
  rng.pick = (arr) => {
    const r = pick(arr, s);
    s = r.rngState;
    return r.value;
  };
  Object.defineProperty(rng, 'state', { get: () => s });
  return rng;
}
