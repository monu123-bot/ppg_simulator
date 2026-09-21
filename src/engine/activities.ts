import type { ActivityProfile } from './types';

/**
 * Activity catalogue.
 *
 * Heart-rate bands, cadence bands, MET values and autonomic character are drawn
 * from the literature listed in `REFERENCES` and cited per activity. The bands
 * describe a healthy adult; the engine maps them onto the selected subject with
 * the Karvonen heart-rate-reserve relation, so a 62-year-old with a resting HR
 * of 72 gets a different absolute HR for the same activity than a 24-year-old
 * athlete, while the relative physiological demand stays the same.
 */

export const REFERENCES: Record<string, string> = {
  tanaka2001:
    'Tanaka H, Monahan KD, Seals DR (2001). Age-predicted maximal heart rate revisited. J Am Coll Cardiol 37(1):153-156.',
  taskforce1996:
    'Task Force of the ESC and NASPE (1996). Heart rate variability: standards of measurement, physiological interpretation, and clinical use. Circulation 93:1043-1065.',
  ainsworth2011:
    'Ainsworth BE et al. (2011). 2011 Compendium of Physical Activities. Med Sci Sports Exerc 43(8):1575-1581.',
  tudorlocke2018:
    'Tudor-Locke C et al. (2018). Walking cadence (steps/min) and intensity in 21-40 year olds: CADENCE-adults. Int J Behav Nutr Phys Act 15:20.',
  dezambotti2018:
    'de Zambotti M, Trinder J, Silvani A, Colrain IM, Baker FC (2018). Dynamic coupling between the central and autonomic nervous systems during sleep. Neurosci Biobehav Rev 90:84-103.',
  herzig2018:
    'Herzig D et al. (2018). Reproducibility of heart rate variability is parameter and sleep stage dependent. Front Physiol 8:1100.',
  shaffer2017:
    'Shaffer F, Ginsberg JP (2017). An overview of heart rate variability metrics and norms. Front Public Health 5:258.',
  nunan2010:
    'Nunan D, Sandercock GRH, Brodie DA (2010). A quantitative systematic review of normal values for short-term HRV in healthy adults. Pacing Clin Electrophysiol 33(11):1407-1417.',
  baevsky2017:
    'Baevsky RM, Chernikova AG (2017). Heart rate variability analysis: physiological foundations and main methods. Cardiometry 10:66-76.',
  bent2020:
    'Bent B, Goldstein BA, Kibbe WA, Dunn JP (2020). Investigating sources of inaccuracy in wearable optical heart rate sensors. npj Digit Med 3:18.',
  charlton2022:
    'Charlton PH et al. (2022). Wearable photoplethysmography for cardiovascular monitoring. Proc IEEE 110(3):355-381.',
  zhang2015:
    'Zhang Z, Pi Z, Liu B (2015). TROIKA: a general framework for heart rate monitoring using wrist-type PPG signals during intensive physical exercise. IEEE Trans Biomed Eng 62(2):522-531.',
  allen2007:
    'Allen J (2007). Photoplethysmography and its application in clinical physiological measurement. Physiol Meas 28(3):R1-R39.',
  elgendi2012:
    'Elgendi M (2012). On the analysis of fingertip photoplethysmogram signals. Curr Cardiol Rev 8(1):14-25.',
  karlen2013:
    'Karlen W, Raman S, Ansermino JM, Dumont GA (2013). Multiparameter respiratory rate estimation from the photoplethysmogram. IEEE Trans Biomed Eng 60(7):1946-1953.',
  task2017hrr:
    'Karvonen MJ, Kentala E, Mustala O (1957). The effects of training on heart rate: a longitudinal study. Ann Med Exp Biol Fenn 35(3):307-315.',
  goldberger2006:
    'Goldberger JJ et al. (2006). Assessment of parasympathetic reactivation after exercise. Am J Physiol Heart Circ Physiol 290(6):H2446-H2452.',
  penttila2001:
    'Penttila J et al. (2001). Time domain, geometrical and frequency domain analysis of cardiac vagal outflow: effects of various respiratory patterns. Clin Physiol 21(3):365-376.',
};

export const ACTIVITIES: ActivityProfile[] = [
  // ---------------------------------------------------------------- sleep ---
  {
    id: 'sleep_deep',
    name: 'Deep sleep (N3)',
    category: 'sleep',
    summary:
      'Slow-wave sleep. Heart rate sits below daytime resting, vagal tone peaks, breathing is metronomic and the wrist is essentially still — the easiest signal a wrist sensor will ever see.',
    hrRangeBpm: [44, 58],
    hrrRange: [-0.13, -0.07],
    metRange: [0.9, 1.0],
    cadence: null,
    respRateRange: [12, 15],
    autonomic: {
      sympathetic: 0.12,
      parasympathetic: 0.95,
      rsaAmplitudeBpm: 9.5,
      mayerAmplitudeBpm: 1.8,
      lfhfTarget: 0.7,
    },
    randomMotionG: 0.004,
    motionBurstsPerMin: 0.15,
    motionCoherence: 0.05,
    perfusionScale: 1.2,
    hrResponseTauSec: 90,
    references: ['dezambotti2018', 'herzig2018', 'shaffer2017'],
  },
  {
    id: 'sleep_light',
    name: 'Light sleep (N1/N2)',
    category: 'sleep',
    summary:
      'The bulk of the night. Heart rate a few beats above slow-wave sleep with intact respiratory sinus arrhythmia and occasional arousals that show up as brief tachycardic steps.',
    hrRangeBpm: [48, 64],
    hrrRange: [-0.08, -0.02],
    metRange: [0.9, 1.0],
    cadence: null,
    respRateRange: [12, 17],
    autonomic: {
      sympathetic: 0.2,
      parasympathetic: 0.85,
      rsaAmplitudeBpm: 7.5,
      mayerAmplitudeBpm: 2.4,
      lfhfTarget: 1.1,
    },
    randomMotionG: 0.01,
    motionBurstsPerMin: 0.6,
    motionCoherence: 0.05,
    perfusionScale: 1.12,
    hrResponseTauSec: 80,
    references: ['dezambotti2018', 'herzig2018'],
  },
  {
    id: 'sleep_rem',
    name: 'REM sleep',
    category: 'sleep',
    summary:
      'Muscle atonia keeps the wrist still, but autonomic control is anything but quiet: sympathetic surges push heart rate up in irregular bursts and breathing loses its regularity. Time-domain HRV drops even though the body has not moved.',
    hrRangeBpm: [52, 76],
    hrrRange: [-0.03, 0.06],
    metRange: [0.9, 1.1],
    cadence: null,
    respRateRange: [13, 21],
    autonomic: {
      sympathetic: 0.55,
      parasympathetic: 0.5,
      rsaAmplitudeBpm: 4.0,
      mayerAmplitudeBpm: 4.5,
      lfhfTarget: 2.4,
    },
    randomMotionG: 0.006,
    motionBurstsPerMin: 0.3,
    motionCoherence: 0.05,
    perfusionScale: 1.05,
    hrResponseTauSec: 40,
    references: ['dezambotti2018', 'herzig2018'],
  },

  // ----------------------------------------------------------------- rest ---
  {
    id: 'rest_supine',
    name: 'Lying awake',
    category: 'rest',
    summary:
      'Awake and horizontal. Venous return is high, vagal tone is high and RSA is at its most visible — the condition most short-term HRV norms were actually measured in.',
    hrRangeBpm: [52, 70],
    hrrRange: [-0.04, 0.02],
    metRange: [1.0, 1.1],
    cadence: null,
    respRateRange: [11, 16],
    autonomic: {
      sympathetic: 0.2,
      parasympathetic: 0.9,
      rsaAmplitudeBpm: 9.0,
      mayerAmplitudeBpm: 2.6,
      lfhfTarget: 0.9,
    },
    randomMotionG: 0.012,
    motionBurstsPerMin: 1.2,
    motionCoherence: 0.05,
    perfusionScale: 1.15,
    hrResponseTauSec: 60,
    references: ['nunan2010', 'shaffer2017', 'taskforce1996'],
  },
  {
    id: 'rest_sitting',
    name: 'Seated rest',
    category: 'rest',
    summary:
      'Quiet sitting, the reference condition for resting heart rate. Small postural adjustments and hand movement produce short artefact bursts without ever dominating the signal.',
    hrRangeBpm: [58, 80],
    hrrRange: [0.0, 0.06],
    metRange: [1.0, 1.3],
    cadence: null,
    respRateRange: [12, 18],
    autonomic: {
      sympathetic: 0.3,
      parasympathetic: 0.75,
      rsaAmplitudeBpm: 6.5,
      mayerAmplitudeBpm: 3.2,
      lfhfTarget: 1.5,
    },
    randomMotionG: 0.025,
    motionBurstsPerMin: 3,
    motionCoherence: 0.08,
    perfusionScale: 1.0,
    hrResponseTauSec: 45,
    references: ['nunan2010', 'shaffer2017'],
  },
  {
    id: 'rest_standing',
    name: 'Standing still',
    category: 'rest',
    summary:
      'Standing shifts roughly half a litre of blood into the legs. Baroreflex compensation lifts heart rate by 10-15 bpm, cuts RSA and markedly raises low-frequency power — the classic orthostatic HRV signature.',
    hrRangeBpm: [66, 90],
    hrrRange: [0.06, 0.13],
    metRange: [1.2, 1.5],
    cadence: null,
    respRateRange: [12, 18],
    autonomic: {
      sympathetic: 0.55,
      parasympathetic: 0.45,
      rsaAmplitudeBpm: 3.8,
      mayerAmplitudeBpm: 5.5,
      lfhfTarget: 3.2,
    },
    randomMotionG: 0.04,
    motionBurstsPerMin: 4,
    motionCoherence: 0.1,
    perfusionScale: 0.9,
    hrResponseTauSec: 25,
    references: ['taskforce1996', 'shaffer2017'],
  },

  // ---------------------------------------------------------------- daily ---
  {
    id: 'desk_work',
    name: 'Desk work / typing',
    category: 'daily',
    summary:
      'Seated with near-continuous low-amplitude hand motion. Individually tiny, but typing and mouse movement arrive in bursts that land squarely in the cardiac band and never fully settle.',
    hrRangeBpm: [62, 84],
    hrrRange: [0.03, 0.1],
    metRange: [1.3, 1.8],
    cadence: null,
    respRateRange: [12, 18],
    autonomic: {
      sympathetic: 0.38,
      parasympathetic: 0.65,
      rsaAmplitudeBpm: 5.5,
      mayerAmplitudeBpm: 3.6,
      lfhfTarget: 1.9,
    },
    randomMotionG: 0.075,
    motionBurstsPerMin: 22,
    motionCoherence: 0.15,
    perfusionScale: 0.95,
    hrResponseTauSec: 40,
    references: ['charlton2022', 'bent2020'],
  },
  {
    id: 'mental_stress',
    name: 'Acute mental stress',
    category: 'daily',
    summary:
      'Cognitive load or a difficult conversation. Heart rate rises modestly but the autonomic shift is large: RSA collapses, LF/HF climbs, and peripheral vasoconstriction cuts the perfusion index — so the pulse gets smaller exactly when you most want to measure it.',
    hrRangeBpm: [72, 100],
    hrrRange: [0.1, 0.21],
    metRange: [1.3, 1.8],
    cadence: null,
    respRateRange: [14, 22],
    autonomic: {
      sympathetic: 0.82,
      parasympathetic: 0.28,
      rsaAmplitudeBpm: 2.6,
      mayerAmplitudeBpm: 6.5,
      lfhfTarget: 4.0,
    },
    randomMotionG: 0.06,
    motionBurstsPerMin: 12,
    motionCoherence: 0.12,
    perfusionScale: 0.68,
    hrResponseTauSec: 20,
    references: ['baevsky2017', 'taskforce1996', 'allen2007'],
  },
  {
    id: 'driving',
    name: 'Driving',
    category: 'daily',
    summary:
      'Moderate sympathetic activation with a wrist that is mostly static but coupled to steering micro-corrections and road vibration. Vibration adds broadband energy well above the cardiac band.',
    hrRangeBpm: [66, 92],
    hrrRange: [0.05, 0.14],
    metRange: [1.5, 2.0],
    cadence: null,
    respRateRange: [12, 19],
    autonomic: {
      sympathetic: 0.5,
      parasympathetic: 0.5,
      rsaAmplitudeBpm: 4.2,
      mayerAmplitudeBpm: 4.8,
      lfhfTarget: 2.6,
    },
    randomMotionG: 0.09,
    motionBurstsPerMin: 16,
    motionCoherence: 0.25,
    perfusionScale: 0.9,
    hrResponseTauSec: 35,
    references: ['charlton2022'],
  },
  {
    id: 'household',
    name: 'Household chores',
    category: 'daily',
    summary:
      'Cleaning, cooking, carrying. Light aerobically, brutal optically: the arm motion is large, aperiodic and unpredictable, so no adaptive filter can lock onto a reference frequency the way it can with gait.',
    hrRangeBpm: [82, 112],
    hrrRange: [0.18, 0.33],
    metRange: [2.5, 3.8],
    cadence: null,
    respRateRange: [14, 22],
    autonomic: {
      sympathetic: 0.55,
      parasympathetic: 0.45,
      rsaAmplitudeBpm: 3.6,
      mayerAmplitudeBpm: 4.0,
      lfhfTarget: 2.4,
    },
    randomMotionG: 0.62,
    motionBurstsPerMin: 34,
    motionCoherence: 0.12,
    perfusionScale: 1.0,
    hrResponseTauSec: 30,
    references: ['ainsworth2011', 'bent2020'],
  },
  {
    id: 'eating',
    name: 'Eating a meal',
    category: 'daily',
    summary:
      'Seated with repeated hand-to-mouth movements. Postprandial splanchnic vasodilation lifts heart rate slightly for a sustained period after the meal starts.',
    hrRangeBpm: [64, 88],
    hrrRange: [0.04, 0.12],
    metRange: [1.4, 1.8],
    cadence: null,
    respRateRange: [12, 18],
    autonomic: {
      sympathetic: 0.4,
      parasympathetic: 0.62,
      rsaAmplitudeBpm: 5.0,
      mayerAmplitudeBpm: 3.4,
      lfhfTarget: 1.8,
    },
    randomMotionG: 0.22,
    motionBurstsPerMin: 20,
    motionCoherence: 0.1,
    perfusionScale: 1.02,
    hrResponseTauSec: 60,
    references: ['ainsworth2011'],
  },

  // ----------------------------------------------------------- ambulatory ---
  {
    id: 'walk_slow',
    name: 'Walking — slow',
    category: 'ambulatory',
    summary:
      'Strolling pace. Below the 100 steps/min threshold that marks the start of moderate intensity, with an arm swing that is present but gentle.',
    hrRangeBpm: [78, 102],
    hrrRange: [0.18, 0.3],
    metRange: [2.0, 2.9],
    cadence: { unit: 'spm', min: 70, max: 100, default: 90, accelGRange: [0.16, 0.42] },
    respRateRange: [14, 19],
    autonomic: {
      sympathetic: 0.45,
      parasympathetic: 0.55,
      rsaAmplitudeBpm: 4.4,
      mayerAmplitudeBpm: 3.4,
      lfhfTarget: 2.0,
    },
    randomMotionG: 0.06,
    motionBurstsPerMin: 4,
    motionCoherence: 0.82,
    perfusionScale: 1.05,
    hrResponseTauSec: 30,
    references: ['tudorlocke2018', 'ainsworth2011', 'zhang2015'],
  },
  {
    id: 'walk_normal',
    name: 'Walking — normal',
    category: 'ambulatory',
    summary:
      'Ordinary walking pace. At around 100 steps/min the arm-swing fundamental lands near 0.8-0.95 Hz and its second harmonic sits right on top of a 100-115 bpm pulse — the canonical wrist-PPG confusion.',
    hrRangeBpm: [92, 118],
    hrrRange: [0.28, 0.42],
    metRange: [3.0, 4.4],
    cadence: { unit: 'spm', min: 95, max: 118, default: 108, accelGRange: [0.38, 0.72] },
    respRateRange: [15, 21],
    autonomic: {
      sympathetic: 0.55,
      parasympathetic: 0.45,
      rsaAmplitudeBpm: 3.4,
      mayerAmplitudeBpm: 3.0,
      lfhfTarget: 2.4,
    },
    randomMotionG: 0.08,
    motionBurstsPerMin: 4,
    motionCoherence: 0.88,
    perfusionScale: 1.08,
    hrResponseTauSec: 28,
    references: ['tudorlocke2018', 'ainsworth2011', 'zhang2015'],
  },
  {
    id: 'walk_brisk',
    name: 'Walking — brisk',
    category: 'ambulatory',
    summary:
      'Purposeful walking at or above 120 steps/min, approaching vigorous intensity. Arm swing amplitude roughly doubles versus a stroll and the cadence harmonics become the largest thing in the raw spectrum.',
    hrRangeBpm: [108, 138],
    hrrRange: [0.42, 0.56],
    metRange: [4.3, 6.3],
    cadence: { unit: 'spm', min: 115, max: 140, default: 126, accelGRange: [0.65, 1.15] },
    respRateRange: [18, 26],
    autonomic: {
      sympathetic: 0.68,
      parasympathetic: 0.32,
      rsaAmplitudeBpm: 2.4,
      mayerAmplitudeBpm: 2.2,
      lfhfTarget: 2.8,
    },
    randomMotionG: 0.1,
    motionBurstsPerMin: 3,
    motionCoherence: 0.9,
    perfusionScale: 1.12,
    hrResponseTauSec: 26,
    references: ['tudorlocke2018', 'ainsworth2011', 'zhang2015'],
  },
  {
    id: 'stairs',
    name: 'Climbing stairs',
    category: 'ambulatory',
    summary:
      'Short, steep and expensive. Heart rate climbs fast and keeps climbing after you stop, while each step delivers a large vertical impulse into the wrist.',
    hrRangeBpm: [118, 158],
    hrrRange: [0.55, 0.75],
    metRange: [7.0, 9.0],
    cadence: { unit: 'spm', min: 70, max: 115, default: 92, accelGRange: [0.55, 1.2] },
    respRateRange: [22, 32],
    autonomic: {
      sympathetic: 0.8,
      parasympathetic: 0.2,
      rsaAmplitudeBpm: 1.6,
      mayerAmplitudeBpm: 1.6,
      lfhfTarget: 3.4,
    },
    randomMotionG: 0.25,
    motionBurstsPerMin: 8,
    motionCoherence: 0.66,
    perfusionScale: 1.14,
    hrResponseTauSec: 20,
    references: ['ainsworth2011'],
  },

  // ------------------------------------------------------------- exercise ---
  {
    id: 'jogging',
    name: 'Jogging',
    category: 'exercise',
    summary:
      'Easy running. Cadence lands in the 150-170 steps/min band where the step fundamental (2.5-2.8 Hz) is comfortably above most heart rates, but the arm-swing subharmonic at half that rate is not.',
    hrRangeBpm: [128, 162],
    hrrRange: [0.6, 0.75],
    metRange: [7.0, 10.0],
    cadence: { unit: 'spm', min: 145, max: 172, default: 160, accelGRange: [1.4, 2.6] },
    respRateRange: [26, 38],
    autonomic: {
      sympathetic: 0.85,
      parasympathetic: 0.15,
      rsaAmplitudeBpm: 1.3,
      mayerAmplitudeBpm: 1.2,
      lfhfTarget: 3.6,
    },
    randomMotionG: 0.2,
    motionBurstsPerMin: 2,
    motionCoherence: 0.92,
    perfusionScale: 1.2,
    hrResponseTauSec: 24,
    references: ['ainsworth2011', 'zhang2015', 'bent2020'],
  },
  {
    id: 'running',
    name: 'Running',
    category: 'exercise',
    summary:
      'Sustained hard running. Wrist accelerations of 3-4 g swamp a pulse whose AC amplitude is under one percent of the DC level; without accelerometer-referenced cancellation the tracker reports cadence, not heart rate.',
    hrRangeBpm: [150, 182],
    hrrRange: [0.75, 0.89],
    metRange: [10.0, 14.0],
    cadence: { unit: 'spm', min: 165, max: 190, default: 176, accelGRange: [2.4, 4.4] },
    respRateRange: [32, 46],
    autonomic: {
      sympathetic: 0.93,
      parasympathetic: 0.07,
      rsaAmplitudeBpm: 0.8,
      mayerAmplitudeBpm: 0.8,
      lfhfTarget: 4.2,
    },
    randomMotionG: 0.28,
    motionBurstsPerMin: 2,
    motionCoherence: 0.94,
    perfusionScale: 1.24,
    hrResponseTauSec: 22,
    references: ['ainsworth2011', 'zhang2015', 'bent2020'],
  },
  {
    id: 'sprinting',
    name: 'Sprint interval',
    category: 'exercise',
    summary:
      'Maximal effort. Heart rate approaches age-predicted maximum, beat-to-beat variability all but disappears, and wrist acceleration peaks above 5 g.',
    hrRangeBpm: [168, 196],
    hrrRange: [0.88, 0.98],
    metRange: [15.0, 20.0],
    cadence: { unit: 'spm', min: 175, max: 205, default: 190, accelGRange: [4.0, 7.0] },
    respRateRange: [40, 58],
    autonomic: {
      sympathetic: 0.99,
      parasympathetic: 0.03,
      rsaAmplitudeBpm: 0.4,
      mayerAmplitudeBpm: 0.5,
      lfhfTarget: 5.0,
    },
    randomMotionG: 0.4,
    motionBurstsPerMin: 2,
    motionCoherence: 0.93,
    perfusionScale: 1.25,
    hrResponseTauSec: 16,
    references: ['ainsworth2011', 'tanaka2001'],
  },
  {
    id: 'cycling',
    name: 'Cycling',
    category: 'exercise',
    summary:
      'High cardiovascular demand with an unusually quiet wrist — the hands rest on the bars, so the dominant motion is frame vibration rather than limb swing. Wrist PPG usually performs better here than during running at the same heart rate.',
    hrRangeBpm: [112, 158],
    hrrRange: [0.5, 0.72],
    metRange: [6.0, 10.0],
    cadence: { unit: 'rpm', min: 55, max: 100, default: 82, accelGRange: [0.12, 0.35] },
    respRateRange: [24, 38],
    autonomic: {
      sympathetic: 0.82,
      parasympathetic: 0.18,
      rsaAmplitudeBpm: 1.5,
      mayerAmplitudeBpm: 1.4,
      lfhfTarget: 3.4,
    },
    randomMotionG: 0.12,
    motionBurstsPerMin: 5,
    motionCoherence: 0.55,
    perfusionScale: 1.16,
    hrResponseTauSec: 25,
    references: ['ainsworth2011', 'charlton2022'],
  },
  {
    id: 'strength',
    name: 'Strength training',
    category: 'exercise',
    summary:
      'Intermittent maximal effort with breath-holding. Heart rate steps rather than ramps, grip pressure squeezes the wrist vasculature, and the band shifts on every rep — the hardest realistic case for a wrist optical sensor.',
    hrRangeBpm: [104, 156],
    hrrRange: [0.4, 0.7],
    metRange: [4.0, 7.0],
    cadence: null,
    respRateRange: [16, 30],
    autonomic: {
      sympathetic: 0.85,
      parasympathetic: 0.2,
      rsaAmplitudeBpm: 1.8,
      mayerAmplitudeBpm: 3.0,
      lfhfTarget: 3.2,
    },
    randomMotionG: 0.95,
    motionBurstsPerMin: 26,
    motionCoherence: 0.2,
    perfusionScale: 0.72,
    hrResponseTauSec: 14,
    references: ['ainsworth2011', 'bent2020'],
  },

  // ------------------------------------------------------------- recovery ---
  {
    id: 'recovery',
    name: 'Post-exercise recovery',
    category: 'recovery',
    summary:
      'Standing or walking it off after hard effort. Heart rate falls fast for the first 60 seconds as vagal tone returns, then slowly; skin is warm and well perfused, so signal quality is briefly excellent.',
    hrRangeBpm: [84, 140],
    hrrRange: [0.16, 0.45],
    metRange: [1.5, 3.0],
    cadence: null,
    respRateRange: [20, 34],
    autonomic: {
      sympathetic: 0.6,
      parasympathetic: 0.4,
      rsaAmplitudeBpm: 3.0,
      mayerAmplitudeBpm: 4.5,
      lfhfTarget: 2.8,
    },
    randomMotionG: 0.14,
    motionBurstsPerMin: 8,
    motionCoherence: 0.15,
    perfusionScale: 1.3,
    hrResponseTauSec: 55,
    references: ['goldberger2006', 'ainsworth2011'],
  },
];

export const ACTIVITY_BY_ID: Record<string, ActivityProfile> = Object.fromEntries(
  ACTIVITIES.map((a) => [a.id, a]),
);

export function getActivity(id: string): ActivityProfile {
  const a = ACTIVITY_BY_ID[id];
  if (!a) throw new Error(`Unknown activity profile: ${id}`);
  return a;
}

export const CATEGORY_LABEL: Record<ActivityProfile['category'], string> = {
  sleep: 'Sleep',
  rest: 'Rest',
  daily: 'Daily living',
  ambulatory: 'Ambulatory',
  exercise: 'Exercise',
  recovery: 'Recovery',
};

export const CATEGORY_ORDER: ActivityProfile['category'][] = [
  'sleep',
  'rest',
  'daily',
  'ambulatory',
  'exercise',
  'recovery',
];
