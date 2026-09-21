import { RunningStats, median } from './filters';

/**
 * Signal-quality assessment.
 *
 * No single statistic identifies a usable PPG segment, so four complementary
 * ones are fused, following the approach in Elgendi (2012) and Liang et al.
 * (2018) on PPG quality indices:
 *
 *   - Skewness. A clean PPG is strongly right-skewed because the systolic peak
 *     is narrow and the diastolic trough is broad. Motion artefact is roughly
 *     symmetric, so skewness collapses toward zero. This is the single best
 *     one-number quality index published for PPG.
 *   - Template correlation. Consecutive beats from a real pulse look alike;
 *     artefact beats do not. Each beat is resampled onto a fixed grid and
 *     correlated against a running average template.
 *   - Interval regularity. Physiological intervals vary smoothly; detection
 *     failures produce halves and doubles.
 *   - Perfusion. If the pulsatile component is small relative to the noise
 *     floor, nothing downstream can be trusted regardless of how it looks.
 */

export type QualityBand = 'excellent' | 'good' | 'fair' | 'poor' | 'unusable';

export interface SignalQuality {
  /** Fused 0-100 score. */
  score: number;
  band: QualityBand;
  skewness: number;
  /** 0-1 mean correlation of recent beats against the running template. */
  templateCorrelation: number;
  /** 0-1 regularity of the accepted interval series. */
  intervalRegularity: number;
  /** Measured AC/DC ratio in percent, as the pipeline sees it. */
  perfusionIndexPct: number;
  /** Fraction of recent samples that hit the ADC rail. */
  clippedFraction: number;
  /** The dominant limiting factor, for the UI to name. */
  limitingFactor: string;
}

export const QUALITY_BANDS: Record<QualityBand, { label: string; min: number }> = {
  excellent: { label: 'Excellent', min: 85 },
  good: { label: 'Good', min: 68 },
  fair: { label: 'Fair', min: 48 },
  poor: { label: 'Poor', min: 25 },
  unusable: { label: 'Unusable', min: 0 },
};

export function bandFor(score: number): QualityBand {
  if (score >= 85) return 'excellent';
  if (score >= 68) return 'good';
  if (score >= 48) return 'fair';
  if (score >= 25) return 'poor';
  return 'unusable';
}

const TEMPLATE_LEN = 64;

/**
 * Running average beat template with per-beat correlation scoring.
 * Beats are time-normalised onto a fixed grid before averaging, so the template
 * stays meaningful as heart rate changes.
 */
export class BeatTemplate {
  private template = new Float64Array(TEMPLATE_LEN);
  private count = 0;
  private correlations: number[] = [];

  reset(): void {
    this.template.fill(0);
    this.count = 0;
    this.correlations = [];
  }

  /** Resample a beat segment onto the fixed grid and score it. */
  addBeat(segment: Float64Array): number {
    if (segment.length < 8) return 0;
    const norm = new Float64Array(TEMPLATE_LEN);
    for (let i = 0; i < TEMPLATE_LEN; i++) {
      const pos = (i / (TEMPLATE_LEN - 1)) * (segment.length - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(segment.length - 1, i0 + 1);
      const frac = pos - i0;
      norm[i] = segment[i0] * (1 - frac) + segment[i1] * frac;
    }
    zScore(norm);

    let r = 0;
    if (this.count >= 3) {
      r = pearson(norm, this.template);
      this.correlations.push(r);
      if (this.correlations.length > 12) this.correlations.shift();
    }

    // Exponential update keeps the template current as morphology changes.
    const alpha = this.count < 8 ? 1 / (this.count + 1) : 0.12;
    for (let i = 0; i < TEMPLATE_LEN; i++) {
      this.template[i] += alpha * (norm[i] - this.template[i]);
    }
    this.count++;
    return r;
  }

  get meanCorrelation(): number {
    if (!this.correlations.length) return 0;
    let s = 0;
    for (const c of this.correlations) s += c;
    return s / this.correlations.length;
  }

  get shape(): Float64Array {
    return this.template;
  }

  get beatsSeen(): number {
    return this.count;
  }
}

function zScore(a: Float64Array): void {
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
  const sd = Math.sqrt(v / a.length) || 1;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - m) / sd;
}

function pearson(a: Float64Array, b: Float64Array): number {
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += a[i] * b[i];
    da += a[i] * a[i];
    db += b[i] * b[i];
  }
  const den = Math.sqrt(da * db) || 1e-12;
  return num / den;
}

export interface QualityInputs {
  /** Recent filtered samples, for skewness. */
  stats: RunningStats;
  templateCorrelation: number;
  recentIbisMs: number[];
  perfusionIndexPct: number;
  clippedFraction: number;
  /** Rejected fraction of recent detections. */
  rejectedFraction: number;
  /**
   * Agreement between the beat-detector rate and the spectral rate, 0-1.
   *
   * The shape-based indices above measure whether the signal is *consistent*,
   * not whether it is *right* — a strong, regular motion artefact scores well
   * on every one of them. Cross-checking two independent rate estimates is
   * what catches that case.
   */
  spectralAgreement: number;
}

export function assessQuality(input: QualityInputs): SignalQuality {
  const skew = input.stats.skewness();

  // A clean band-passed wrist PPG skews positive but only modestly — the
  // textbook 0.5-1.5 figures are for raw fingertip traces, where the DC
  // pedestal and the much larger pulse exaggerate the asymmetry.
  const skewTerm = clamp01((skew + 0.1) / 0.6);

  const corrTerm = clamp01((input.templateCorrelation - 0.25) / 0.7);

  let regularity = 0;
  if (input.recentIbisMs.length >= 4) {
    const med = median(input.recentIbisMs);
    let dev = 0;
    for (const v of input.recentIbisMs) dev += Math.abs(v - med) / Math.max(1, med);
    dev /= input.recentIbisMs.length;
    regularity = clamp01(1 - dev / 0.28);
  }

  // Wrist green PPG normally sits between 0.2% and 2% AC/DC; below roughly
  // 0.1% there is nothing left above the noise floor.
  const perfTerm = clamp01((input.perfusionIndexPct - 0.05) / 0.55);

  const agreeTerm = clamp01(input.spectralAgreement);

  let score =
    100 *
    (0.27 * skewTerm + 0.22 * corrTerm + 0.15 * regularity + 0.16 * perfTerm + 0.2 * agreeTerm);

  // Hard penalties: clipping and detection failures are disqualifying, not
  // just unfortunate.
  score *= 1 - clamp01(input.clippedFraction * 3);
  score *= 1 - 0.7 * clamp01(input.rejectedFraction * 2.2);

  const factors: Array<[string, number]> = [
    ['Waveform shape lost to artefact', skewTerm],
    ['Beats no longer resemble each other', corrTerm],
    ['Interval series irregular', regularity],
    ['Pulse too small relative to noise', perfTerm],
    ['Beat rate disagrees with the spectrum', agreeTerm],
  ];
  factors.sort((a, b) => a[1] - b[1]);
  let limitingFactor = factors[0][1] > 0.8 ? 'No significant limitation' : factors[0][0];
  if (input.clippedFraction > 0.01) limitingFactor = 'ADC clipping — reduce LED current or ambient light';

  const finalScore = clamp01(score / 100) * 100;
  return {
    score: finalScore,
    band: bandFor(finalScore),
    skewness: skew,
    templateCorrelation: input.templateCorrelation,
    intervalRegularity: regularity,
    perfusionIndexPct: input.perfusionIndexPct,
    clippedFraction: input.clippedFraction,
    limitingFactor,
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
