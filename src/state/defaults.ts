import type { PipelineConfig, SubjectProfile, WearConfig } from '../engine/types';

export const DEFAULT_SUBJECT: SubjectProfile = {
  age: 32,
  sex: 'unspecified',
  restingHr: 62,
  fitness: 0.55,
  fitzpatrick: 3,
  bmi: 24,
  wristCircumferenceMm: 172,
  ectopicPerMin: 0,
};

export const DEFAULT_WEAR: WearConfig = {
  bandTightness: 0.55,
  placementMm: 25,
  ambientLight: 0.15,
  mainsHz: 50,
  skinTempC: 32,
};

export const DEFAULT_PIPELINE: PipelineConfig = {
  dcRemovalHz: 0.4,
  bandpassLowHz: 0.5,
  bandpassHighHz: 4.0,
  filterOrder: 4,
  motionCancellation: true,
  nlmsTaps: 24,
  // Deliberately small. A larger step converges faster on a big running
  // artefact but, during walking, the step rate sits almost on top of the
  // heart rate and a fast-adapting filter starts cancelling the pulse itself.
  // Swept across every activity in the catalogue, 0.01 was the best compromise.
  nlmsMu: 0.01,
  smoothingMs: 40,
  peakRefractoryFraction: 0.5,
  ibiRejectFraction: 0.25,
  hrvWindowSec: 120,
};

/** Presets that make the subject panel useful without a form-filling exercise. */
export interface SubjectPreset {
  id: string;
  name: string;
  note: string;
  subject: SubjectProfile;
}

export const SUBJECT_PRESETS: SubjectPreset[] = [
  {
    id: 'typical-adult',
    name: 'Typical adult',
    note: '32, moderately active, mid phototype — the population most wearables are tuned for.',
    subject: { ...DEFAULT_SUBJECT },
  },
  {
    id: 'endurance-athlete',
    name: 'Endurance athlete',
    note: 'Low resting rate and large vagal reserve; HRV figures run far above population norms.',
    subject: {
      age: 27,
      sex: 'unspecified',
      restingHr: 44,
      fitness: 0.95,
      fitzpatrick: 2,
      bmi: 21,
      wristCircumferenceMm: 168,
      ectopicPerMin: 0,
    },
  },
  {
    id: 'older-adult',
    name: 'Older adult',
    note: '68, stiffer arteries — the dicrotic notch arrives earlier and HRV is roughly half the young-adult value.',
    subject: {
      age: 68,
      sex: 'unspecified',
      restingHr: 71,
      fitness: 0.35,
      fitzpatrick: 2,
      bmi: 27,
      wristCircumferenceMm: 176,
      ectopicPerMin: 0.4,
    },
  },
  {
    id: 'deep-phototype',
    name: 'Fitzpatrick VI',
    note: 'Melanin absorbs strongly at 525 nm, so the same LED current returns a much smaller green pulse.',
    subject: {
      age: 35,
      sex: 'unspecified',
      restingHr: 66,
      fitness: 0.5,
      fitzpatrick: 6,
      bmi: 25,
      wristCircumferenceMm: 180,
      ectopicPerMin: 0,
    },
  },
  {
    id: 'ectopic',
    name: 'Frequent ectopy',
    note: 'Six premature beats a minute. Watch what uncorrected intervals do to RMSSD.',
    subject: {
      age: 54,
      sex: 'unspecified',
      restingHr: 68,
      fitness: 0.4,
      fitzpatrick: 3,
      bmi: 28,
      wristCircumferenceMm: 182,
      ectopicPerMin: 6,
    },
  },
];

/** Pipeline presets spanning the naive-to-careful range. */
export interface PipelinePreset {
  id: string;
  name: string;
  note: string;
  pipeline: PipelineConfig;
}

export const PIPELINE_PRESETS: PipelinePreset[] = [
  {
    id: 'production',
    name: 'Production default',
    note: 'What a shipping wearable would run: full band-pass, adaptive motion cancellation, interval screening.',
    pipeline: { ...DEFAULT_PIPELINE },
  },
  {
    id: 'naive',
    name: 'Naive baseline',
    note: 'DC removal and a wide band-pass only. No motion cancellation, no interval screening. Compare during gait.',
    pipeline: {
      ...DEFAULT_PIPELINE,
      bandpassLowHz: 0.3,
      bandpassHighHz: 8,
      filterOrder: 2,
      motionCancellation: false,
      smoothingMs: 0,
      ibiRejectFraction: 0.95,
    },
  },
  {
    id: 'hrv-grade',
    name: 'HRV grade',
    note: 'Narrow band, heavy screening, long analysis window. Best interval precision, worst responsiveness.',
    pipeline: {
      ...DEFAULT_PIPELINE,
      bandpassLowHz: 0.7,
      bandpassHighHz: 3.5,
      filterOrder: 4,
      smoothingMs: 60,
      ibiRejectFraction: 0.18,
      hrvWindowSec: 300,
    },
  },
  {
    id: 'responsive',
    name: 'Responsive',
    note: 'Short windows and light smoothing. Follows a sprint start quickly at the cost of noisier intervals.',
    pipeline: {
      ...DEFAULT_PIPELINE,
      smoothingMs: 20,
      nlmsMu: 0.025,
      nlmsTaps: 16,
      hrvWindowSec: 60,
    },
  },
];
