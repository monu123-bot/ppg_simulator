/** Shared domain types for the simulator engine and the DSP pipeline. */

export type Wavelength = 'green' | 'red' | 'ir';

export interface OpticalChannelSpec {
  wavelength: Wavelength;
  /** Peak emission wavelength in nanometres. */
  nm: number;
}

export type DeviceTier = 'research' | 'flagship' | 'mainstream' | 'budget' | 'reference';

export interface HardwareProfile {
  id: string;
  name: string;
  vendor: string;
  tier: DeviceTier;
  /** One-line positioning statement shown on the selection card. */
  tagline: string;
  description: string;

  /** Effective output resolution of the front end, in bits. */
  adcBits: number;
  /** Sample rates the part is normally run at for wrist HRM, in Hz. */
  sampleRates: number[];
  defaultSampleRate: number;

  channels: OpticalChannelSpec[];

  /** LED drive current range in mA and the default operating point. */
  ledCurrentMaRange: [number, number];
  defaultLedCurrentMa: number;

  /** Input-referred noise current density, pA rms in the PPG band. Lower is better. */
  noiseFloorPArms: number;
  /** Ambient-light / flicker rejection of the front end, in dB. */
  ambientRejectionDb: number;
  /** Usable dynamic range including DC-offset cancellation, in dB. */
  dynamicRangeDb: number;
  /** Photodiode active area, mm^2 — drives how much returned light is collected. */
  photodiodeAreaMm2: number;
  /**
   * Optical/mechanical resistance to motion coupling, 0..1.
   * Captures package isolation, LED–PD spacing and integrated light barriers.
   */
  motionRobustness: number;
  /** Typical continuous HRM current draw in microamps. */
  typicalCurrentUa: number;

  /** Whether the part has hardware DC-offset (ambient subtraction) cancellation. */
  hasDcOffsetCancellation: boolean;
  /** Whether a companion accelerometer stream is assumed available for MA removal. */
  hasAccelerometer: boolean;

  highlights: string[];
  /** Where the numbers above come from. */
  sourceNote: string;
}

export type ActivityCategory = 'sleep' | 'rest' | 'daily' | 'ambulatory' | 'exercise' | 'recovery';

export interface ActivityProfile {
  id: string;
  name: string;
  category: ActivityCategory;
  summary: string;

  /**
   * Literature heart-rate band for a healthy adult performing this activity.
   * Used as a sanity clamp and shown in the reference tables; the actual target
   * HR is computed per-subject via the Karvonen %HRR mapping below.
   */
  hrRangeBpm: [number, number];
  /** Percent of heart-rate reserve this activity demands, [low, high]. */
  hrrRange: [number, number];
  /** Metabolic equivalent, for the session report. */
  metRange: [number, number];

  /** Steps/min (gait) or rev/min (cycling). Null for non-rhythmic activities. */
  cadence: null | {
    unit: 'spm' | 'rpm';
    min: number;
    max: number;
    default: number;
    /** Wrist accel amplitude in g at the low and high end of the cadence range. */
    accelGRange: [number, number];
  };

  /** Respiration rate band, breaths/min. */
  respRateRange: [number, number];

  /** Autonomic character of the state. */
  autonomic: {
    /** 0..1 sympathetic tone — drives LF power, stress index and HR drift. */
    sympathetic: number;
    /** 0..1 parasympathetic (vagal) tone — drives RSA depth and RMSSD. */
    parasympathetic: number;
    /** Peak-to-peak respiratory sinus arrhythmia at rest for this state, in bpm. */
    rsaAmplitudeBpm: number;
    /** Mayer-wave (~0.1 Hz) amplitude in bpm. */
    mayerAmplitudeBpm: number;
    /** Target LF/HF ratio, used to shape the oscillator mix. */
    lfhfTarget: number;
  };

  /** Non-rhythmic wrist motion (gestures, fidgeting) in g rms. */
  randomMotionG: number;
  /** Rate of discrete motion bursts per minute (reaching, rolling over, gear changes). */
  motionBurstsPerMin: number;
  /**
   * How periodic the wrist motion is, 0..1.
   * Gait is highly coherent (energy concentrated at cadence harmonics, which is
   * exactly why it masquerades as a pulse); housework is nearly incoherent.
   */
  motionCoherence: number;
  /** Time constant of the HR response when entering this state, in seconds. */
  hrResponseTauSec: number;

  /** Peripheral vasomotor state: scales pulse amplitude / perfusion index. */
  perfusionScale: number;

  /** Literature the numbers are anchored to. */
  references: string[];
}

export interface SubjectProfile {
  age: number;
  sex: 'female' | 'male' | 'unspecified';
  /** Resting heart rate in bpm. */
  restingHr: number;
  /** 0..1 aerobic fitness proxy; shifts HR response and HRV amplitude. */
  fitness: number;
  /** Fitzpatrick skin phototype I..VI (1..6) — strongly affects green-light PPG. */
  fitzpatrick: 1 | 2 | 3 | 4 | 5 | 6;
  /** Body-mass index; drives subcutaneous tissue between sensor and vasculature. */
  bmi: number;
  /** Wrist circumference in mm — affects band mechanics. */
  wristCircumferenceMm: number;
  /**
   * Ectopic (premature) beats per minute. Each is followed by a compensatory
   * pause, which is what makes an uncorrected RMSSD explode.
   */
  ectopicPerMin: number;
}

export interface WearConfig {
  /** 0..1 band tightness. Too loose = motion artefact; too tight = occlusion. */
  bandTightness: number;
  /** Distance from the ulnar styloid in mm. Closer to the wrist bone = worse. */
  placementMm: number;
  /** Ambient light leaking into the optical path, 0..1 (0 = dark room, 1 = direct sun). */
  ambientLight: number;
  /** Mains frequency of the ambient light source, for the flicker component. */
  mainsHz: 50 | 60;
  /** Skin temperature in degrees Celsius — cold causes vasoconstriction. */
  skinTempC: number;
}

export interface SensorConfig {
  hardwareId: string;
  sampleRateHz: number;
  ledCurrentMa: number;
  /** Which optical channel feeds the primary HR pipeline. */
  primaryChannel: Wavelength;
}

export interface PipelineConfig {
  /** High-pass corner for the DC/baseline removal stage, Hz. */
  dcRemovalHz: number;
  /** Band-pass corners for the cardiac band, Hz. */
  bandpassLowHz: number;
  bandpassHighHz: number;
  /** Butterworth order per band edge (2 or 4). */
  filterOrder: 2 | 4;
  /** Enable the accelerometer-referenced adaptive motion-artefact canceller. */
  motionCancellation: boolean;
  /** NLMS filter length in taps and step size. */
  nlmsTaps: number;
  nlmsMu: number;
  /** Smoothing window in ms applied after motion cancellation. */
  smoothingMs: number;
  /** Refractory period as a fraction of the currently expected beat interval. */
  peakRefractoryFraction: number;
  /** Reject an IBI that deviates from the running median by more than this fraction. */
  ibiRejectFraction: number;
  /** Rolling analysis window for HRV metrics, in seconds. */
  hrvWindowSec: number;
}

export interface SimulationConfig {
  sensor: SensorConfig;
  subject: SubjectProfile;
  wear: WearConfig;
  pipeline: PipelineConfig;
  seed: number;
}

/** A scheduled activity segment within a session. */
export interface ScenarioSegment {
  id: string;
  activityId: string;
  durationSec: number;
  /** Cadence override for gait/cycling activities. */
  cadence?: number;
  /** 0..1 within the activity's own HRR band. */
  effort?: number;
}

/** One sample of ground-truth physiology, before the sensor sees it. */
export interface TruthSample {
  /** True instantaneous heart rate, bpm. */
  hr: number;
  /** True beat-to-beat interval of the most recent beat, ms. */
  ibiMs: number;
  /** True respiration rate, breaths/min. */
  respRate: number;
  /** True arterial oxygen saturation, %. */
  spo2: number;
  /** Perfusion index actually presented to the sensor, %. */
  perfusionIndex: number;
}
