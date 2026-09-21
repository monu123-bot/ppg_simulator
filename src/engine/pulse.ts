import type { ActivityProfile, SubjectProfile, WearConfig } from './types';
import { DriftSource, clamp, makeGaussian, makeRng } from './rng';
import type { Beat } from './cardiac';

/**
 * Pulse morphology synthesis.
 *
 * Each cardiac cycle is built as a sum of Gaussian components plus a windkessel
 * runoff term — the standard decomposition used for synthetic PPG:
 *
 *   1. the systolic (percussion) wave, timed by left-ventricular ejection
 *   2. the reflected (tidal/dicrotic) wave returning from the periphery
 *   3. a small late diastolic wave
 *   4. an exponential diastolic runoff, so the trace never quite returns to
 *      baseline between beats the way a bare Gaussian sum would
 *
 * The parameters are driven by real physiology rather than being fixed:
 *
 *   - Left-ventricular ejection time shortens with heart rate (Weissler),
 *     so the systolic upstroke compresses during exercise.
 *   - The reflected wave arrives earlier in stiffer (older) arteries, which is
 *     what the stiffness index measures, and is progressively buried as heart
 *     rate rises until the dicrotic notch disappears entirely.
 *   - Amplitude is modulated by respiration (RIAV) and the baseline by
 *     respiratory-induced intensity variation (RIIV) — the two mechanisms that
 *     make respiratory rate recoverable from a PPG at all.
 */

export interface PulseMorphology {
  /** Left-ventricular ejection time for this beat, seconds. */
  lvetSec: number;
  /** Time from foot to systolic peak, seconds. */
  crestTimeSec: number;
  /** Amplitude of the reflected wave relative to the systolic peak. */
  reflectionIndex: number;
  /** Systolic-to-reflected peak delay, seconds. */
  reflectionDelaySec: number;
}

/** Arterial stiffness proxy in 0..1 from age and BMI. */
export function stiffnessIndex(subject: SubjectProfile): number {
  const ageTerm = clamp((subject.age - 18) / 62, 0, 1);
  const bmiTerm = clamp((subject.bmi - 21) / 18, 0, 1);
  return clamp(0.78 * ageTerm + 0.22 * bmiTerm, 0, 1);
}

export function morphologyFor(subject: SubjectProfile, ibiSec: number): PulseMorphology {
  const hr = 60 / Math.max(0.25, ibiSec);
  const stiff = stiffnessIndex(subject);

  // Weissler's regression for left-ventricular ejection time, clamped to the
  // range that stays physiological at the extremes of the HR band.
  const lvetSec = clamp(0.364 - 0.0016 * hr, 0.13, 0.33);
  const crestTimeSec = 0.56 * lvetSec;

  // Reflected-wave transit time: earlier in stiff arteries, and it compresses
  // slightly (but not proportionally) as the cycle shortens.
  const baseDelay = 0.36 - 0.17 * stiff;
  const reflectionDelaySec = clamp(baseDelay * Math.pow(ibiSec / 0.85, 0.34), 0.12, 0.38);

  // The dicrotic notch fades as heart rate rises and as arteries stiffen. The
  // fade is steep on purpose: by the time someone is walking briskly the notch
  // is essentially gone, and a model that keeps a large reflected wave at 120
  // bpm produces a two-humped cycle that any peak detector will read as double
  // the true rate.
  const hrFade = Math.exp(-Math.max(0, hr - 58) / 50);
  // Base index is lower than the fingertip figures most textbook traces show:
  // the reflected wave is measurably less prominent in wrist reflectance PPG.
  const reflectionIndex = clamp((0.45 - 0.2 * stiff) * hrFade, 0.04, 0.5);

  return { lvetSec, crestTimeSec, reflectionIndex, reflectionDelaySec };
}

interface ActiveBeat {
  tSec: number;
  amplitude: number;
  m: PulseMorphology;
  ibiSec: number;
}

function gaussian(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z);
}

/** Evaluate a single normalised pulse at `dt` seconds after its foot. */
export function pulseAt(dt: number, m: PulseMorphology, ibiSec: number): number {
  if (dt < 0) return 0;
  const w1 = 0.36 * m.lvetSec;
  const m2 = m.crestTimeSec + m.reflectionDelaySec;
  const w2 = 1.25 * w1;
  const m3 = m2 + 0.22 * ibiSec;
  const w3 = 0.26 * ibiSec;

  const systolic = gaussian(dt, m.crestTimeSec, w1);
  const reflected = m.reflectionIndex * gaussian(dt, m2, w2);
  const diastolic = 0.06 * gaussian(dt, m3, w3);
  // Windkessel runoff keeps the trough above the true baseline rather than
  // letting a bare Gaussian sum fall to zero between beats.
  const runoff =
    0.14 *
    Math.exp(-dt / (0.30 * ibiSec)) *
    (dt > m.crestTimeSec ? 1 : dt / Math.max(1e-6, m.crestTimeSec));

  return systolic + reflected + diastolic + runoff;
}

export class PulseTrain {
  private active: ActiveBeat[] = [];
  private readonly gauss: () => number;
  private readonly amplitudeDrift: DriftSource;
  private readonly vasomotionDrift: DriftSource;
  private lastIbiSec = 1.0;
  /** Peak value of a single isolated pulse, used to normalise to ~1. */
  private normaliser = 1;
  private vasoPhase = 0;

  constructor(
    private readonly subject: SubjectProfile,
    seed: number,
  ) {
    const rng = makeRng(seed ^ 0x9e3779b9);
    this.gauss = makeGaussian(rng);
    this.amplitudeDrift = new DriftSource(this.gauss, 0.02, 0.06);
    this.vasomotionDrift = new DriftSource(this.gauss, 0.004, 0.09);
    this.normaliser = this.peakOf(morphologyFor(subject, 1.0), 1.0);
  }

  private peakOf(m: PulseMorphology, ibiSec: number): number {
    let peak = 0;
    for (let i = 0; i <= 60; i++) {
      const dt = (i / 60) * Math.min(ibiSec, 0.9);
      peak = Math.max(peak, pulseAt(dt, m, ibiSec));
    }
    return peak || 1;
  }

  /**
   * Register a beat. `respPhase` at the moment of the beat sets its respiratory
   * amplitude modulation, which is how respiratory rate becomes recoverable
   * from pulse amplitude alone.
   */
  addBeat(beat: Beat, respPhase: number, riavDepth: number): void {
    const ibiSec = clamp(beat.ibiMs / 1000, 0.25, 2.2);
    this.lastIbiSec = ibiSec;
    const m = morphologyFor(this.subject, ibiSec);

    // Respiratory-induced amplitude variation, plus beat-to-beat jitter.
    const riav = 1 + riavDepth * Math.sin(respPhase);
    const jitter = 1 + this.gauss() * 0.022;
    // A premature beat has had less filling time, so it ejects a smaller volume.
    const ectopicDeficit = beat.ectopic ? 0.52 : 1;
    // Shorter cycles fill less: mild Frank-Starling scaling.
    const fill = clamp(Math.pow(ibiSec / 0.85, 0.18), 0.72, 1.18);

    this.active.push({
      tSec: beat.tSec,
      amplitude: riav * jitter * ectopicDeficit * fill,
      m,
      ibiSec,
    });
    if (this.active.length > 12) this.active.shift();
  }

  /**
   * Cardiac AC component at time `t`, normalised so a typical pulse peaks near 1.
   * Overlapping beats sum, which is exactly what happens at high heart rates.
   */
  acAt(t: number): number {
    let sum = 0;
    for (let i = 0; i < this.active.length; i++) {
      const b = this.active[i];
      const dt = t - b.tSec;
      if (dt < 0 || dt > b.ibiSec * 2.6) continue;
      sum += b.amplitude * pulseAt(dt, b.m, b.ibiSec);
    }
    return sum / this.normaliser;
  }

  /**
   * Slow baseline component: respiratory-induced intensity variation plus
   * spontaneous vasomotion near 0.1 Hz. Expressed in the same units as `acAt`.
   */
  baselineAt(dt: number, respPhase: number, riivDepth: number, vasomotion: number): number {
    this.vasoPhase += 2 * Math.PI * 0.09 * dt;
    const riiv = riivDepth * Math.sin(respPhase - 0.6);
    const vaso = vasomotion * (0.6 * Math.sin(this.vasoPhase) + this.vasomotionDrift.next());
    return riiv + vaso + this.amplitudeDrift.next() * 0.25;
  }

  get currentIbiSec(): number {
    return this.lastIbiSec;
  }

  get currentMorphology(): PulseMorphology {
    return this.active.length
      ? this.active[this.active.length - 1].m
      : morphologyFor(this.subject, this.lastIbiSec);
  }
}

/**
 * Perfusion index actually presented to the sensor, in percent AC/DC.
 *
 * Wrist green-light PPG is far weaker than the fingertip transmissive signal
 * most textbook figures show: 0.2-2% is the normal wrist band against 1-10% at
 * the finger (Allen 2007). Vasodilation from exercise or warmth raises it;
 * cold, stress-driven vasoconstriction and band over-tightening cut it.
 */
export function perfusionIndexPercent(
  subject: SubjectProfile,
  activity: ActivityProfile,
  wear: WearConfig,
): number {
  let pi = 0.95 * activity.perfusionScale;

  // Skin temperature: vasoconstriction below ~30 C collapses peripheral flow.
  pi *= clamp(0.35 + 0.065 * (wear.skinTempC - 26), 0.3, 1.35);

  // Subcutaneous tissue between the sensor and the vasculature.
  pi *= clamp(1.18 - 0.018 * (subject.bmi - 22), 0.65, 1.2);

  // Age-related reduction in peripheral pulsatility.
  pi *= clamp(1.12 - 0.005 * subject.age, 0.72, 1.12);

  // Band mechanics: too loose lifts the sensor off the skin, too tight occludes.
  const tight = clamp(wear.bandTightness, 0, 1);
  const contact = tight < 0.55 ? 0.45 + (tight / 0.55) * 0.55 : 1 - (tight - 0.55) * 0.85;
  pi *= clamp(contact, 0.2, 1);

  // Sitting over the ulnar styloid instead of soft tissue costs signal.
  pi *= clamp(0.62 + wear.placementMm / 45, 0.62, 1);

  return clamp(pi, 0.05, 4.0);
}

/**
 * Wavelength-dependent scaling of the pulsatile signal.
 *
 * Green (~525 nm) is absorbed strongly by haemoglobin and penetrates only ~1 mm,
 * which gives the largest relative pulse at the wrist and the best motion
 * tolerance — but melanin also absorbs strongly at 525 nm, so the same LED
 * current returns progressively less modulated light at higher Fitzpatrick
 * phototypes. Infrared penetrates further, is nearly indifferent to melanin,
 * and picks up correspondingly more motion-induced venous modulation.
 */
export function wavelengthGain(
  wavelength: 'green' | 'red' | 'ir',
  fitzpatrick: number,
): { acGain: number; dcGain: number; melaninLoss: number } {
  const melanin = clamp((fitzpatrick - 1) / 5, 0, 1);
  switch (wavelength) {
    case 'green': {
      const melaninLoss = 1 - 0.55 * melanin;
      return { acGain: 1.0 * melaninLoss, dcGain: 0.45, melaninLoss };
    }
    case 'red': {
      const melaninLoss = 1 - 0.22 * melanin;
      return { acGain: 0.46 * melaninLoss, dcGain: 0.78, melaninLoss };
    }
    case 'ir':
    default: {
      const melaninLoss = 1 - 0.1 * melanin;
      return { acGain: 0.62 * melaninLoss, dcGain: 1.0, melaninLoss };
    }
  }
}

/**
 * Ratio-of-ratios implied by a true SpO2, inverting the standard empirical
 * calibration SpO2 = 110 - 25R used by most pulse oximeters.
 */
export function spo2ToRatio(spo2: number): number {
  return clamp((110 - spo2) / 25, 0.3, 1.6);
}
