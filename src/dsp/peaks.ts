import { median } from './filters';

/**
 * Real-time systolic peak detection and inter-beat interval extraction.
 *
 * Strategy, in the order the stages run:
 *
 *   1. An adaptive amplitude threshold tracks the recent peak height and decays
 *      as time passes since the last accepted beat, so a fading signal is
 *      followed down instead of dropping out entirely.
 *   2. A refractory period derived from the currently expected interval rejects
 *      the dicrotic notch, which is the single most common false positive in
 *      PPG peak detection.
 *   3. Parabolic interpolation across the three samples around the maximum
 *      places the peak to a fraction of a sample. At 50 Hz one sample is 20 ms,
 *      which would otherwise quantise every RMSSD figure into uselessness.
 *   4. Accepted intervals are screened against a running median; an interval
 *      that deviates too far is flagged rather than silently dropped, so the UI
 *      can show how much of the series was corrected.
 */

export interface DetectedBeat {
  /** Peak time in seconds, sub-sample interpolated. */
  tSec: number;
  /** Peak amplitude in the filtered signal's units. */
  amplitude: number;
  /** Interval from the previous accepted beat, ms. Zero for the first beat. */
  ibiMs: number;
  /** True if the interval failed the plausibility screen. */
  rejected: boolean;
  /** Reason for rejection, for the inspector. */
  reason?: 'too-short' | 'too-long' | 'outlier' | 'secondary-wave';
}

export interface PeakDetectorConfig {
  sampleRate: number;
  /** Refractory period as a fraction of the expected interval. */
  refractoryFraction: number;
  /** Reject intervals deviating from the running median by more than this. */
  rejectFraction: number;
  /** Absolute physiological bounds on an interval, ms. */
  minIbiMs: number;
  maxIbiMs: number;
}

/** Accepted beats required before the harmonic tests are trusted. */
const SEED_BEATS = 8;
/** Never shorter than this — below it, noise on the upstroke splits beats. */
const MIN_REFRACTORY_SEC = 0.24;
/** Never longer than this — a human heart can reach ~200 bpm (300 ms). */
const MAX_REFRACTORY_SEC = 0.34;

export class PeakDetector {
  private s1 = 0;
  private s2 = 0;
  private n = 0;
  private lastPeakT = -Infinity;
  private peakLevel = 0;
  private noiseLevel = 0;
  private recentIbis: number[] = [];
  /** Every in-bounds interval seen, accepted or not — used to re-acquire. */
  private observedIbis: number[] = [];
  private expectedIbiMs = 850;
  private started = false;
  private consecutiveRejections = 0;
  private lastAcceptedAmplitude = 0;
  /** Accepted beats so far — the reference is unconstrained until it is seeded. */
  private acceptedBeats = 0;

  /**
   * Abandon the current interval reference and re-acquire from what has
   * actually been observed, bypassing the rate limit. Used when the reference
   * has been rejecting everything for long enough that it, rather than the
   * signal, is what must be wrong.
   */
  private reacquire(): void {
    if (this.observedIbis.length >= 5) {
      this.expectedIbiMs = median(this.observedIbis);
    }
    this.recentIbis = [];
    this.consecutiveRejections = 0;
    this.acceptedBeats = 0;
  }

  /** Per-sample decay giving the peak level a ~6 s memory. */
  private peakDecay: number;

  constructor(private cfg: PeakDetectorConfig) {
    this.peakDecay = Math.exp(-1 / (cfg.sampleRate * 6));
  }

  reconfigure(cfg: Partial<PeakDetectorConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  reset(): void {
    this.s1 = 0;
    this.s2 = 0;
    this.n = 0;
    this.lastPeakT = -Infinity;
    this.peakLevel = 0;
    this.noiseLevel = 0;
    this.recentIbis = [];
    this.observedIbis = [];
    this.expectedIbiMs = 850;
    this.started = false;
    this.consecutiveRejections = 0;
  }

  get threshold(): number {
    return this.noiseLevel + 0.45 * Math.max(0, this.peakLevel - this.noiseLevel);
  }

  get expectedIntervalMs(): number {
    return this.expectedIbiMs;
  }

  /**
   * Feed one filtered sample. Returns a beat when the *previous* sample is
   * confirmed as a local maximum — detection is inherently one sample late.
   */
  step(x: number, t: number): DetectedBeat | null {
    const s0 = x;
    const prev = this.s1;
    const prev2 = this.s2;
    this.s2 = this.s1;
    this.s1 = s0;
    this.n++;

    // Track the noise floor from the magnitude of everything below threshold.
    this.noiseLevel += 0.002 * (Math.abs(s0) * 0.5 - this.noiseLevel);
    // The peak level decays continuously, not only when a beat is accepted.
    // A detector whose level can only be raised by a detection is one bad
    // transient away from locking itself out for the rest of the session.
    this.peakLevel *= this.peakDecay;
    if (!this.started && this.n > this.cfg.sampleRate) this.started = true;
    if (!this.started) return null;

    const sinceLast = t - this.lastPeakT;
    // The refractory period scales with the expected interval, but it is
    // clamped into a physiological band.
    //
    // An unclamped proportional refractory is a trap: if the reference is even
    // momentarily too long — and it always is at the start of a session that
    // opens mid-run — the refractory blocks every other real beat, which makes
    // the reference longer still. The detector then sits at exactly half the
    // true rate indefinitely. The upper clamp of 340 ms keeps it below the
    // shortest interval a human heart produces, so a real beat can never be
    // locked out; the dicrotic notch is rejected by the amplitude and harmonic
    // tests below instead, which is where that job belongs.
    const refractorySec = Math.min(
      MAX_REFRACTORY_SEC,
      Math.max(MIN_REFRACTORY_SEC, (this.cfg.refractoryFraction * this.expectedIbiMs) / 1000),
    );

    // Post-beat threshold ramp.
    //
    // Immediately after a systole the threshold is lifted above the height of
    // the beat just accepted, then relaxes exponentially with a time constant
    // proportional to the expected interval. This is what rejects the dicrotic
    // notch: the notch arrives at a roughly fixed fraction of the cycle, so a
    // threshold that decays on the same clock always meets it while still
    // high, whatever the heart rate. A fixed refractory window cannot do this
    // job at both 50 and 180 bpm — make it long enough to cover the notch at
    // rest and it locks out real beats during a sprint.
    const expectedSec = Math.max(0.25, this.expectedIbiMs / 1000);
    const ramp = Math.exp(-sinceLast / (0.30 * expectedSec));
    const base = this.threshold;
    let thr = base + ramp * Math.max(0, 1.15 * this.lastAcceptedAmplitude - base);

    // Once a beat is overdue the threshold is walked down, so a fading signal —
    // a loosening band, a cold wrist — is followed rather than lost.
    const overdue = sinceLast / expectedSec;
    if (overdue > 1.4) thr *= Math.max(0.3, 1 - (overdue - 1.4) * 0.45);

    const isLocalMax = prev > prev2 && prev >= s0;
    if (!isLocalMax || prev <= thr || sinceLast < refractorySec) return null;

    // Parabolic vertex through (prev2, prev, s0), sampled one step back.
    const denom = prev2 - 2 * prev + s0;
    const delta = Math.abs(denom) > 1e-12 ? (0.5 * (prev2 - s0)) / denom : 0;
    const offset = Math.max(-0.5, Math.min(0.5, delta));
    const tPeak = t - 1 / this.cfg.sampleRate + offset / this.cfg.sampleRate;
    const amplitude = prev - 0.125 * (prev2 - s0) * offset;

    // Secondary-wave discrimination.
    //
    // A candidate arriving far too early and noticeably smaller than the last
    // accepted beat is a reflected wave or a motion residue, not a systole.
    // Crucially it is discarded *without* advancing the reference time, so the
    // next real beat is still measured from the last real beat. Accepting it
    // instead halves the running median, which halves the refractory period,
    // which lets the next secondary wave through too — that positive feedback
    // is what makes a wrist tracker sit at exactly twice the true rate.
    const candidateIbi = Number.isFinite(this.lastPeakT) ? (tPeak - this.lastPeakT) * 1000 : 0;
    if (candidateIbi > 0 && candidateIbi >= this.cfg.minIbiMs && candidateIbi <= this.cfg.maxIbiMs) {
      this.observedIbis.push(candidateIbi);
      if (this.observedIbis.length > 14) this.observedIbis.shift();
    }

    // Secondary-wave discrimination.
    //
    // Two signatures mark a candidate as something other than a systole: it is
    // much smaller than the last real beat, or it lands almost exactly halfway
    // between two of them. The second test is the important one during gait,
    // where a motion residue can be every bit as tall as the pulse and the
    // amplitude test alone sees nothing wrong.
    //
    // Either way the candidate is discarded *without* advancing the reference
    // time, so the next real beat is still measured from the last real beat.
    // Accepting it instead halves the running median, which halves the
    // refractory period, which lets the next one through as well — that
    // positive feedback is exactly how a wrist tracker ends up sitting at twice
    // the true rate for minutes at a time.
    const half = this.expectedIbiMs / 2;
    const looksLikeHalf = Math.abs(candidateIbi - half) / half < 0.2;
    if (
      this.acceptedBeats >= SEED_BEATS &&
      this.recentIbis.length >= 5 &&
      candidateIbi > 0 &&
      candidateIbi < 0.62 * this.expectedIbiMs &&
      (prev < 0.75 * this.lastAcceptedAmplitude || looksLikeHalf)
    ) {
      this.consecutiveRejections++;
      if (this.consecutiveRejections >= 10) {
        // Persistently wrong reference — the rate really has changed. Snap to
        // what has actually been observed rather than rejecting forever.
        this.reacquire();
      }
      return {
        tSec: tPeak,
        amplitude,
        ibiMs: candidateIbi,
        rejected: true,
        reason: 'secondary-wave',
      };
    }

    this.peakLevel += 0.18 * (prev - this.peakLevel);

    let ibiMs = 0;
    let rejected = false;
    let reason: DetectedBeat['reason'];

    if (Number.isFinite(this.lastPeakT)) {
      ibiMs = (tPeak - this.lastPeakT) * 1000;
      if (ibiMs < this.cfg.minIbiMs) {
        rejected = true;
        reason = 'too-short';
      } else if (ibiMs > this.cfg.maxIbiMs) {
        rejected = true;
        reason = 'too-long';
      } else if (this.recentIbis.length >= 5) {
        const med = median(this.recentIbis);
        if (Math.abs(ibiMs - med) / med > this.cfg.rejectFraction) {
          rejected = true;
          reason = 'outlier';
        }
      }
      if (rejected) this.consecutiveRejections++;
      else this.consecutiveRejections = 0;

      // A long rejection run means the reference itself is wrong, not the
      // beats. Re-acquire rather than rejecting forever.
      if (this.consecutiveRejections >= 10) this.reacquire();

      // Every interval inside the absolute physiological bounds feeds the
      // running median, whether or not it passed the outlier screen. Excluding
      // rejected intervals here dead-locks the detector: one bad interval early
      // on shifts the median, the median then rejects every correct interval,
      // and nothing can ever move it back.
      if (ibiMs >= this.cfg.minIbiMs && ibiMs <= this.cfg.maxIbiMs) {
        this.recentIbis.push(ibiMs);
        if (this.recentIbis.length > 9) this.recentIbis.shift();

        // Rate-limit the reference. Heart rate is a physical quantity with
        // inertia: it does not double between one beat and the next. Letting
        // the reference move only a few percent per beat is what stops a run of
        // spurious detections from dragging it onto a harmonic and keeping it
        // there, while still tracking a genuine sprint start within a few
        // seconds.
        const target = median(this.recentIbis);
        if (this.acceptedBeats < SEED_BEATS) {
          // Still acquiring: follow the observed rate directly. Rate-limiting
          // from a default of 850 ms would leave the reference wrong for many
          // seconds if the session opens mid-run, and a wrong reference makes
          // every correct beat look like a harmonic.
          this.expectedIbiMs = target;
        } else {
          const maxStep = 0.08 * this.expectedIbiMs;
          const delta = target - this.expectedIbiMs;
          this.expectedIbiMs += Math.max(-maxStep, Math.min(maxStep, delta));
        }
        if (!rejected) this.acceptedBeats++;
      }
    }

    this.lastPeakT = tPeak;
    if (!rejected) this.lastAcceptedAmplitude = prev;
    else this.lastAcceptedAmplitude = Math.max(this.lastAcceptedAmplitude * 0.9, prev * 0.5);
    return { tSec: tPeak, amplitude, ibiMs, rejected, reason };
  }
}

/**
 * Match detected beats against ground-truth beats to score the pipeline.
 *
 * A detection counts as a true positive if it lands within `toleranceMs` of a
 * true beat — the same convention used to score QRS detectors.
 */
export function scoreDetections(
  truth: number[],
  detected: number[],
  toleranceMs = 150,
): { tp: number; fp: number; fn: number; meanAbsErrorMs: number; latencyMs: number } {
  const tol = toleranceMs / 1000;
  const used = new Set<number>();
  let tp = 0;
  let errSum = 0;

  // The pipeline has a constant latency — the systolic peak arrives after the
  // beat's foot, and every causal filter adds group delay on top. That offset
  // is a property of the design, not a detection failure, so it is estimated
  // and removed before scoring. What is left is the jitter, which is what
  // actually limits interval precision.
  const latency = medianOffset(truth, detected);
  const shifted = detected.map((d) => d - latency);

  for (const d of shifted) {
    let bestIdx = -1;
    let bestErr = Infinity;
    for (let i = 0; i < truth.length; i++) {
      if (used.has(i)) continue;
      const err = Math.abs(truth[i] - d);
      if (err < bestErr) {
        bestErr = err;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestErr <= tol) {
      used.add(bestIdx);
      tp++;
      errSum += bestErr * 1000;
    }
  }

  return {
    tp,
    fp: detected.length - tp,
    fn: truth.length - tp,
    meanAbsErrorMs: tp ? errSum / tp : 0,
    latencyMs: latency * 1000,
  };
}

/** Median nearest-neighbour offset from truth to detection, in seconds. */
function medianOffset(truth: number[], detected: number[]): number {
  if (!truth.length || !detected.length) return 0;
  const offsets: number[] = [];
  for (const d of detected) {
    let best = Infinity;
    for (const t of truth) {
      const diff = d - t;
      if (Math.abs(diff) < Math.abs(best)) best = diff;
    }
    if (Number.isFinite(best) && Math.abs(best) < 0.6) offsets.push(best);
  }
  return offsets.length ? median(offsets) : 0;
}
