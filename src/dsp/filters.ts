/**
 * Minimal IIR filter toolkit: biquad sections, Butterworth cascades designed by
 * bilinear transform, and the running statistics the later stages need.
 *
 * Everything here is causal and sample-by-sample, because that is the only kind
 * of filter a wearable can actually run. A zero-phase filtfilt would look better
 * in every screenshot and would be a lie about latency — so the UI reports the
 * group delay each stage costs instead.
 */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private c: BiquadCoeffs) {}

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  /**
   * Initialise the delay line to the steady state for a constant input `x`.
   *
   * Without this, the first sample of a PPG stream is a step from zero to the
   * optical DC level — tens of thousands of counts — and the high-pass rings
   * for several seconds at hundreds of times the pulse amplitude. Anything
   * downstream that adapts to signal level (a peak detector, an AGC) latches
   * onto that transient and never recovers.
   */
  prime(x: number): void {
    const { b1, b2 } = this.c;
    this.z2 = b2 * x;
    this.z1 = (b1 + b2) * x;
  }

  /** Direct Form II transposed — best numerical behaviour at low corner frequencies. */
  step(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + this.z1;
    this.z1 = b1 * x - a1 * y + this.z2;
    this.z2 = b2 * x - a2 * y;
    return y;
  }

  /** Magnitude response at frequency f for a sample rate fs. */
  magnitudeAt(f: number, fs: number): number {
    const w = (2 * Math.PI * f) / fs;
    const cw = Math.cos(w);
    const c2w = Math.cos(2 * w);
    const sw = Math.sin(w);
    const s2w = Math.sin(2 * w);
    const { b0, b1, b2, a1, a2 } = this.c;
    const numRe = b0 + b1 * cw + b2 * c2w;
    const numIm = -(b1 * sw + b2 * s2w);
    const denRe = 1 + a1 * cw + a2 * c2w;
    const denIm = -(a1 * sw + a2 * s2w);
    const num = Math.hypot(numRe, numIm);
    const den = Math.hypot(denRe, denIm) || 1e-12;
    return num / den;
  }
}

/** Butterworth pole Q values for an even-order section cascade. */
export function butterworthQs(order: number): number[] {
  const m = Math.floor(order / 2);
  const qs: number[] = [];
  for (let k = 0; k < m; k++) {
    qs.push(1 / (2 * Math.cos(((2 * k + 1) * Math.PI) / (2 * order))));
  }
  return qs;
}

export function lowpassCoeffs(fc: number, fs: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.min(fc, fs * 0.49)) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0,
    b1: (1 - cw) / a0,
    b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function highpassCoeffs(fc: number, fs: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.max(fc, 1e-4)) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0,
    b1: (-(1 + cw)) / a0,
    b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** A cascade of biquad sections behaving as one filter. */
export class Cascade {
  readonly sections: Biquad[];
  constructor(coeffs: BiquadCoeffs[]) {
    this.sections = coeffs.map((c) => new Biquad(c));
  }
  step(x: number): number {
    let y = x;
    for (let i = 0; i < this.sections.length; i++) y = this.sections[i].step(y);
    return y;
  }
  reset(): void {
    for (const s of this.sections) s.reset();
  }
  /** Prime the first section; later sections see zero in the steady state. */
  prime(x: number): void {
    if (this.sections.length) this.sections[0].prime(x);
  }
  magnitudeAt(f: number, fs: number): number {
    let m = 1;
    for (const s of this.sections) m *= s.magnitudeAt(f, fs);
    return m;
  }
}

export function butterworthLowpass(fc: number, fs: number, order: number): Cascade {
  return new Cascade(butterworthQs(order).map((q) => lowpassCoeffs(fc, fs, q)));
}

export function butterworthHighpass(fc: number, fs: number, order: number): Cascade {
  return new Cascade(butterworthQs(order).map((q) => highpassCoeffs(fc, fs, q)));
}

/** Band-pass as a high-pass cascade followed by a low-pass cascade. */
export class Bandpass {
  readonly hp: Cascade;
  readonly lp: Cascade;
  constructor(lowHz: number, highHz: number, fs: number, order: number) {
    this.hp = butterworthHighpass(lowHz, fs, order);
    this.lp = butterworthLowpass(highHz, fs, order);
  }
  step(x: number): number {
    return this.lp.step(this.hp.step(x));
  }
  reset(): void {
    this.hp.reset();
    this.lp.reset();
  }
  prime(x: number): void {
    this.hp.prime(x);
  }
  magnitudeAt(f: number, fs: number): number {
    return this.hp.magnitudeAt(f, fs) * this.lp.magnitudeAt(f, fs);
  }
  /**
   * Group delay at frequency f, in samples, by numerical differentiation of the
   * phase response. This is the latency the pipeline genuinely adds.
   */
  groupDelaySamples(f: number, fs: number): number {
    const eps = Math.max(0.01, f * 0.02);
    const p1 = this.phaseAt(Math.max(1e-3, f - eps), fs);
    const p2 = this.phaseAt(f + eps, fs);
    let dPhase = p2 - p1;
    while (dPhase > Math.PI) dPhase -= 2 * Math.PI;
    while (dPhase < -Math.PI) dPhase += 2 * Math.PI;
    const dW = (2 * Math.PI * 2 * eps) / fs;
    return -dPhase / dW;
  }
  private phaseAt(f: number, fs: number): number {
    const w = (2 * Math.PI * f) / fs;
    let re = 1;
    let im = 0;
    const all = [...this.hp.sections, ...this.lp.sections];
    for (const s of all) {
      const c = (s as unknown as { c: BiquadCoeffs }).c;
      const cw = Math.cos(w);
      const c2w = Math.cos(2 * w);
      const sw = Math.sin(w);
      const s2w = Math.sin(2 * w);
      const nRe = c.b0 + c.b1 * cw + c.b2 * c2w;
      const nIm = -(c.b1 * sw + c.b2 * s2w);
      const dRe = 1 + c.a1 * cw + c.a2 * c2w;
      const dIm = -(c.a1 * sw + c.a2 * s2w);
      const den = dRe * dRe + dIm * dIm || 1e-12;
      const hRe = (nRe * dRe + nIm * dIm) / den;
      const hIm = (nIm * dRe - nRe * dIm) / den;
      const tRe = re * hRe - im * hIm;
      const tIm = re * hIm + im * hRe;
      re = tRe;
      im = tIm;
    }
    return Math.atan2(im, re);
  }
}

/** Exponentially weighted moving average. */
export class Ewma {
  private y: number | null = null;
  constructor(private readonly alpha: number) {}
  step(x: number): number {
    this.y = this.y === null ? x : this.y + this.alpha * (x - this.y);
    return this.y;
  }
  get value(): number {
    return this.y ?? 0;
  }
  reset(): void {
    this.y = null;
  }
}

/** Simple boxcar moving average over a fixed window in samples. */
export class MovingAverage {
  private buf: Float64Array;
  private idx = 0;
  private sum = 0;
  private filled = 0;
  constructor(private readonly n: number) {
    this.buf = new Float64Array(Math.max(1, n));
  }
  step(x: number): number {
    this.sum -= this.buf[this.idx];
    this.buf[this.idx] = x;
    this.sum += x;
    this.idx = (this.idx + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
    return this.sum / this.filled;
  }
  reset(): void {
    this.buf.fill(0);
    this.sum = 0;
    this.filled = 0;
    this.idx = 0;
  }
  get windowSamples(): number {
    return this.n;
  }
}

/** Running mean and variance over a sliding window. */
export class RunningStats {
  private buf: Float64Array;
  private idx = 0;
  private filled = 0;
  constructor(size: number) {
    this.buf = new Float64Array(Math.max(2, size));
  }
  push(x: number): void {
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
  }
  get count(): number {
    return this.filled;
  }
  mean(): number {
    let s = 0;
    for (let i = 0; i < this.filled; i++) s += this.buf[i];
    return this.filled ? s / this.filled : 0;
  }
  std(): number {
    if (this.filled < 2) return 0;
    const m = this.mean();
    let s = 0;
    for (let i = 0; i < this.filled; i++) {
      const d = this.buf[i] - m;
      s += d * d;
    }
    return Math.sqrt(s / (this.filled - 1));
  }
  /** Third standardised moment — the basis of the skewness signal-quality index. */
  skewness(): number {
    if (this.filled < 3) return 0;
    const m = this.mean();
    const sd = this.std();
    if (sd < 1e-12) return 0;
    let s = 0;
    for (let i = 0; i < this.filled; i++) {
      const z = (this.buf[i] - m) / sd;
      s += z * z * z;
    }
    return s / this.filled;
  }
  reset(): void {
    this.buf.fill(0);
    this.idx = 0;
    this.filled = 0;
  }
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
