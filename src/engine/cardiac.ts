import type { ActivityProfile, SubjectProfile } from './types';
import { PinkNoise, clamp, makeGaussian, makeRng, remap } from './rng';

/**
 * Cardiac rhythm generator.
 *
 * Produces a beat train whose inter-beat intervals carry the oscillatory
 * structure real HRV has, rather than a mean rate plus white noise:
 *
 *   - respiratory sinus arrhythmia at the current breathing rate (HF, 0.15-0.4 Hz)
 *   - Mayer waves near 0.1 Hz from baroreflex loop gain (LF, 0.04-0.15 Hz)
 *   - a very-low-frequency term near 0.03 Hz (VLF)
 *   - 1/f (pink) noise, which is what gives a tachogram its characteristic
 *     long-range correlation and a Poincare plot its comet shape
 *   - optional ectopic beats with a compensatory pause
 *
 * The amplitudes of the first two are set per activity from the autonomic
 * profile, then scaled for the subject: HRV amplitude falls with age and with
 * heart rate, and rises with aerobic fitness.
 *
 * Beat timing uses an integral pulse frequency modulation (IPFM) accumulator,
 * which is the standard way to turn a continuous modulating signal into an
 * event series without accumulating phase error.
 */

export interface Beat {
  /** Time of the systolic upstroke foot, in seconds from session start. */
  tSec: number;
  /** Interval from the previous beat, in milliseconds. */
  ibiMs: number;
  /** True if this beat was generated as a premature ectopic. */
  ectopic: boolean;
}

export interface CardiacTarget {
  activity: ActivityProfile;
  /** 0..1 position within the activity's own HRR band. */
  effort: number;
}

export function maxHeartRate(age: number): number {
  // Tanaka, Monahan & Seals (2001) — better calibrated across age than 220-age.
  return 208 - 0.7 * age;
}

/** Age- and fitness-scaled multiplier applied to every HRV oscillator. */
export function hrvCapacity(subject: SubjectProfile): number {
  const ageTerm = clamp(1.3 - subject.age / 90, 0.42, 1.12);
  const fitTerm = 0.72 + 0.56 * clamp(subject.fitness, 0, 1);
  return ageTerm * fitTerm;
}

export class CardiacModel {
  private readonly rng: () => number;
  private readonly gauss: () => number;
  private readonly pink: PinkNoise;

  private t = 0;
  /** IPFM phase accumulator; a beat is emitted each time it crosses 1. */
  private phase = 0;
  private lastBeatT = 0;
  private hrFast: number;
  private hrMean: number;
  private hrTarget: number;

  // Oscillator phases, kept continuous across activity changes.
  private respPhase = 0;
  private mayerPhase = 0;
  private vlfPhase = 0;

  private respRate: number;
  private respRateTarget: number;
  private respJitter = 0;

  /** Transient sympathetic surge (REM bursts, arousals, effort spikes), in bpm. */
  private surge = 0;
  private pendingCompensatoryPause = 0;

  private target: CardiacTarget;
  private capacity: number;

  constructor(
    private readonly subject: SubjectProfile,
    initial: CardiacTarget,
    seed: number,
  ) {
    this.rng = makeRng(seed);
    this.gauss = makeGaussian(this.rng);
    this.pink = new PinkNoise(this.rng);
    this.target = initial;
    this.capacity = hrvCapacity(subject);
    this.hrTarget = this.computeTargetHr();
    this.hrMean = this.hrTarget;
    this.hrFast = this.hrTarget;
    this.respRate = this.midResp();
    this.respRateTarget = this.respRate;
  }

  setTarget(target: CardiacTarget): void {
    this.target = target;
    this.hrTarget = this.computeTargetHr();
    this.respRateTarget = this.midResp();
  }

  private midResp(): number {
    const [lo, hi] = this.target.activity.respRateRange;
    return lo + (hi - lo) * clamp(this.target.effort, 0, 1);
  }

  /**
   * Karvonen heart-rate reserve mapping.
   *
   * For activities with an externally fixed workload (walking at a given
   * cadence, cycling) a fitter subject reaches that workload at a lower
   * fraction of their reserve, so the demand is scaled by fitness. For postural
   * and sleep states the %HRR band already describes the state itself and is
   * used unscaled.
   */
  private computeTargetHr(): number {
    const a = this.target.activity;
    const hrMax = maxHeartRate(this.subject.age);
    const reserve = Math.max(20, hrMax - this.subject.restingHr);
    const [lo, hi] = a.hrrRange;
    let hrr = lo + (hi - lo) * clamp(this.target.effort, 0, 1);

    const externalLoad =
      a.category === 'ambulatory' || a.category === 'exercise' || a.category === 'recovery';
    if (externalLoad) {
      // fitness 0.5 is neutral; 1.0 costs 22% less reserve, 0.0 costs 22% more.
      hrr *= 1 - 0.44 * (clamp(this.subject.fitness, 0, 1) - 0.5);
    }

    // Higher BMI raises the cardiovascular cost of weight-bearing work.
    if (externalLoad && a.cadence?.unit === 'spm') {
      hrr *= 1 + 0.012 * clamp(this.subject.bmi - 23, -6, 16);
    }

    const hr = this.subject.restingHr + hrr * reserve;
    // Never exceed age-predicted max by more than a couple of beats.
    return clamp(hr, 32, hrMax + 2);
  }

  /** Effective RSA amplitude in bpm, after subject and heart-rate scaling. */
  private rsaAmplitude(): number {
    // The activity profile states a peak-to-peak swing; a sine oscillator wants
    // half of that.
    const base = 0.5 * this.target.activity.autonomic.rsaAmplitudeBpm * this.capacity;
    // RSA is progressively abolished as heart rate rises above rest.
    const hrSuppression = Math.exp(-Math.max(0, this.hrMean - this.subject.restingHr) / 42);
    return base * hrSuppression;
  }

  private mayerAmplitude(): number {
    const base = 0.5 * this.target.activity.autonomic.mayerAmplitudeBpm * (0.6 + 0.4 * this.capacity);
    const hrSuppression = Math.exp(-Math.max(0, this.hrMean - this.subject.restingHr) / 70);
    return base * hrSuppression;
  }

  get currentRespRate(): number {
    return this.respRate;
  }

  /** Respiration phase in radians — the pulse model uses this for amplitude modulation. */
  get currentRespPhase(): number {
    return this.respPhase;
  }

  get currentHrMean(): number {
    return this.hrMean;
  }

  get currentSpo2(): number {
    // Healthy adult range with a small respiratory ripple; deliberately does not
    // pretend to model desaturation events.
    return clamp(97.8 + 0.5 * Math.sin(this.respPhase) - 0.35 * this.target.activity.autonomic.sympathetic, 94, 100);
  }

  /**
   * Advance the model by `dt` seconds and return any beats that occurred.
   * `dt` is expected to be one sample period, i.e. small relative to a beat.
   */
  step(dt: number): Beat[] {
    const a = this.target.activity;

    // --- heart-rate trajectory: two cascaded lags give a physiological S-curve
    const tau = Math.max(4, a.hrResponseTauSec);
    // Recovery is faster than onset for the same tau (vagal reactivation).
    const dirTau = this.hrTarget < this.hrMean ? tau * 0.8 : tau;
    this.hrFast += ((this.hrTarget - this.hrFast) * dt) / dirTau;
    this.hrMean += ((this.hrFast - this.hrMean) * dt) / (dirTau * 0.4);

    // --- respiration: rate drifts toward target with breath-to-breath jitter
    this.respRate += ((this.respRateTarget - this.respRate) * dt) / 12;
    const irregularity = 0.04 + 0.3 * a.autonomic.sympathetic + (a.id === 'sleep_rem' ? 0.22 : 0);
    this.respJitter += (this.gauss() * irregularity - this.respJitter) * dt * 0.5;
    const respHz = Math.max(0.08, (this.respRate / 60) * (1 + this.respJitter * 0.35));
    this.respPhase += 2 * Math.PI * respHz * dt;

    // --- Mayer wave: baroreflex resonance, drifts slightly around 0.1 Hz
    const mayerHz = 0.1 + 0.008 * Math.sin(this.t * 0.013);
    this.mayerPhase += 2 * Math.PI * mayerHz * dt;
    this.vlfPhase += 2 * Math.PI * 0.031 * dt;

    // --- transient sympathetic surges (REM bursts, arousals, effort spikes)
    this.surge *= Math.exp(-dt / 9);
    const surgeRate = a.category === 'sleep' ? a.autonomic.sympathetic * 0.035 : a.autonomic.sympathetic * 0.012;
    if (this.rng() < surgeRate * dt) {
      this.surge += (3 + this.rng() * 9) * (0.5 + a.autonomic.sympathetic);
    }

    // --- instantaneous rate
    const rsa = this.rsaAmplitude() * Math.sin(this.respPhase);
    const mayer = this.mayerAmplitude() * Math.sin(this.mayerPhase);
    const vlf = 0.55 * this.capacity * a.autonomic.parasympathetic * Math.sin(this.vlfPhase);
    const pinkAmp = 1.4 * this.capacity * (0.35 + 0.65 * a.autonomic.parasympathetic);
    const pinkTerm = this.pink.next() * pinkAmp * Math.sqrt(dt * 4);

    const hrInstant = clamp(
      this.hrMean + rsa + mayer + vlf + pinkTerm + this.surge,
      28,
      maxHeartRate(this.subject.age) + 12,
    );

    this.phase += (hrInstant / 60) * dt;
    this.t += dt;

    const beats: Beat[] = [];
    while (this.phase >= 1) {
      this.phase -= 1;
      // Sub-sample interpolation of the crossing instant.
      const overshoot = (this.phase * 60) / hrInstant;
      let beatT = this.t - overshoot;

      let ectopic = false;
      if (this.pendingCompensatoryPause > 0) {
        // Previous beat was ectopic; this one arrives late.
        beatT += this.pendingCompensatoryPause;
        this.pendingCompensatoryPause = 0;
      } else if (this.subject.ectopicPerMin > 0 && this.rng() < this.subject.ectopicPerMin / 60 / (hrInstant / 60)) {
        // Premature beat, followed by a compensatory pause on the next one.
        const expected = 60 / hrInstant;
        const prematurity = expected * (0.22 + this.rng() * 0.18);
        beatT -= prematurity;
        this.pendingCompensatoryPause = prematurity * 1.7;
        ectopic = true;
      }

      beatT = Math.max(beatT, this.lastBeatT + 0.22);
      const ibiMs = (beatT - this.lastBeatT) * 1000;
      this.lastBeatT = beatT;
      beats.push({ tSec: beatT, ibiMs, ectopic });
    }
    return beats;
  }
}

/**
 * Map a cadence within an activity's cadence band onto an effort in 0..1.
 * Gait energy cost rises faster than linearly with cadence, hence the exponent.
 */
export function cadenceToEffort(activity: ActivityProfile, cadence: number): number {
  if (!activity.cadence) return 0.5;
  const { min, max } = activity.cadence;
  const x = clamp(remap(cadence, min, max, 0, 1), 0, 1);
  return Math.pow(x, 0.82);
}
