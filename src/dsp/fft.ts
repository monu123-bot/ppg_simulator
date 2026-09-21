/** Iterative radix-2 FFT and the spectral helpers built on it. */

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place complex FFT. `re` and `im` must have a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

export interface Spectrum {
  /** Frequency of each bin, Hz. */
  freq: Float64Array;
  /** One-sided power spectral density. */
  psd: Float64Array;
  /** Frequency resolution, Hz. */
  df: number;
}

/**
 * One-sided PSD via a Hann-windowed periodogram.
 *
 * The window is compensated so band powers integrate correctly — without the
 * coherent-gain correction every HRV frequency-domain number comes out low.
 */
export function powerSpectrum(
  signal: ArrayLike<number>,
  fs: number,
  options: { detrend?: boolean; zeroPad?: number } = {},
): Spectrum {
  const n = signal.length;
  if (n < 4) {
    return { freq: new Float64Array(0), psd: new Float64Array(0), df: 0 };
  }

  const work = new Float64Array(n);
  for (let i = 0; i < n; i++) work[i] = signal[i];

  if (options.detrend !== false) {
    // Remove the linear trend: a residual ramp leaks huge power into VLF.
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += work[i];
      sxx += i * i;
      sxy += i * work[i];
    }
    const denom = n * sxx - sx * sx || 1;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    for (let i = 0; i < n; i++) work[i] -= slope * i + intercept;
  }

  // Hann window.
  let winPower = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    work[i] *= w;
    winPower += w * w;
  }

  const size = nextPow2(Math.max(n, options.zeroPad ?? n));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(work);
  fft(re, im);

  const half = size >> 1;
  const freq = new Float64Array(half);
  const psd = new Float64Array(half);
  const df = fs / size;
  // Normalisation: 2/(fs * sum(w^2)) gives a one-sided density in units^2/Hz.
  const norm = 2 / (fs * winPower);
  for (let k = 0; k < half; k++) {
    freq[k] = k * df;
    psd[k] = (re[k] * re[k] + im[k] * im[k]) * norm;
  }
  if (half > 0) psd[0] *= 0.5;
  return { freq, psd, df };
}

/** Integrate a PSD between two frequencies. */
export function bandPower(spec: Spectrum, lo: number, hi: number): number {
  let sum = 0;
  for (let k = 0; k < spec.freq.length; k++) {
    const f = spec.freq[k];
    if (f >= lo && f < hi) sum += spec.psd[k];
  }
  return sum * spec.df;
}

/** Frequency of the largest PSD bin within a band, with parabolic refinement. */
export function peakFrequency(spec: Spectrum, lo: number, hi: number): { freq: number; power: number } {
  let best = -1;
  let bestP = 0;
  for (let k = 1; k < spec.freq.length - 1; k++) {
    const f = spec.freq[k];
    if (f < lo || f > hi) continue;
    if (spec.psd[k] > bestP) {
      bestP = spec.psd[k];
      best = k;
    }
  }
  if (best < 1) return { freq: 0, power: 0 };
  const y0 = spec.psd[best - 1];
  const y1 = spec.psd[best];
  const y2 = spec.psd[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = Math.abs(denom) > 1e-18 ? (0.5 * (y0 - y2)) / denom : 0;
  return { freq: (best + Math.max(-0.5, Math.min(0.5, delta))) * spec.df, power: bestP };
}

/**
 * Resample an irregular series (times in seconds, values) onto a uniform grid
 * by cubic Catmull-Rom interpolation.
 *
 * The tachogram is an event series, not a uniformly sampled signal, so it has
 * to be interpolated before an FFT can touch it. 4 Hz is the conventional rate
 * in the HRV literature.
 */
export function resampleUniform(
  times: number[],
  values: number[],
  fs: number,
): { data: Float64Array; t0: number } {
  const n = times.length;
  if (n < 4) return { data: new Float64Array(0), t0: 0 };
  const t0 = times[0];
  const tEnd = times[n - 1];
  const count = Math.floor((tEnd - t0) * fs) + 1;
  const out = new Float64Array(Math.max(0, count));
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i / fs;
    while (j < n - 2 && times[j + 1] < t) j++;
    const p0 = values[Math.max(0, j - 1)];
    const p1 = values[j];
    const p2 = values[Math.min(n - 1, j + 1)];
    const p3 = values[Math.min(n - 1, j + 2)];
    const span = Math.max(1e-6, times[Math.min(n - 1, j + 1)] - times[j]);
    const u = Math.max(0, Math.min(1, (t - times[j]) / span));
    const u2 = u * u;
    const u3 = u2 * u;
    out[i] =
      0.5 *
      (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  }
  return { data: out, t0 };
}
