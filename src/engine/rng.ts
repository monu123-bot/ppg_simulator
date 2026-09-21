/**
 * Deterministic, seedable RNG utilities.
 *
 * Every stochastic element of the simulator draws from one of these so a given
 * seed reproduces a session sample-for-sample. That matters for a teaching tool:
 * you can change one pipeline parameter and diff the result against an identical
 * physiological input.
 */

/** mulberry32 — small, fast, good enough statistically for signal synthesis. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal deviate, mean 0 / sd 1. */
export function makeGaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return function normal(): number {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

/**
 * Voss–McCartney pink (1/f) noise generator.
 *
 * Heart-rate variability has a well-documented 1/f spectral component across the
 * VLF/LF bands (Kobayashi & Musha 1982); white noise alone produces a tachogram
 * that looks obviously synthetic in a Poincare plot and has no VLF power.
 */
export class PinkNoise {
  private rows: Float64Array;
  private runningSum = 0;
  private counter = 0;
  private readonly octaves: number;

  constructor(private readonly rng: () => number, octaves = 12) {
    this.octaves = octaves;
    this.rows = new Float64Array(octaves);
    for (let i = 0; i < octaves; i++) {
      this.rows[i] = this.rng() * 2 - 1;
      this.runningSum += this.rows[i];
    }
  }

  next(): number {
    this.counter = (this.counter + 1) >>> 0;
    // Index of the lowest set bit decides which octave row is refreshed.
    let n = this.counter;
    let row = 0;
    while ((n & 1) === 0 && row < this.octaves - 1) {
      n >>>= 1;
      row++;
    }
    this.runningSum -= this.rows[row];
    this.rows[row] = this.rng() * 2 - 1;
    this.runningSum += this.rows[row];
    // Normalised to roughly unit variance.
    return this.runningSum / Math.sqrt(this.octaves);
  }
}

/** First-order low-pass on a random walk — used for slow, drifty parameters. */
export class DriftSource {
  private value = 0;
  constructor(
    private readonly gauss: () => number,
    private readonly alpha: number,
    private readonly scale: number,
  ) {}

  next(): number {
    this.value = this.value * (1 - this.alpha) + this.gauss() * this.alpha;
    return this.value * this.scale;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Map x from [inLo,inHi] onto [outLo,outHi], clamped at both ends. */
export function remap(x: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  if (inHi === inLo) return outLo;
  return lerp(outLo, outHi, clamp((x - inLo) / (inHi - inLo), 0, 1));
}
