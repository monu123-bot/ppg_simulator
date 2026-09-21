import type { ActivityProfile, SimulationConfig, TruthSample, Wavelength } from './types';
import { getActivity } from './activities';
import { getHardware } from './hardware';
import { CardiacModel, cadenceToEffort, type Beat } from './cardiac';
import { PulseTrain, perfusionIndexPercent, spo2ToRatio } from './pulse';
import { MotionModel } from './motion';
import { AnalogFrontEnd, type AfeDiagnostics } from './afe';
import { clamp } from './rng';

export interface SimSample {
  /** Seconds since session start. */
  t: number;
  /** Primary-channel ADC counts — what the pipeline actually receives. */
  raw: number;
  /** Red and IR channels in counts, when the part has them. */
  red: number;
  ir: number;
  ax: number;
  ay: number;
  az: number;
  /** Ground-truth clean pulse, normalised. Never visible to the pipeline. */
  clean: number;
  /** Ground-truth motion artefact, normalised. Never visible to the pipeline. */
  artifact: number;
  clipped: boolean;
}

export interface SimBlock {
  samples: number;
  t: Float64Array;
  raw: Float64Array;
  red: Float64Array;
  ir: Float64Array;
  ax: Float64Array;
  ay: Float64Array;
  az: Float64Array;
  clean: Float64Array;
  artifact: Float64Array;
  /** Ground-truth beats that fell inside this block. */
  beats: Beat[];
  truth: TruthSample;
  clippedCount: number;
}

export interface ActivityState {
  activityId: string;
  cadence: number;
  effort: number;
}

export class PpgSimulator {
  private cardiac: CardiacModel;
  private pulse: PulseTrain;
  private motion: MotionModel;
  private afeGreen: AnalogFrontEnd;
  private afeRed: AnalogFrontEnd;
  private afeIr: AnalogFrontEnd;

  private t = 0;
  private readonly dt: number;
  private activity: ActivityProfile;
  private cadence: number;
  private effort: number;
  private perfusion: number;
  private lastIbiMs = 1000;

  readonly sampleRate: number;
  readonly primaryChannel: Wavelength;
  readonly hasRedIr: boolean;

  constructor(
    private config: SimulationConfig,
    initial: ActivityState,
  ) {
    const hw = getHardware(config.sensor.hardwareId);
    this.sampleRate = config.sensor.sampleRateHz;
    this.dt = 1 / this.sampleRate;
    this.primaryChannel = config.sensor.primaryChannel;
    this.hasRedIr =
      hw.channels.some((c) => c.wavelength === 'red') && hw.channels.some((c) => c.wavelength === 'ir');

    this.activity = getActivity(initial.activityId);
    this.cadence = initial.cadence;
    this.effort = initial.effort;

    this.cardiac = new CardiacModel(
      config.subject,
      { activity: this.activity, effort: this.effort },
      config.seed,
    );
    this.pulse = new PulseTrain(config.subject, config.seed);
    this.motion = new MotionModel(
      this.activity,
      this.cadence,
      this.effort,
      config.wear,
      hw,
      this.sampleRate,
      config.seed,
    );
    this.afeGreen = new AnalogFrontEnd(hw, config.subject, config.wear, this.sampleRate, config.sensor.ledCurrentMa, config.seed);
    this.afeRed = new AnalogFrontEnd(hw, config.subject, config.wear, this.sampleRate, config.sensor.ledCurrentMa, config.seed + 11);
    this.afeIr = new AnalogFrontEnd(hw, config.subject, config.wear, this.sampleRate, config.sensor.ledCurrentMa, config.seed + 23);

    this.perfusion = perfusionIndexPercent(config.subject, this.activity, config.wear);
  }

  get elapsed(): number {
    return this.t;
  }

  get currentActivity(): ActivityProfile {
    return this.activity;
  }

  get currentCadence(): number {
    return this.cadence;
  }

  get perfusionIndex(): number {
    return this.perfusion;
  }

  diagnostics(): AfeDiagnostics {
    return this.afeGreen.diagnostics(this.primaryChannel, this.perfusion);
  }

  motionCouplingGain(): number {
    return this.motion.couplingGain();
  }

  setActivity(state: ActivityState): void {
    this.activity = getActivity(state.activityId);
    this.cadence = state.cadence;
    this.effort = state.effort;
    this.cardiac.setTarget({ activity: this.activity, effort: this.effort });
    this.motion.setActivity(this.activity, this.cadence, this.effort);
    this.perfusion = perfusionIndexPercent(this.config.subject, this.activity, this.config.wear);
  }

  /** Effort implied by the current cadence, for gait and cycling activities. */
  effortFromCadence(cadence: number): number {
    return cadenceToEffort(this.activity, cadence);
  }

  private truth(): TruthSample {
    return {
      hr: this.cardiac.currentHrMean,
      ibiMs: this.lastIbiMs,
      respRate: this.cardiac.currentRespRate,
      spo2: this.cardiac.currentSpo2,
      perfusionIndex: this.perfusion,
    };
  }

  /** Generate `n` samples into a reusable block. */
  generate(n: number, block: SimBlock): SimBlock {
    block.samples = n;
    block.beats = [];
    block.clippedCount = 0;

    const respDepth = clamp(0.09 + this.cardiac.currentRespRate / 320, 0.08, 0.26);
    const riivDepth = respDepth * 2.1;
    const vasomotion = 0.05 + 0.1 * this.activity.autonomic.sympathetic;

    for (let i = 0; i < n; i++) {
      // 1. Cardiac rhythm -> beats
      const beats = this.cardiac.step(this.dt);
      for (const b of beats) {
        this.pulse.addBeat(b, this.cardiac.currentRespPhase, respDepth);
        this.lastIbiMs = b.ibiMs;
        block.beats.push(b);
      }
      this.t += this.dt;

      // 2. Pulse morphology and slow modulations
      const ac = this.pulse.acAt(this.t);
      const baseline = this.pulse.baselineAt(
        this.dt,
        this.cardiac.currentRespPhase,
        riivDepth,
        vasomotion,
      );

      // 3. Wrist motion and the optical artefact it couples in
      const m = this.motion.step(this.dt);
      const art = this.motion.artifact(m);

      // 4. Silicon
      const spo2 = this.cardiac.currentSpo2;
      const g = this.afeGreen.sample(this.dt, this.primaryChannel, this.perfusion, ac, baseline, art.total);

      let redCounts = 0;
      let irCounts = 0;
      if (this.hasRedIr) {
        // Red and IR carry the same pulse, but with the AC/DC ratio implied by
        // the true saturation, so a ratio-of-ratios calculation downstream
        // recovers it. Infrared penetrates deeper than green and sees a larger
        // pulsatile volume — and correspondingly more motion-induced venous
        // modulation, hence the larger artefact weights.
        const ratio = spo2ToRatio(spo2);
        const irAcDc = this.perfusion * 1.25;
        const redAcDc = irAcDc * ratio;
        redCounts = this.afeRed.sample(this.dt, 'red', redAcDc, ac, baseline, art.total * 1.25, 1).counts;
        irCounts = this.afeIr.sample(this.dt, 'ir', irAcDc, ac, baseline, art.total * 1.45, 1).counts;
      }

      block.t[i] = this.t;
      block.raw[i] = g.counts;
      block.red[i] = redCounts;
      block.ir[i] = irCounts;
      block.ax[i] = m.ax;
      block.ay[i] = m.ay;
      block.az[i] = m.az;
      block.clean[i] = ac;
      block.artifact[i] = art.total;
      if (g.clipped) block.clippedCount++;
    }

    block.truth = this.truth();
    return block;
  }
}

export function makeBlock(capacity: number): SimBlock {
  return {
    samples: 0,
    t: new Float64Array(capacity),
    raw: new Float64Array(capacity),
    red: new Float64Array(capacity),
    ir: new Float64Array(capacity),
    ax: new Float64Array(capacity),
    ay: new Float64Array(capacity),
    az: new Float64Array(capacity),
    clean: new Float64Array(capacity),
    artifact: new Float64Array(capacity),
    beats: [],
    truth: { hr: 60, ibiMs: 1000, respRate: 14, spo2: 98, perfusionIndex: 1 },
    clippedCount: 0,
  };
}
