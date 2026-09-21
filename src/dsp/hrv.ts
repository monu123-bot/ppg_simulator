import { bandPower, peakFrequency, powerSpectrum, resampleUniform } from './fft';
import { median } from './filters';

/**
 * Heart-rate variability metrics.
 *
 * Definitions and band edges follow the Task Force of the European Society of
 * Cardiology and the North American Society of Pacing and Electrophysiology
 * (Circulation 1996;93:1043-1065), which is still the standard every later
 * paper is written against. Normative ranges for interpretation come from
 * Nunan et al. (2010) and Shaffer & Ginsberg (2017).
 *
 * One caveat is built into the output rather than left to the reader: these are
 * *pulse* rate variability figures, not R-R variability. Pulse transit time
 * varies beat to beat with blood pressure, so PRV is systematically a little
 * noisier than the ECG-derived HRV these norms were established with. The
 * agreement is good at rest and degrades with movement, which is exactly what
 * the validity flags here track.
 */

export const HRV_BANDS = {
  vlf: [0.0033, 0.04] as [number, number],
  lf: [0.04, 0.15] as [number, number],
  hf: [0.15, 0.4] as [number, number],
};

export interface TimeDomainHrv {
  beats: number;
  /** Mean of normal-to-normal intervals, ms. */
  meanNn: number;
  meanHr: number;
  /** Standard deviation of NN intervals, ms — total variability. */
  sdnn: number;
  /** Root mean square of successive differences, ms — short-term, vagally mediated. */
  rmssd: number;
  /** Percentage of successive differences greater than 50 ms. */
  pnn50: number;
  /** Coefficient of variation of NN intervals, %. */
  cvnn: number;
  /** Poincare short axis, ms — equals RMSSD/sqrt(2) by construction. */
  sd1: number;
  /** Poincare long axis, ms — long-term variability. */
  sd2: number;
  sd1sd2: number;
  /** HRV triangular index: total intervals divided by the modal bin height. */
  triangularIndex: number;
}

export interface FrequencyDomainHrv {
  totalPower: number;
  vlf: number;
  lf: number;
  hf: number;
  lfhf: number;
  /** Normalised units: LF/(LF+HF) x 100 and its complement. */
  lfNu: number;
  hfNu: number;
  /** Dominant HF frequency, Hz — the respiratory peak in the tachogram. */
  hfPeakHz: number;
  /** The interpolated tachogram spectrum, for plotting. */
  spectrum: { freq: Float64Array; psd: Float64Array } | null;
  /** True when the window was long enough for the band to be meaningful. */
  vlfValid: boolean;
  lfValid: boolean;
}

export interface StressAssessment {
  /** Baevsky stress index (raw, unbounded). */
  baevskySi: number;
  /** 0-100 composite. Higher means more sympathetic dominance. */
  score: number;
  band: 'recovered' | 'balanced' | 'elevated' | 'high' | 'very-high';
  /** False when movement or heart rate make the figure uninterpretable. */
  valid: boolean;
  reason?: string;
}

export function timeDomain(nnMs: number[]): TimeDomainHrv {
  const n = nnMs.length;
  const empty: TimeDomainHrv = {
    beats: n,
    meanNn: 0,
    meanHr: 0,
    sdnn: 0,
    rmssd: 0,
    pnn50: 0,
    cvnn: 0,
    sd1: 0,
    sd2: 0,
    sd1sd2: 0,
    triangularIndex: 0,
  };
  if (n < 3) return empty;

  let sum = 0;
  for (const v of nnMs) sum += v;
  const meanNn = sum / n;

  let sq = 0;
  for (const v of nnMs) sq += (v - meanNn) * (v - meanNn);
  const sdnn = Math.sqrt(sq / (n - 1));

  let diffSq = 0;
  let over50 = 0;
  for (let i = 1; i < n; i++) {
    const d = nnMs[i] - nnMs[i - 1];
    diffSq += d * d;
    if (Math.abs(d) > 50) over50++;
  }
  const rmssd = Math.sqrt(diffSq / (n - 1));
  const pnn50 = (over50 / (n - 1)) * 100;

  // Poincare descriptors. SD1 is RMSSD/sqrt(2) exactly; SD2 follows from the
  // identity SD1^2 + SD2^2 = 2 * SDNN^2.
  const sd1 = rmssd / Math.SQRT2;
  const sd2 = Math.sqrt(Math.max(0, 2 * sdnn * sdnn - sd1 * sd1));

  // Triangular index over the conventional 7.8125 ms (1/128 s) bins.
  const binMs = 1000 / 128;
  const hist = new Map<number, number>();
  for (const v of nnMs) {
    const b = Math.round(v / binMs);
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  let maxBin = 0;
  for (const c of hist.values()) maxBin = Math.max(maxBin, c);

  return {
    beats: n,
    meanNn,
    meanHr: 60000 / meanNn,
    sdnn,
    rmssd,
    pnn50,
    cvnn: (sdnn / meanNn) * 100,
    sd1,
    sd2,
    sd1sd2: sd2 > 0 ? sd1 / sd2 : 0,
    triangularIndex: maxBin > 0 ? n / maxBin : 0,
  };
}

/**
 * Frequency-domain HRV from the interpolated tachogram.
 *
 * `times` are beat times in seconds, `nnMs` the matching intervals. The series
 * is resampled to 4 Hz, detrended and windowed before the periodogram, per the
 * Task Force recommendations.
 */
export function frequencyDomain(times: number[], nnMs: number[]): FrequencyDomainHrv {
  const none: FrequencyDomainHrv = {
    totalPower: 0,
    vlf: 0,
    lf: 0,
    hf: 0,
    lfhf: 0,
    lfNu: 0,
    hfNu: 0,
    hfPeakHz: 0,
    spectrum: null,
    vlfValid: false,
    lfValid: false,
  };
  if (times.length < 12) return none;

  const durationSec = times[times.length - 1] - times[0];
  if (durationSec < 20) return none;

  const fsResample = 4;
  const { data } = resampleUniform(times, nnMs, fsResample);
  if (data.length < 32) return none;

  const spec = powerSpectrum(data, fsResample, { detrend: true, zeroPad: data.length * 2 });

  const vlf = bandPower(spec, HRV_BANDS.vlf[0], HRV_BANDS.vlf[1]);
  const lf = bandPower(spec, HRV_BANDS.lf[0], HRV_BANDS.lf[1]);
  const hf = bandPower(spec, HRV_BANDS.hf[0], HRV_BANDS.hf[1]);
  const totalPower = bandPower(spec, 0.0, 0.4);
  const lfhfDenom = hf > 1e-9 ? hf : 1e-9;

  // Keep only the part of the spectrum worth plotting.
  const keep = spec.freq.findIndex((f) => f > 0.5);
  const cut = keep > 0 ? keep : spec.freq.length;

  const hfPeak = peakFrequency(spec, HRV_BANDS.hf[0], HRV_BANDS.hf[1]);
  const lfHfSum = lf + hf;

  return {
    totalPower,
    vlf,
    lf,
    hf,
    lfhf: lf / lfhfDenom,
    lfNu: lfHfSum > 0 ? (lf / lfHfSum) * 100 : 0,
    hfNu: lfHfSum > 0 ? (hf / lfHfSum) * 100 : 0,
    hfPeakHz: hfPeak.freq,
    spectrum: { freq: spec.freq.slice(0, cut), psd: spec.psd.slice(0, cut) },
    // A band needs roughly ten cycles of its lowest frequency to be estimable.
    vlfValid: durationSec >= 300,
    lfValid: durationSec >= 120,
  };
}

/**
 * Baevsky stress index.
 *
 *   SI = AMo / (2 * Mo * MxDMn)
 *
 * where Mo is the modal interval in seconds, AMo the percentage of intervals in
 * that 50 ms mode bin and MxDMn the range in seconds. It rises steeply with
 * sympathetic dominance; the conventional square root is applied here to give a
 * scale that is readable on a linear gauge.
 */
export function baevskyStressIndex(nnMs: number[]): number {
  if (nnMs.length < 12) return 0;
  const binMs = 50;
  const hist = new Map<number, number>();
  for (const v of nnMs) {
    const b = Math.round(v / binMs);
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  let modeBin = 0;
  let modeCount = 0;
  for (const [b, c] of hist) {
    if (c > modeCount) {
      modeCount = c;
      modeBin = b;
    }
  }
  const moSec = (modeBin * binMs) / 1000;
  const amoPct = (modeCount / nnMs.length) * 100;
  const mx = Math.max(...nnMs) / 1000;
  const mn = Math.min(...nnMs) / 1000;
  const mxdmn = Math.max(0.01, mx - mn);
  if (moSec <= 0) return 0;
  return amoPct / (2 * moSec * mxdmn);
}

/**
 * Composite autonomic-load score.
 *
 * No single HRV number is a stress measurement, so this blends four that move
 * together under sympathetic activation, each normalised against age-adjusted
 * expectations: suppressed RMSSD, raised LF/HF, raised Baevsky SI and heart
 * rate elevated above the subject's own resting rate.
 *
 * It is deliberately marked invalid during movement and at high heart rates.
 * Exercise suppresses HRV exactly the way stress does, so a "stress" number
 * computed while someone is running is measuring the run, not their state —
 * a distinction consumer wearables routinely get wrong.
 */
export function assessStress(
  td: TimeDomainHrv,
  fd: FrequencyDomainHrv,
  ctx: {
    age: number;
    restingHr: number;
    motionG: number;
    signalQuality: number;
  },
): StressAssessment {
  if (td.beats < 20) {
    return { baevskySi: 0, score: 0, band: 'balanced', valid: false, reason: 'Collecting beats' };
  }

  // Age-expected RMSSD. Roughly halves between 20 and 70 (Nunan 2010).
  const expectedRmssd = Math.max(12, 62 * Math.exp(-(ctx.age - 20) / 48));
  const rmssdRatio = td.rmssd / expectedRmssd;
  const rmssdTerm = clamp01(1 - rmssdRatio); // 0 when at or above expectation

  const lfhfTerm = clamp01((fd.lfhf - 0.8) / 4.2);
  const hrTerm = clamp01((td.meanHr - ctx.restingHr) / 28);

  const siRaw = baevskyStressIndexFromTd(td);
  const siTerm = clamp01((Math.sqrt(Math.max(0, siRaw)) - 3) / 14);

  const weights = fd.lfValid ? [0.34, 0.24, 0.2, 0.22] : [0.45, 0.0, 0.27, 0.28];
  const score =
    100 *
    clamp01(
      weights[0] * rmssdTerm + weights[1] * lfhfTerm + weights[2] * hrTerm + weights[3] * siTerm,
    );

  let valid = true;
  let reason: string | undefined;
  if (ctx.motionG > 0.22) {
    valid = false;
    reason = 'Movement above the resting threshold — HRV reflects exertion, not autonomic state';
  } else if (td.meanHr > ctx.restingHr + 30) {
    valid = false;
    reason = 'Heart rate far above resting — HRV suppression here is cardiac, not psychological';
  } else if (ctx.signalQuality < 45) {
    valid = false;
    reason = 'Signal quality too low for a trustworthy interval series';
  }

  const band: StressAssessment['band'] =
    score < 20 ? 'recovered' : score < 40 ? 'balanced' : score < 60 ? 'elevated' : score < 80 ? 'high' : 'very-high';

  return { baevskySi: siRaw, score, band, valid, reason };
}

function baevskyStressIndexFromTd(td: TimeDomainHrv): number {
  // Closed-form approximation from the time-domain summary, used when the raw
  // interval list is not being carried around. Mo ~ meanNN, MxDMn ~ 6 x SDNN
  // for a roughly normal distribution, AMo ~ the fraction inside one 50 ms bin.
  const moSec = td.meanNn / 1000;
  if (moSec <= 0 || td.sdnn <= 0) return 0;
  const amoPct = (50 / (td.sdnn * Math.sqrt(2 * Math.PI))) * 100;
  const mxdmn = Math.max(0.02, (6 * td.sdnn) / 1000);
  return amoPct / (2 * moSec * mxdmn);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Correct an interval series the way Kubios and most analysis packages do:
 * intervals deviating from a local median by more than a threshold are replaced
 * by that median rather than deleted, so the tachogram keeps its time base.
 */
export function correctIntervals(
  nnMs: number[],
  thresholdFraction = 0.25,
): { corrected: number[]; correctedCount: number } {
  if (nnMs.length < 5) return { corrected: [...nnMs], correctedCount: 0 };
  const out = [...nnMs];
  let count = 0;
  const half = 2;
  for (let i = 0; i < out.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(out.length, i + half + 1);
    const window: number[] = [];
    for (let j = lo; j < hi; j++) if (j !== i) window.push(nnMs[j]);
    const med = median(window);
    if (med > 0 && Math.abs(out[i] - med) / med > thresholdFraction) {
      out[i] = med;
      count++;
    }
  }
  return { corrected: out, correctedCount: count };
}

/** Normative interpretation bands used by the UI, from Nunan 2010 / Shaffer 2017. */
export function rmssdNorm(age: number): { low: number; high: number } {
  const centre = 62 * Math.exp(-(age - 20) / 48);
  return { low: Math.max(8, centre * 0.55), high: centre * 1.7 };
}

export function sdnnNorm(age: number): { low: number; high: number } {
  const centre = 68 * Math.exp(-(age - 20) / 60);
  return { low: Math.max(12, centre * 0.55), high: centre * 1.7 };
}
