/**
 * Heart-rate fusion.
 *
 * A beat detector and a spectral estimator fail in opposite conditions, which
 * is why every serious wrist tracker runs both.
 *
 *   - The beat detector is precise when the signal is clean: it gives real
 *     beat times, and therefore the only interval series HRV can be computed
 *     from. It degrades ungracefully — under heavy motion it does not get
 *     noisier so much as it locks onto a harmonic.
 *   - The spectral estimator cannot give beat times and so is useless for HRV,
 *     but it survives an artefact many times larger than the pulse, because the
 *     pulse still has a peak in the spectrum even when it has no visible peak
 *     in the waveform.
 *
 * Fusing them takes three steps: correct the detector when it has clearly
 * landed on a harmonic, blend the two by confidence, then slew-limit the
 * result. The slew limit is physiology, not smoothing — a heart rate cannot
 * step by 80 bpm between one second and the next, so an estimate that does is
 * wrong regardless of how confident either estimator is.
 */

export type RateSource = 'detector' | 'spectral' | 'fused';

export interface RateEstimate {
  /** Fused heart rate, bpm. */
  hr: number;
  source: RateSource;
  /** True when the detector rate was snapped off a harmonic. */
  harmonicCorrected: boolean;
  /** 0-1 confidence in the fused value. */
  confidence: number;
  /** Weight given to the beat detector in the blend, 0-1. */
  detectorWeight: number;
  /**
   * False when neither estimator is confident enough to be believed. The value
   * is then held rather than updated, and the UI must say so — a tracker that
   * keeps printing a confident number after it has lost the pulse is worse
   * than one that admits it.
   */
  reliable: boolean;
}

/** Relative spread within which the two estimators are taken to agree. */
const AGREEMENT_SPREAD = 0.12;
/** Maximum physiological rate of change, bpm per second. */
const MAX_SLEW_BPM_PER_SEC = 14;
/** Below this combined confidence the estimate is marked unreliable. */
const HOLD_CONFIDENCE = 0.14;
/** Fraction of the normal slew rate allowed while the signal is untrusted. */
const UNTRUSTED_SLEW_SCALE = 0.22;

export class RateTracker {
  private hr = 0;
  private lastHarmonicCorrected = false;

  reset(): void {
    this.hr = 0;
    this.lastHarmonicCorrected = false;
  }

  get current(): number {
    return this.hr;
  }

  update(
    detectorHr: number,
    detectorConfidence: number,
    spectralHr: number,
    spectralConfidence: number,
    dtSec: number,
    /**
     * Whether the signal is good enough to move the estimate at all. Passed in
     * from the quality stage: a strong, regular motion artefact can make both
     * estimators *confident* without either being *right*, and confidence in a
     * wrong answer is the one thing a vital-sign display must never show.
     */
    signalTrustworthy = true,
  ): RateEstimate {
    const hasDetector = detectorHr > 25 && detectorHr < 230;
    const hasSpectral = spectralHr > 25 && spectralHr < 230 && spectralConfidence > 0.05;

    let dHr = detectorHr;
    let harmonicCorrected = false;

    // --- 1. Harmonic correction.
    // If the detector is sitting at very nearly half or double the spectral
    // estimate, it is counting every other beat or counting the dicrotic notch.
    // Either is a discrete error, not a noisy one, so it is snapped rather than
    // averaged away.
    // The correction only fires when the spectrum is clearly the better witness.
    // A merely comparable spectral estimate is not enough: during walking the
    // cadence harmonic is a tall, stable peak at exactly twice the heart rate,
    // and letting it "correct" a beat detector that was right all along is how
    // a tracker turns a good reading into a doubled one.
    const spectrumIsBetterWitness =
      spectralConfidence > 0.3 && spectralConfidence > detectorConfidence * 1.15;
    if (hasDetector && hasSpectral && spectrumIsBetterWitness) {
      const candidates = [detectorHr, detectorHr * 2, detectorHr / 2];
      let best = detectorHr;
      let bestErr = Math.abs(detectorHr - spectralHr);
      for (const c of candidates) {
        const err = Math.abs(c - spectralHr);
        if (err < bestErr - 1e-9 && c > 25 && c < 230) {
          bestErr = err;
          best = c;
        }
      }
      if (best !== detectorHr && bestErr < 0.12 * spectralHr) {
        dHr = best;
        harmonicCorrected = true;
      }
    }

    // --- 2. Confidence-weighted blend.
    const dc = hasDetector ? Math.max(0, Math.min(1, detectorConfidence)) : 0;
    const sc = hasSpectral ? Math.max(0, Math.min(1, spectralConfidence)) : 0;
    const total = dc + sc;

    let target: number;
    let source: RateSource;
    let detectorWeight: number;
    if (total <= 1e-6) {
      target = this.hr || detectorHr || spectralHr;
      source = 'detector';
      detectorWeight = 1;
    } else if (!hasSpectral) {
      target = dHr;
      source = 'detector';
      detectorWeight = 1;
    } else if (!hasDetector) {
      target = spectralHr;
      source = 'spectral';
      detectorWeight = 0;
    } else {
      const spread = Math.abs(dHr - spectralHr) / Math.max(dHr, spectralHr);
      if (spread < AGREEMENT_SPREAD) {
        // They agree on which peak is the pulse; averaging reduces the noise.
        detectorWeight = dc / total;
        target = detectorWeight * dHr + (1 - detectorWeight) * spectralHr;
        source = detectorWeight > 0.8 ? 'detector' : detectorWeight < 0.2 ? 'spectral' : 'fused';
      } else {
        // They disagree about *which* peak is the pulse. This is a choice
        // between two hypotheses, not a noisy measurement of one: the average
        // of 91 and 182 is 136, which is not a rate anyone's heart is beating
        // at. Pick the more confident estimator outright.
        const pickDetector = dc >= sc;
        detectorWeight = pickDetector ? 1 : 0;
        target = pickDetector ? dHr : spectralHr;
        source = pickDetector ? 'detector' : 'spectral';
      }
    }

    const reliable = total >= HOLD_CONFIDENCE && signalTrustworthy;

    // --- 3. Physiological slew limit.
    if (this.hr <= 0) {
      this.hr = target;
    } else {
      // When the signal is not trustworthy the estimate still moves, but far
      // more slowly. A hard freeze looks decisive and behaves badly: a sprint
      // that starts from rest would sit at the resting rate for its whole
      // duration. Crawling toward the evidence keeps the display converging
      // while refusing to chase second-to-second noise.
      const slew = reliable ? MAX_SLEW_BPM_PER_SEC : MAX_SLEW_BPM_PER_SEC * UNTRUSTED_SLEW_SCALE;
      const maxStep = slew * Math.max(0.05, dtSec);
      const delta = target - this.hr;
      this.hr += Math.max(-maxStep, Math.min(maxStep, delta));
    }

    this.lastHarmonicCorrected = harmonicCorrected;
    return {
      hr: this.hr,
      source,
      harmonicCorrected,
      confidence: Math.max(0, Math.min(1, total / 1.4)),
      detectorWeight,
      reliable,
    };
  }

  get wasHarmonicCorrected(): boolean {
    return this.lastHarmonicCorrected;
  }
}
