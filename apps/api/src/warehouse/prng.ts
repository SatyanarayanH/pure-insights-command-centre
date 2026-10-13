/** Seeded pseudo-random numbers. Everything the simulators produce must be reproducible
 *  byte-for-byte, so nothing here touches Math.random or the clock. */

/** FNV-1a: turns a string key into a 32-bit seed. */
export function hashSeed(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  uniform(min: number, max: number): number;
  /** Integer in [0, n). */
  int(n: number): number;
  /** Standard normal (Box–Muller). */
  normal(): number;
  /** exp(mu + sigma * N(0, 1)). */
  logNormal(mu: number, sigma: number): number;
  /** Index drawn in proportion to `weights`. */
  weighted(weights: readonly number[]): number;
  hex(length: number): string;
}

/** mulberry32: small, fast, and good enough for simulation. */
export function createRng(key: string): Rng {
  let state = hashSeed(key);
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (): number => {
    const u = Math.max(next(), 1e-12);
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return {
    next,
    uniform: (min, max) => min + (max - min) * next(),
    int: (n) => Math.floor(next() * n),
    normal,
    logNormal: (mu, sigma) => Math.exp(mu + sigma * normal()),
    weighted: (weights) => {
      const total = weights.reduce((a, b) => a + b, 0);
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]!;
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    hex: (length) => {
      let out = '';
      while (out.length < length)
        out += Math.floor(next() * 0x100000000)
          .toString(16)
          .padStart(8, '0');
      return out.slice(0, length);
    },
  };
}
