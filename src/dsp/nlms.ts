/**
 * Multi-reference normalised least-mean-squares adaptive filter.
 *
 * This is the workhorse of accelerometer-referenced motion-artefact removal.
 * The three accelerometer axes are each convolved with their own adaptive FIR
 * response, the sum is the filter's estimate of the artefact, and the output is
 * whatever the raw signal has left after subtracting it.
 *
 * The key property, and the reason this works at all: the pulse is uncorrelated
 * with wrist acceleration, so the least-mean-squares solution converges on the
 * artefact and leaves the pulse behind. The key limitation, and the reason it
 * never works completely: the real coupling has a non-linear term, and no FIR
 * filter can represent one.
 *
 * Normalisation by the reference power is what makes the step size safe across
 * the 300-fold range of accelerations between sleep and sprinting; a plain LMS
 * with a fixed step size that is stable while running is uselessly slow at rest.
 */
export class NlmsCanceller {
  private readonly w: Float64Array;
  private readonly x: Float64Array;
  private readonly refs: number;
  private readonly taps: number;
  private pos = 0;
  private refPower = 1e-6;
  /** 0..1 crossfade driven by how much the wrist is actually moving. */
  private gate = 0;
  /** Regularisation, in reference-power units, that bounds the step size. */
  private readonly delta = 1e-3;

  /** Leakage keeps the weights from drifting during long quiet stretches. */
  private readonly leak = 1 - 1e-6;

  /** Samples of gated adaptation so far, for the step-size schedule. */
  private adaptSamples = 0;
  /** Reference power at the last regime check, for change detection. */
  private regimePower = 0;

  constructor(
    taps: number,
    refs = 3,
    private mu = 0.01,
    private readonly sampleRate = 128,
  ) {
    this.taps = Math.max(2, taps);
    this.refs = refs;
    this.w = new Float64Array(this.taps * refs);
    this.x = new Float64Array(this.taps * refs);
  }

  /**
   * Variable step size: fast to acquire, slow to track.
   *
   * A step small enough to avoid cancelling the pulse during walking takes the
   * better part of a minute to converge from cold, which would mean a minute of
   * wrong heart rate every time someone starts moving. A step large enough to
   * converge quickly chews into the signal once it has. Annealing from one to
   * the other gives both, and the schedule restarts whenever the motion regime
   * changes enough that the previously learnt coupling no longer applies.
   */
  private effectiveMu(): number {
    const fast = this.mu * 8;
    const tau = this.sampleRate * 6;
    return this.mu + (fast - this.mu) * Math.exp(-this.adaptSamples / tau);
  }

  setMu(mu: number): void {
    this.mu = mu;
  }

  reset(): void {
    this.w.fill(0);
    this.x.fill(0);
    this.pos = 0;
    this.refPower = 1e-6;
    this.gate = 0;
    this.adaptSamples = 0;
    this.regimePower = 0;
  }

  /** Current step size after the acquisition schedule. */
  get stepSize(): number {
    return this.effectiveMu();
  }

  /** 0..1 — how much of the canceller's estimate is currently being applied. */
  get gateLevel(): number {
    return this.gate;
  }

  /** Current adaptive-filter energy — a usable proxy for how hard it is working. */
  get weightNorm(): number {
    let s = 0;
    for (let i = 0; i < this.w.length; i++) s += this.w[i] * this.w[i];
    return Math.sqrt(s);
  }

  /**
   * Process one sample.
   * @param d   the signal containing pulse + artefact
   * @param ref one value per reference channel at this instant
   * @returns   the artefact estimate and the cleaned output
   */
  step(d: number, ref: number[]): { clean: number; estimate: number } {
    const T = this.taps;
    // Shift each reference channel's delay line. `pos` is the newest index.
    this.pos = (this.pos - 1 + T) % T;
    for (let r = 0; r < this.refs; r++) {
      this.x[r * T + this.pos] = ref[r] ?? 0;
    }

    let estimate = 0;
    let power = 0;
    for (let r = 0; r < this.refs; r++) {
      const base = r * T;
      for (let k = 0; k < T; k++) {
        const v = this.x[base + ((this.pos + k) % T)];
        estimate += this.w[base + k] * v;
        power += v * v;
      }
    }

    // Track reference power with a slow average so the normalisation does not
    // jitter sample to sample.
    this.refPower += 0.02 * (power - this.refPower);

    // Motion gate.
    //
    // Without this the filter is actively harmful at rest. With almost no
    // acceleration to work with, normalised LMS divides by a vanishing
    // reference power, the weights grow without bound trying to explain a pulse
    // that is uncorrelated with anything in the reference, and the canceller
    // injects more noise than the motion it was installed to remove. Real
    // products gate the same way: below a movement threshold there is nothing
    // to cancel, so the stage steps aside.
    const refRms = Math.sqrt(this.refPower / (this.taps * this.refs));
    this.gate += 0.02 * (smoothstep(GATE_LOW, GATE_HIGH, refRms) - this.gate);

    const estimateGated = estimate * this.gate;
    const clean = d - estimateGated;

    // A large, sustained change in reference power means a new activity: the
    // learnt coupling is stale, so re-open the step-size schedule.
    if (this.regimePower <= 0) this.regimePower = this.refPower;
    const ratio = this.refPower / Math.max(1e-9, this.regimePower);
    if (ratio > 4 || ratio < 0.25) {
      this.regimePower = this.refPower;
      this.adaptSamples = Math.min(this.adaptSamples, this.sampleRate * 2);
    } else {
      this.regimePower += 0.0005 * (this.refPower - this.regimePower);
    }

    if (this.gate > 0.02) {
      this.adaptSamples++;
      // Error used for adaptation is the ungated residual, so the filter keeps
      // converging on the true coupling rather than on its own gated output.
      const err = d - estimate;
      const norm = this.refPower + this.delta;
      const g = (this.effectiveMu() * this.gate * err) / norm;
      for (let r = 0; r < this.refs; r++) {
        const base = r * T;
        for (let k = 0; k < T; k++) {
          const v = this.x[base + ((this.pos + k) % T)];
          this.w[base + k] = this.w[base + k] * this.leak + g * v;
        }
      }
    }

    return { clean, estimate: estimateGated };
  }
}

/** Acceleration below this (g rms) is treated as no motion at all. */
const GATE_LOW = 0.015;
/** Above this the canceller runs at full strength. */
const GATE_HIGH = 0.06;

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}
