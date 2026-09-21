import type { ActivityProfile, HardwareProfile, WearConfig } from './types';
import { DriftSource, clamp, makeGaussian, makeRng } from './rng';

/**
 * Wrist motion and motion-artefact synthesis.
 *
 * Two things are produced here and they are deliberately not the same signal:
 *
 *   1. A three-axis accelerometer stream, which is what the DSP pipeline is
 *      allowed to see and use as a cancellation reference.
 *   2. The optical artefact that motion actually injects into the photodiode
 *      current, which is a *filtered and partly non-linear* function of that
 *      motion.
 *
 * The gap between the two is the whole problem. An adaptive filter can remove
 * the part of the artefact that is a linear, time-invariant function of the
 * accelerometer; it cannot remove the non-linear term, and that residue is what
 * limits every accelerometer-referenced canceller in the literature.
 *
 * Gait structure matters as much as amplitude. The arm swings once per stride
 * but the foot strikes twice, so wrist acceleration carries energy at both
 * cadence/120 Hz and cadence/60 Hz plus harmonics. At 108 steps/min the second
 * harmonic of the arm swing sits at 1.8 Hz — 108 bpm — which is precisely the
 * heart rate a walker is likely to have. That coincidence, not noise, is why
 * naive wrist HRM reports cadence.
 */

export interface MotionSample {
  ax: number;
  ay: number;
  az: number;
  /** Vector magnitude with gravity removed, in g. */
  magnitude: number;
}

/** One-pole low-pass, used for the coupling lags. */
class OnePole {
  private y = 0;
  constructor(private readonly a: number) {}
  step(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

/** One-pole high-pass built from its low-pass complement. */
class OnePoleHp {
  private lp = 0;
  constructor(private readonly a: number) {}
  step(x: number): number {
    this.lp += this.a * (x - this.lp);
    return x - this.lp;
  }
}

interface Burst {
  start: number;
  duration: number;
  amp: number;
  axis: [number, number, number];
}

export class MotionModel {
  private readonly rng: () => number;
  private readonly gauss: () => number;

  private t = 0;
  private stridePhase = 0;
  private stepPhase = 0;
  private cadencePhaseJitter: DriftSource;
  private ampJitter: DriftSource;

  private bursts: Burst[] = [];
  /** Decaying footstrike shock oscillators, one per recent step. */
  private shock = 0;
  private shockVel = 0;
  private lastStepPhase = 0;

  private activity: ActivityProfile;
  private cadence: number;
  private effort: number;

  // Coupling filters: three different lags give the artefact a non-trivial
  // transfer function from acceleration, which is what an FIR canceller has to
  // identify.
  private lagX = new OnePole(0.35);
  private lagY = new OnePole(0.18);
  private lagZ = new OnePole(0.55);
  private hpArtifact: OnePoleHp;
  private baselineLag = new OnePole(0.004);
  private nonlinLag = new OnePole(0.12);

  /**
   * Footstrike shock resonance, rad/s. Clamped so that w*dt stays below the
   * stability limit of the semi-implicit integrator — a 32 Hz part would
   * otherwise make a 14 Hz oscillator diverge rather than ring.
   */
  private readonly shockW: number;

  private noiseX: DriftSource;
  private noiseY: DriftSource;
  private noiseZ: DriftSource;

  constructor(
    activity: ActivityProfile,
    cadence: number,
    effort: number,
    private readonly wear: WearConfig,
    private readonly hardware: HardwareProfile,
    sampleRate: number,
    seed: number,
  ) {
    this.rng = makeRng(seed ^ 0x5bf03635);
    this.gauss = makeGaussian(this.rng);
    this.activity = activity;
    this.cadence = cadence;
    this.effort = effort;
    this.cadencePhaseJitter = new DriftSource(this.gauss, 0.02, 0.05);
    this.ampJitter = new DriftSource(this.gauss, 0.05, 0.14);
    this.noiseX = new DriftSource(this.gauss, 0.3, 1);
    this.noiseY = new DriftSource(this.gauss, 0.3, 1);
    this.noiseZ = new DriftSource(this.gauss, 0.3, 1);
    this.hpArtifact = new OnePoleHp(clamp((2 * Math.PI * 0.08) / sampleRate, 1e-4, 0.5));
    this.shockW = Math.min(2 * Math.PI * 14, 1.2 * sampleRate);
  }

  setActivity(activity: ActivityProfile, cadence: number, effort: number): void {
    this.activity = activity;
    this.cadence = cadence;
    this.effort = effort;
  }

  /** Peak wrist acceleration in g for the current activity and cadence. */
  private gaitAmplitude(): number {
    const c = this.activity.cadence;
    if (!c) return 0;
    const [lo, hi] = c.accelGRange;
    const x = clamp((this.cadence - c.min) / Math.max(1, c.max - c.min), 0, 1);
    return lo + (hi - lo) * Math.pow(x, 1.35);
  }

  private spawnBursts(dt: number): void {
    const rate = this.activity.motionBurstsPerMin / 60;
    if (this.rng() < rate * dt) {
      const amp = this.activity.randomMotionG * (0.8 + this.rng() * 2.4);
      const axis: [number, number, number] = [
        this.gauss(),
        this.gauss(),
        this.gauss(),
      ];
      const norm = Math.hypot(...axis) || 1;
      this.bursts.push({
        start: this.t,
        duration: 0.35 + this.rng() * 1.5,
        amp,
        axis: [axis[0] / norm, axis[1] / norm, axis[2] / norm],
      });
    }
    this.bursts = this.bursts.filter((b) => this.t - b.start < b.duration);
  }

  private burstContribution(): [number, number, number] {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const b of this.bursts) {
      const u = (this.t - b.start) / b.duration;
      // Half-sine envelope with a wobble, so a burst is not a single impulse.
      const env = Math.sin(Math.PI * u) * (1 + 0.5 * Math.sin(2 * Math.PI * 3.4 * (this.t - b.start)));
      x += b.axis[0] * b.amp * env;
      y += b.axis[1] * b.amp * env;
      z += b.axis[2] * b.amp * env;
    }
    return [x, y, z];
  }

  step(dt: number): MotionSample {
    this.t += dt;
    this.spawnBursts(dt);

    const a = this.activity;
    const coherence = a.motionCoherence;
    let ax = 0;
    let ay = 0;
    let az = 0;

    if (a.cadence) {
      const stepHz = a.cadence.unit === 'spm' ? this.cadence / 60 : this.cadence / 60;
      // Arm swing completes one cycle per stride = one cycle per two steps.
      const strideHz = a.cadence.unit === 'spm' ? stepHz / 2 : stepHz;
      const jitter = 1 + this.cadencePhaseJitter.next();
      this.stridePhase += 2 * Math.PI * strideHz * jitter * dt;
      this.stepPhase += 2 * Math.PI * stepHz * jitter * dt;

      const amp = this.gaitAmplitude() * (1 + this.ampJitter.next());

      // Anteroposterior: dominated by the arm swing at stride rate.
      ax =
        amp * 0.85 * Math.sin(this.stridePhase) +
        amp * 0.3 * Math.sin(2 * this.stridePhase + 0.7);
      // Vertical: dominated by footstrike at step rate, plus its 2nd harmonic.
      ay =
        amp * 1.0 * Math.sin(this.stepPhase) +
        amp * 0.42 * Math.sin(2 * this.stepPhase + 1.2) +
        amp * 0.16 * Math.sin(3 * this.stepPhase);
      // Mediolateral: smaller, locked to stride.
      az = amp * 0.45 * Math.sin(this.stridePhase + 1.9);

      // Footstrike shock: a damped ~14 Hz ring excited once per step. This is
      // what puts energy far above the cardiac band during running.
      const phaseWrapped = this.stepPhase % (2 * Math.PI);
      if (phaseWrapped < this.lastStepPhase) {
        this.shockVel += amp * 0.55 * (0.7 + this.rng() * 0.6);
      }
      this.lastStepPhase = phaseWrapped;
      const w = this.shockW;
      const zeta = 0.22;
      const accel = -w * w * this.shock - 2 * zeta * w * this.shockVel;
      this.shockVel += accel * dt;
      this.shock += this.shockVel * dt;
      ay += this.shock * 0.9;
      ax += this.shock * 0.35;

      // Cycling transmits frame vibration rather than limb swing.
      if (a.cadence.unit === 'rpm') {
        const vib = amp * 0.6;
        ax += vib * this.noiseX.next();
        ay += vib * this.noiseY.next();
        az += vib * this.noiseZ.next();
      }
    }

    // Aperiodic component. Scaled by (1 - coherence) so that gait stays
    // spectrally concentrated and housework stays broadband.
    const randScale = a.randomMotionG * (1 - coherence) * (0.6 + 0.8 * this.effort);
    ax += this.noiseX.next() * randScale;
    ay += this.noiseY.next() * randScale;
    az += this.noiseZ.next() * randScale;

    const [bx, by, bz] = this.burstContribution();
    ax += bx;
    ay += by;
    az += bz;

    const magnitude = Math.hypot(ax, ay, az);
    return { ax, ay, az, magnitude };
  }

  /**
   * Scalar gain from wrist acceleration to optical artefact.
   *
   * Loose bands let the sensor move relative to the skin; a well isolated
   * optical stack keeps stray and venous light from reaching the photodiode
   * when it does.
   */
  couplingGain(): number {
    const mechanical = clamp(1.5 - 1.2 * clamp(this.wear.bandTightness, 0, 1), 0.3, 1.5);
    const optical = 1 - clamp(this.hardware.motionRobustness, 0, 1);
    return mechanical * optical * 7.0;
  }

  /**
   * Optical artefact injected by this motion sample, in units of the normalised
   * pulse amplitude (1.0 = one full pulse).
   *
   * Composed of a linear, lag-filtered mixture of the three axes — which an
   * adaptive filter can in principle identify and remove — plus a squared term
   * that it cannot, because no linear filter maps a to a^2.
   */
  artifact(sample: MotionSample): { total: number; linear: number; nonlinear: number; baseline: number } {
    const g = this.couplingGain();
    const linear =
      g * (0.55 * this.lagX.step(sample.ax) + 0.85 * this.lagY.step(sample.ay) + 0.4 * this.lagZ.step(sample.az));

    // Pressure-dependent, rectified coupling. Grows faster than linearly, so it
    // matters far more during running than during typing.
    const rect = this.nonlinLag.step(sample.magnitude * sample.magnitude);
    const nonlinear = g * 0.22 * (rect - this.baselineLag.step(rect));

    // Slow baseline wander from sustained pressure changes; mostly below the
    // cardiac band, which is exactly why the band-pass stage earns its place.
    const baseline = g * 1.8 * this.baselineLag.step(sample.magnitude);

    const total = this.hpArtifact.step(linear + nonlinear) + baseline;
    return { total, linear, nonlinear, baseline };
  }
}

/**
 * Frequencies at which gait deposits energy, for the spectrum overlay.
 * Returns Hz values for the arm-swing fundamental and its first harmonics.
 */
export function cadenceHarmonics(activity: ActivityProfile, cadence: number): number[] {
  if (!activity.cadence) return [];
  const stepHz = cadence / 60;
  if (activity.cadence.unit === 'rpm') return [stepHz, stepHz * 2];
  const strideHz = stepHz / 2;
  return [strideHz, stepHz, stepHz * 1.5, stepHz * 2];
}
