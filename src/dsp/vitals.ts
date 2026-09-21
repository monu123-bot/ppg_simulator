import { peakFrequency, powerSpectrum, resampleUniform } from './fft';

/**
 * Derived vital signs that are not heart rate: respiration and SpO2.
 */

export interface RespirationEstimate {
  /** Breaths per minute, or null when the inductions disagree. */
  rateBpm: number | null;
  /** Per-induction estimates, breaths per minute. */
  riav: number | null;
  riiv: number | null;
  rifv: number | null;
  /** Spread between the inductions, breaths/min — the fusion criterion. */
  agreementBpm: number;
  valid: boolean;
}

const RESP_BAND: [number, number] = [0.1, 0.6]; // 6-36 breaths/min

/**
 * Respiratory rate by the three classical PPG inductions, fused.
 *
 * Breathing modulates a PPG three ways at once:
 *
 *   RIAV — amplitude: intrathoracic pressure changes stroke volume, so pulse
 *          height rises and falls with the breath.
 *   RIIV — baseline: venous return shifts the total blood volume in the tissue,
 *          moving the DC level.
 *   RIFV — frequency: respiratory sinus arrhythmia moves the beat intervals.
 *
 * Each is a weak, noisy estimator on its own. The fusion rule is Karlen et al.
 * (2013): accept the mean only when the three estimates agree within a few
 * breaths per minute, and report nothing when they do not. Refusing to answer
 * is the correct behaviour here — a confidently wrong respiratory rate is worse
 * than a blank.
 */
export function estimateRespiration(
  beatTimes: number[],
  beatAmplitudes: number[],
  beatBaselines: number[],
  nnMs: number[],
): RespirationEstimate {
  const none: RespirationEstimate = {
    rateBpm: null,
    riav: null,
    riiv: null,
    rifv: null,
    agreementBpm: Infinity,
    valid: false,
  };
  if (beatTimes.length < 16) return none;
  const span = beatTimes[beatTimes.length - 1] - beatTimes[0];
  // Needs roughly four breaths to resolve a rate at all.
  if (span < 22) return none;

  const riav = dominantRate(beatTimes, beatAmplitudes);
  const riiv = dominantRate(beatTimes, beatBaselines);
  const rifv = dominantRate(beatTimes.slice(0, nnMs.length), nnMs);

  const values = [riav, riiv, rifv].filter((v): v is number => v !== null);
  if (values.length < 2) return { ...none, riav, riiv, rifv };

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let spread = 0;
  for (const v of values) spread = Math.max(spread, Math.abs(v - mean));

  // Karlen's criterion: within 4 breaths/min across inductions.
  const valid = spread <= 4 && values.length >= 2;
  return {
    rateBpm: valid ? mean : null,
    riav,
    riiv,
    rifv,
    agreementBpm: spread,
    valid,
  };
}

function dominantRate(times: number[], values: number[]): number | null {
  if (times.length < 12 || values.length < 12) return null;
  const n = Math.min(times.length, values.length);
  const { data } = resampleUniform(times.slice(0, n), values.slice(0, n), 4);
  if (data.length < 48) return null;
  const spec = powerSpectrum(data, 4, { detrend: true, zeroPad: data.length * 4 });
  const peak = peakFrequency(spec, RESP_BAND[0], RESP_BAND[1]);
  if (peak.freq <= 0 || peak.power <= 0) return null;
  return peak.freq * 60;
}

export interface Spo2Estimate {
  /** Estimated saturation in percent, or null when unavailable. */
  value: number | null;
  /** Ratio of ratios. */
  ratio: number;
  valid: boolean;
  reason?: string;
}

/**
 * SpO2 by the ratio-of-ratios method.
 *
 *   R = (AC_red / DC_red) / (AC_ir / DC_ir)
 *   SpO2 = 110 - 25R
 *
 * The linear calibration is the standard empirical one; a real oximeter uses a
 * vendor lookup table fitted against arterial blood-gas measurements in a
 * desaturation study, and is only valid down to roughly 70%.
 *
 * Wrist reflectance SpO2 is far less reliable than fingertip transmittance,
 * and motion destroys it outright, so this refuses to produce a value when the
 * wrist is moving rather than producing a plausible-looking wrong one.
 */
export function estimateSpo2(
  redWindow: ArrayLike<number>,
  irWindow: ArrayLike<number>,
  motionG: number,
  hasRedIr: boolean,
): Spo2Estimate {
  if (!hasRedIr) {
    return { value: null, ratio: 0, valid: false, reason: 'Sensor has no red/IR channels' };
  }
  const n = Math.min(redWindow.length, irWindow.length);
  if (n < 64) return { value: null, ratio: 0, valid: false, reason: 'Collecting samples' };

  const red = acDc(redWindow, n);
  const ir = acDc(irWindow, n);
  if (red.dc <= 0 || ir.dc <= 0 || ir.ac <= 0) {
    return { value: null, ratio: 0, valid: false, reason: 'No usable pulsatile component' };
  }

  const ratio = red.ac / red.dc / (ir.ac / ir.dc);
  const value = 110 - 25 * ratio;

  // Reflectance SpO2 needs a near-still wrist. Quiet sitting, with the small
  // postural adjustments that come with it, still qualifies; walking does not.
  if (motionG > 0.15) {
    return { value: null, ratio, valid: false, reason: 'Motion — reflectance SpO2 is not recoverable' };
  }
  if (value < 70 || value > 100.5) {
    return { value: null, ratio, valid: false, reason: 'Ratio outside the calibrated range' };
  }
  return { value: Math.min(100, value), ratio, valid: true };
}

/** AC as peak-to-peak over the window, DC as the mean. */
function acDc(w: ArrayLike<number>, n: number): { ac: number; dc: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = w[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { ac: max - min, dc: sum / n };
}

/**
 * Heart rate from the spectrum of the filtered PPG, as a cross-check on the
 * peak detector. When these two disagree the signal is usually locked onto
 * cadence rather than pulse — which is precisely the failure mode worth seeing.
 */
export interface SpectralRate {
  hr: number;
  confidence: number;
  /** Frequencies (Hz) that were masked out as motion. */
  maskedHz: number[];
}

/**
 * Heart rate from the PPG spectrum, with cadence peaks masked out using the
 * accelerometer.
 *
 * Picking the tallest peak in the cardiac band is how a wrist tracker ends up
 * reporting step rate: during hard running the motion residue is simply taller
 * than the pulse. The accelerometer says exactly where that residue must be —
 * at the cadence fundamental and its harmonics — so those bins are suppressed
 * before the pulse peak is chosen. This is the core idea behind the published
 * wrist-PPG trackers (TROIKA, JOSS and their successors), reduced to its
 * simplest form.
 *
 * A soft continuity prior around the currently tracked rate breaks ties, but
 * deliberately only softens the spectrum rather than gating it: a hard search
 * window makes the estimator unable to recover once it has locked onto
 * something wrong, which is worse than the problem it solves.
 */
export function spectralHeartRate(
  ppgWindow: ArrayLike<number>,
  accelWindow: ArrayLike<number>,
  fs: number,
  priorHr = 0,
): SpectralRate {
  if (ppgWindow.length < fs * 4) return { hr: 0, confidence: 0, maskedHz: [] };
  const spec = powerSpectrum(ppgWindow, fs, { detrend: true, zeroPad: ppgWindow.length * 2 });
  const df = spec.df || 1e-6;

  // --- locate the motion peaks
  const maskedHz: number[] = [];
  // Masking is gated on there actually being motion. At rest the accelerometer
  // is noise, its "peaks" are arbitrary, and one of them will sooner or later
  // land on the heart rate and delete the very thing being measured.
  const motionRms = stdev(accelWindow);
  if (accelWindow.length >= fs * 4 && motionRms > MASK_GATE_G) {
    const acc = powerSpectrum(accelWindow, fs, { detrend: true, zeroPad: accelWindow.length * 2 });
    const peaks: Array<{ f: number; p: number }> = [];
    for (let k = 2; k < acc.freq.length - 1; k++) {
      const f = acc.freq[k];
      if (f < 0.4 || f > HR_BAND_HI_HZ + 0.5) continue;
      if (acc.psd[k] > acc.psd[k - 1] && acc.psd[k] >= acc.psd[k + 1]) {
        peaks.push({ f, p: acc.psd[k] });
      }
    }
    peaks.sort((a, b) => b.p - a.p);
    const strongest = peaks[0]?.p ?? 0;

    // Mask only when the motion is *periodic*. Housework and fidgeting produce
    // plenty of acceleration but no discrete spectral lines, so there is
    // nothing meaningful to mask and every candidate peak is noise — masking
    // on that basis deletes real pulse bins at random.
    let accTotal = 0;
    for (let k = 0; k < acc.freq.length; k++) {
      if (acc.freq[k] >= 0.4 && acc.freq[k] <= HR_BAND_HI_HZ + 0.5) accTotal += acc.psd[k];
    }
    const peakiness = accTotal > 0 ? (strongest * 3) / accTotal : 0;
    if (peakiness < MASK_PEAKINESS_MIN) peaks.length = 0;

    for (const peak of peaks.slice(0, 3)) {
      // Only mask peaks that are a real feature of the motion spectrum.
      if (peak.p < 0.04 * strongest) break;
      maskedHz.push(peak.f);
      // Harmonics and the subharmonic. The optical coupling is not linear, so
      // motion at one frequency deposits energy at several — the second
      // harmonic from rectification, the subharmonic from the stride-versus-
      // step asymmetry of gait.
      if (peak.f * 2 <= HR_BAND_HI_HZ) maskedHz.push(peak.f * 2);
      if (peak.f * 0.5 >= HR_BAND_LO_HZ) maskedHz.push(peak.f * 0.5);
    }
  }

  const notch = Math.max(0.055, 2.5 * df);
  let best = -1;
  let bestScore = 0;
  const scored = new Float64Array(spec.freq.length);

  for (let k = 1; k < spec.freq.length - 1; k++) {
    const f = spec.freq[k];
    if (f < HR_BAND_LO_HZ || f > HR_BAND_HI_HZ) continue;
    let w = 1;
    for (const mf of maskedHz) {
      // A cadence line that coincides with the rate already being tracked is
      // not masked. When someone walks at a cadence equal to their heart rate
      // the two occupy the same bin, and suppressing it would delete the pulse
      // rather than the artefact. The ambiguity is expressed as reduced
      // confidence below instead of as a confidently wrong answer.
      if (priorHr > 30 && Math.abs(mf * 60 - priorHr) < PROTECT_BPM) continue;
      if (Math.abs(f - mf) < notch) w *= MASK_DEPTH;
    }
    if (priorHr > 30) {
      const z = (f * 60 - priorHr) / CONTINUITY_SIGMA_BPM;
      w *= 0.55 + 0.45 * Math.exp(-0.5 * z * z);
    }
    scored[k] = spec.psd[k] * w;
    if (scored[k] > bestScore) {
      bestScore = scored[k];
      best = k;
    }
  }
  if (best < 1) return { hr: 0, confidence: 0, maskedHz };

  // Parabolic refinement on the unmasked spectrum around the chosen bin.
  const y0 = spec.psd[best - 1];
  const y1 = spec.psd[best];
  const y2 = spec.psd[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = Math.abs(denom) > 1e-18 ? (0.5 * (y0 - y2)) / denom : 0;
  const freq = (best + Math.max(-0.5, Math.min(0.5, delta))) * df;

  let total = 0;
  for (let k = 0; k < spec.freq.length; k++) {
    if (spec.freq[k] >= HR_BAND_LO_HZ && spec.freq[k] <= HR_BAND_HI_HZ) total += scored[k];
  }
  let share = total > 0 ? (bestScore * 3) / total : 0;

  // When the chosen peak sits right next to a cadence line, the two cannot be
  // told apart no matter how tall the peak is — the skirts of an artefact many
  // times larger than the pulse reach straight into the pulse's own bin. This
  // is the genuinely unsolvable case for wrist PPG: someone running at a
  // cadence close to their heart rate. Confidence is cut accordingly rather
  // than the estimate being presented as sound.
  let nearestMask = Infinity;
  for (const mf of maskedHz) nearestMask = Math.min(nearestMask, Math.abs(freq - mf));
  if (Number.isFinite(nearestMask)) {
    share *= Math.max(0.18, Math.min(1, nearestMask / CONFUSION_HZ));
  }

  return { hr: freq * 60, confidence: Math.min(1, share), maskedHz };
}

/** Cardiac search band: 42 to 210 bpm. */
const HR_BAND_LO_HZ = 0.7;
const HR_BAND_HI_HZ = 3.5;
/** How much a masked bin is attenuated. Not zero — motion and pulse can coincide. */
const MASK_DEPTH = 0.1;
/** Width of the soft continuity prior, in bpm. */
const CONTINUITY_SIGMA_BPM = 26;
/** A cadence line this close to the tracked rate is left alone, in bpm. */
const PROTECT_BPM = 12;
/** Separation below which a pulse peak and a cadence line are inseparable, Hz. */
const CONFUSION_HZ = 0.4;
/** Accelerometer rms below which nothing is masked, in g. */
const MASK_GATE_G = 0.15;
/** Minimum spectral concentration of the motion before its peaks are masked. */
const MASK_PEAKINESS_MIN = 0.06;

function stdev(w: ArrayLike<number>): number {
  const n = w.length;
  if (n < 2) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += w[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (w[i] - m) * (w[i] - m);
  return Math.sqrt(v / (n - 1));
}
