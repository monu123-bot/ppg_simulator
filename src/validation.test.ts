import { describe, expect, it } from 'vitest';
import { PpgSimulator, makeBlock } from './engine/simulator';
import { PpgPipeline, makePipelineOutput } from './dsp/pipeline';
import { getActivity } from './engine/activities';
import { getHardware } from './engine/hardware';
import { DEFAULT_PIPELINE, DEFAULT_SUBJECT, DEFAULT_WEAR } from './state/defaults';
import type { SimulationConfig } from './engine/types';
import { CardiacModel } from './engine/cardiac';
import { timeDomain } from './dsp/hrv';

/**
 * Validation harness.
 *
 * These are not unit tests of individual functions; they check that the whole
 * chain lands where the literature says it should. If a change to the cardiac
 * model quietly puts resting heart rate at 45 bpm or makes a sprint produce
 * 300 bpm, this is what catches it.
 */

function runSession(opts: {
  activityId: string;
  cadence?: number;
  effort?: number;
  hardwareId?: string;
  sampleRate?: number;
  seconds: number;
  motionCancellation?: boolean;
  subject?: Partial<typeof DEFAULT_SUBJECT>;
}) {
  const hw = getHardware(opts.hardwareId ?? 'max86141');
  const subject = { ...DEFAULT_SUBJECT, ...opts.subject };
  const config: SimulationConfig = {
    sensor: {
      hardwareId: hw.id,
      sampleRateHz: opts.sampleRate ?? hw.defaultSampleRate,
      ledCurrentMa: hw.defaultLedCurrentMa,
      primaryChannel: 'green',
    },
    subject,
    wear: { ...DEFAULT_WEAR },
    pipeline: { ...DEFAULT_PIPELINE, motionCancellation: opts.motionCancellation ?? true },
    seed: 12345,
  };

  const activity = getActivity(opts.activityId);
  const cadence = opts.cadence ?? activity.cadence?.default ?? 0;
  const effort = opts.effort ?? 0.5;

  const sim = new PpgSimulator(config, { activityId: activity.id, cadence, effort });
  const pipeline = new PpgPipeline(
    config.pipeline,
    config.sensor.sampleRateHz,
    hw.hasAccelerometer || hw.id === 'ideal',
    subject,
    sim.hasRedIr,
  );

  const chunk = Math.round(config.sensor.sampleRateHz);
  const block = makeBlock(chunk);
  const out = makePipelineOutput(chunk);

  const trueHrs: number[] = [];
  const estHrs: number[] = [];
  let accelPeak = 0;

  for (let s = 0; s < opts.seconds; s++) {
    sim.generate(chunk, block);
    pipeline.process(block, out);
    for (let i = 0; i < chunk; i++) accelPeak = Math.max(accelPeak, Math.abs(out.accelMag[i]));
    // Ignore the first 20 s: filters, templates and the HR lag are settling.
    if (s >= 20) {
      trueHrs.push(block.truth.hr);
      if (pipeline.metrics.heartRate > 0) estHrs.push(pipeline.metrics.heartRate);
    }
  }

  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    sim,
    metrics: pipeline.metrics,
    out,
    trueHr: mean(trueHrs),
    estHr: mean(estHrs),
    accelPeak,
  };
}

/** HRV of the ground-truth interval series, bypassing the optical path entirely. */
function truthHrv(activityId: string, seconds: number, age = DEFAULT_SUBJECT.age) {
  const subject = { ...DEFAULT_SUBJECT, age };
  const model = new CardiacModel(subject, { activity: getActivity(activityId), effort: 0.5 }, 4242);
  const fs = 128;
  const nn: number[] = [];
  for (let i = 0; i < fs * seconds; i++) {
    for (const b of model.step(1 / fs)) nn.push(b.ibiMs);
  }
  // Drop the first few beats: the first interval is measured from time zero.
  return timeDomain(nn.slice(5));
}

describe('physiological plausibility', () => {
  it('puts seated rest inside the literature heart-rate band', () => {
    const r = runSession({ activityId: 'rest_sitting', seconds: 90, effort: 0.5 });
    const [lo, hi] = getActivity('rest_sitting').hrRangeBpm;
    expect(r.trueHr).toBeGreaterThan(lo - 6);
    expect(r.trueHr).toBeLessThan(hi + 6);
  });

  it('raises heart rate monotonically across walking, jogging and running', () => {
    const walk = runSession({ activityId: 'walk_normal', seconds: 90 });
    const jog = runSession({ activityId: 'jogging', seconds: 90 });
    const run = runSession({ activityId: 'running', seconds: 90 });
    expect(walk.trueHr).toBeLessThan(jog.trueHr);
    expect(jog.trueHr).toBeLessThan(run.trueHr);
    expect(run.trueHr).toBeLessThan(200);
  });

  it('puts deep sleep below the subject resting heart rate', () => {
    const r = runSession({ activityId: 'sleep_deep', seconds: 120 });
    expect(r.trueHr).toBeLessThan(DEFAULT_SUBJECT.restingHr);
    expect(r.trueHr).toBeGreaterThan(38);
  });

  it('scales wrist acceleration with cadence within an activity', () => {
    const slow = runSession({ activityId: 'running', cadence: 166, seconds: 40 });
    const fast = runSession({ activityId: 'running', cadence: 190, seconds: 40 });
    expect(fast.accelPeak).toBeGreaterThan(slow.accelPeak);
    // Running should put multiple g into the wrist.
    expect(fast.accelPeak).toBeGreaterThan(2);
  });

  it('produces age-appropriate resting HRV', () => {
    // Normative short-term resting RMSSD falls roughly by half between 25 and
    // 70 (Nunan 2010; Shaffer & Ginsberg 2017).
    const young = truthHrv('rest_supine', 300, 25);
    const older = truthHrv('rest_supine', 300, 68);
    expect(young.rmssd).toBeGreaterThan(30);
    expect(young.rmssd).toBeLessThan(110);
    expect(older.rmssd).toBeGreaterThan(12);
    expect(older.rmssd).toBeLessThan(young.rmssd * 0.75);
  });

  it('recovers resting HRV from the optical signal close to the truth', () => {
    const r = runSession({ activityId: 'rest_supine', seconds: 220, subject: { age: 25 } });
    const truth = truthHrv('rest_supine', 220, 25);
    // Pulse rate variability runs a little above R-R variability; within 40%
    // at rest is the agreement reported for wrist PPG in the literature.
    expect(r.metrics.timeDomain.rmssd).toBeGreaterThan(truth.rmssd * 0.6);
    expect(r.metrics.timeDomain.rmssd).toBeLessThan(truth.rmssd * 1.4);
  });

  it('suppresses HRV during hard exercise', () => {
    // Compared on the ground-truth interval series, not the recovered one.
    // Measured HRV during running is dominated by detection error, which is a
    // true statement about wrist PPG but not about the physiology under test.
    const rest = truthHrv('rest_supine', 240);
    const run = truthHrv('running', 240);
    expect(run.rmssd).toBeLessThan(rest.rmssd);
    expect(run.rmssd).toBeLessThan(15);
  });
});

describe('pipeline recovery', () => {
  it('tracks heart rate closely at rest on a good sensor', () => {
    const r = runSession({ activityId: 'rest_sitting', seconds: 120 });
    expect(Math.abs(r.estHr - r.trueHr)).toBeLessThan(3);
    expect(r.metrics.truth.detectionSensitivity).toBeGreaterThan(0.9);
    expect(r.metrics.quality.score).toBeGreaterThan(55);
  });

  it('still tracks heart rate while walking', () => {
    const r = runSession({ activityId: 'walk_normal', seconds: 150 });
    expect(Math.abs(r.estHr - r.trueHr)).toBeLessThan(10);
  });

  it('degrades on the budget front end relative to the flagship', () => {
    const good = runSession({ activityId: 'walk_brisk', seconds: 150, hardwareId: 'max86141' });
    const bad = runSession({ activityId: 'walk_brisk', seconds: 150, hardwareId: 'si1143' });
    expect(bad.metrics.quality.score).toBeLessThan(good.metrics.quality.score);
    expect(bad.sim.motionCouplingGain()).toBeGreaterThan(good.sim.motionCouplingGain() * 2);
    expect(bad.sim.diagnostics().acSnrDb).toBeLessThan(good.sim.diagnostics().acSnrDb - 15);
  });

  it('keeps heart-rate error inside published wrist-PPG tolerances', () => {
    // Reported mean absolute error for wrist optical HR against ECG is a few
    // bpm at rest and roughly 5-10 bpm during ambulation (Bent 2020).
    const ids = [
      'rest_sitting',
      'sleep_deep',
      'desk_work',
      'driving',
      'walk_slow',
      'walk_normal',
      'walk_brisk',
      'stairs',
      'jogging',
      'running',
      'cycling',
      'household',
      'strength',
      'recovery',
    ];
    for (const id of ids) {
      const r = runSession({ activityId: id, seconds: 150 });
      expect(Math.abs(r.estHr - r.trueHr), `${id} HR error`).toBeLessThan(12);
    }
  });

  it('reports low confidence rather than a wrong number during a sprint', () => {
    // Maximal sprinting is the genuinely unsolvable case: at 190 steps/min the
    // cadence line sits about 0.25 Hz from the pulse, well inside the width an
    // artefact many times larger than the pulse spreads over. No algorithm
    // separates them from the PPG alone. What the pipeline must do is say so.
    const r = runSession({ activityId: 'sprinting', seconds: 150 });
    expect(r.metrics.quality.score).toBeLessThan(35);
    expect(r.metrics.rateReliable).toBe(false);
  });

  it('benefits from motion cancellation during gait', () => {
    const on = runSession({ activityId: 'jogging', seconds: 150, motionCancellation: true });
    const off = runSession({ activityId: 'jogging', seconds: 150, motionCancellation: false });
    expect(Math.abs(on.estHr - on.trueHr)).toBeLessThan(Math.abs(off.estHr - off.trueHr));
  });

  it('gets out of the way at rest, where there is nothing to cancel', () => {
    const on = runSession({ activityId: 'rest_sitting', seconds: 120, motionCancellation: true });
    const off = runSession({ activityId: 'rest_sitting', seconds: 120, motionCancellation: false });
    // The motion gate should make these all but identical.
    expect(Math.abs(on.estHr - off.estHr)).toBeLessThan(2);
  });

  it('recovers respiration rate at rest', () => {
    const r = runSession({ activityId: 'rest_supine', seconds: 220 });
    expect(r.metrics.respiration.rateBpm).not.toBeNull();
    if (r.metrics.respiration.rateBpm !== null) {
      expect(Math.abs(r.metrics.respiration.rateBpm - r.metrics.truth.respRate)).toBeLessThan(4);
    }
  });

  it('recovers SpO2 within the oximeter tolerance at rest', () => {
    const r = runSession({ activityId: 'rest_sitting', seconds: 90 });
    expect(r.metrics.spo2.valid).toBe(true);
    if (r.metrics.spo2.value !== null) {
      expect(Math.abs(r.metrics.spo2.value - r.metrics.truth.spo2)).toBeLessThan(3);
    }
  });
});

describe('numerical robustness', () => {
  it('stays finite at the lowest supported sample rate', () => {
    const r = runSession({
      activityId: 'running',
      seconds: 60,
      hardwareId: 'bh1792glc',
      sampleRate: 32,
    });
    for (let i = 0; i < r.out.samples; i++) {
      expect(Number.isFinite(r.out.smoothed[i])).toBe(true);
      expect(Number.isFinite(r.out.accelMag[i])).toBe(true);
    }
    expect(Number.isFinite(r.metrics.heartRate)).toBe(true);
    expect(r.accelPeak).toBeLessThan(40);
  });

  it('produces no NaNs in any metric after a long sprint', () => {
    const r = runSession({ activityId: 'sprinting', seconds: 120 });
    const m = r.metrics;
    for (const v of [
      m.heartRate,
      m.timeDomain.rmssd,
      m.timeDomain.sdnn,
      m.frequencyDomain.lfhf,
      m.stress.score,
      m.quality.score,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('marks the autonomic load invalid during exercise', () => {
    const r = runSession({ activityId: 'running', seconds: 120 });
    expect(r.metrics.stress.valid).toBe(false);
  });
});
