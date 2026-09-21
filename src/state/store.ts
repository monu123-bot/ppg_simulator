import { create } from 'zustand';
import type { PipelineConfig, SensorConfig, SubjectProfile, WearConfig } from '../engine/types';
import type { AfeDiagnostics } from '../engine/afe';
import type { PipelineMetrics } from '../dsp/pipeline';
import type { ActivityState } from '../engine/simulator';
import type { FrameMessage, WorkerCommand, WorkerEvent } from '../worker/protocol';
import { getHardware } from '../engine/hardware';
import { getActivity } from '../engine/activities';
import { cadenceToEffort } from '../engine/cardiac';
import { DEFAULT_PIPELINE, DEFAULT_SUBJECT, DEFAULT_WEAR } from './defaults';
import { signalBus } from './signalBus';

export type ViewId = 'setup' | 'monitor' | 'pipeline' | 'analysis' | 'reference';

/** One second of session history, for the trend strips and the report. */
export interface TrendPoint {
  t: number;
  hr: number;
  trueHr: number;
  quality: number;
  rmssd: number;
  sdnn: number;
  lfhf: number;
  stress: number | null;
  resp: number | null;
  spo2: number | null;
  motion: number;
  activityId: string;
  reliable: boolean;
}

interface Store {
  // --- configuration
  sensor: SensorConfig;
  subject: SubjectProfile;
  wear: WearConfig;
  pipeline: PipelineConfig;
  activity: ActivityState;
  seed: number;

  // --- session
  running: boolean;
  started: boolean;
  speed: number;
  elapsed: number;
  metrics: PipelineMetrics | null;
  diagnostics: AfeDiagnostics | null;
  perfusionIndex: number;
  motionCoupling: number;
  trend: TrendPoint[];
  /** Activity changes with the time they happened, for the report timeline. */
  timeline: Array<{ t: number; activityId: string; cadence: number }>;

  // --- ui
  view: ViewId;
  theme: 'dark' | 'light';
  inspectedStage: string | null;

  // --- actions
  setView: (v: ViewId) => void;
  toggleTheme: () => void;
  setInspectedStage: (id: string | null) => void;

  selectHardware: (id: string) => void;
  setSensor: (patch: Partial<SensorConfig>) => void;
  setSubject: (patch: Partial<SubjectProfile>) => void;
  setWear: (patch: Partial<WearConfig>) => void;
  setPipeline: (patch: Partial<PipelineConfig>) => void;
  setActivity: (activityId: string, cadence?: number) => void;
  setCadence: (cadence: number) => void;
  setEffort: (effort: number) => void;

  start: () => void;
  pause: () => void;
  reset: () => void;
  setSpeed: (s: number) => void;
  exportCsv: () => void;
}

let worker: Worker | null = null;
let pendingCsv: ((csv: string) => void) | null = null;

function post(cmd: WorkerCommand): void {
  worker?.postMessage(cmd);
}

const initialHardware = getHardware('max86141');

const initialSensor: SensorConfig = {
  hardwareId: initialHardware.id,
  sampleRateHz: initialHardware.defaultSampleRate,
  ledCurrentMa: initialHardware.defaultLedCurrentMa,
  primaryChannel: 'green',
};

const initialActivity: ActivityState = {
  activityId: 'rest_sitting',
  cadence: 0,
  effort: 0.5,
};

export const useStore = create<Store>((set, get) => ({
  sensor: initialSensor,
  subject: { ...DEFAULT_SUBJECT },
  wear: { ...DEFAULT_WEAR },
  pipeline: { ...DEFAULT_PIPELINE },
  activity: initialActivity,
  seed: 20260920,

  running: false,
  started: false,
  speed: 1,
  elapsed: 0,
  metrics: null,
  diagnostics: null,
  perfusionIndex: 0,
  motionCoupling: 0,
  trend: [],
  timeline: [{ t: 0, activityId: initialActivity.activityId, cadence: 0 }],

  view: 'setup',
  theme: 'dark',
  inspectedStage: null,

  setView: (v) => set({ view: v }),
  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', theme);
      return { theme };
    }),
  setInspectedStage: (id) => set({ inspectedStage: id }),

  selectHardware: (id) => {
    const hw = getHardware(id);
    const primary = hw.channels.some((c) => c.wavelength === 'green') ? 'green' : hw.channels[0].wavelength;
    const sensor: SensorConfig = {
      hardwareId: hw.id,
      sampleRateHz: hw.defaultSampleRate,
      ledCurrentMa: hw.defaultLedCurrentMa,
      primaryChannel: primary,
    };
    set({ sensor });
    signalBus.setSampleRate(sensor.sampleRateHz);
    signalBus.reset();
    set({ trend: [], elapsed: 0, metrics: null });
    post({ type: 'setSensor', sensor });
  },

  setSensor: (patch) => {
    const sensor = { ...get().sensor, ...patch };
    set({ sensor });
    if (patch.sampleRateHz) {
      signalBus.setSampleRate(sensor.sampleRateHz);
      signalBus.reset();
      set({ trend: [], elapsed: 0, metrics: null });
    }
    post({ type: 'setSensor', sensor });
  },

  setSubject: (patch) => {
    const subject = { ...get().subject, ...patch };
    set({ subject, trend: [], elapsed: 0, metrics: null });
    signalBus.reset();
    post({ type: 'setSubject', subject });
  },

  setWear: (patch) => {
    const wear = { ...get().wear, ...patch };
    set({ wear, trend: [], elapsed: 0, metrics: null });
    signalBus.reset();
    post({ type: 'setWear', wear });
  },

  setPipeline: (patch) => {
    const pipeline = { ...get().pipeline, ...patch };
    set({ pipeline });
    post({ type: 'setPipeline', pipeline });
  },

  setActivity: (activityId, cadence) => {
    const profile = getActivity(activityId);
    const c = cadence ?? profile.cadence?.default ?? 0;
    const effort = profile.cadence ? cadenceToEffort(profile, c) : get().activity.effort;
    const activity: ActivityState = { activityId, cadence: c, effort };
    set((s) => ({
      activity,
      timeline: [...s.timeline, { t: s.elapsed, activityId, cadence: c }],
    }));
    post({ type: 'setActivity', activity });
  },

  setCadence: (cadence) => {
    const { activity } = get();
    const profile = getActivity(activity.activityId);
    const effort = profile.cadence ? cadenceToEffort(profile, cadence) : activity.effort;
    const next = { ...activity, cadence, effort };
    set({ activity: next });
    post({ type: 'setActivity', activity: next });
  },

  setEffort: (effort) => {
    const next = { ...get().activity, effort };
    set({ activity: next });
    post({ type: 'setActivity', activity: next });
  },

  start: () => {
    set({ running: true, started: true });
    post({ type: 'start' });
  },

  pause: () => {
    set({ running: false });
    post({ type: 'pause' });
  },

  reset: () => {
    signalBus.reset();
    set((s) => ({
      running: false,
      started: false,
      elapsed: 0,
      metrics: null,
      trend: [],
      timeline: [{ t: 0, activityId: s.activity.activityId, cadence: s.activity.cadence }],
    }));
    post({ type: 'reset' });
  },

  setSpeed: (speed) => {
    set({ speed });
    post({ type: 'setSpeed', speed });
  },

  exportCsv: () => {
    pendingCsv = (csv) => {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ppg-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    };
    post({ type: 'exportRequest' });
  },
}));

/** Boot the worker and wire it to the store. Called once from `main.tsx`. */
export function initWorker(): void {
  if (worker) return;
  worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (ev: MessageEvent<WorkerEvent>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      signalBus.setSampleRate(msg.sampleRate);
      return;
    }
    if (msg.type === 'export') {
      pendingCsv?.(msg.csv);
      pendingCsv = null;
      return;
    }
    handleFrame(msg);
  };

  const s = useStore.getState();
  post({
    type: 'init',
    config: {
      sensor: s.sensor,
      subject: s.subject,
      wear: s.wear,
      pipeline: s.pipeline,
      seed: s.seed,
    },
    activity: s.activity,
  });
}

function handleFrame(frame: FrameMessage): void {
  signalBus.ingest(frame);

  const patch: Partial<Store> = {
    elapsed: frame.tEnd,
    diagnostics: frame.diagnostics,
    perfusionIndex: frame.perfusionIndex,
    motionCoupling: frame.motionCoupling,
  };

  if (frame.metrics) {
    patch.metrics = frame.metrics;
    const m = frame.metrics;
    const point: TrendPoint = {
      t: frame.tEnd,
      hr: m.heartRate,
      trueHr: m.truth.hr,
      quality: m.quality.score,
      rmssd: m.timeDomain.rmssd,
      sdnn: m.timeDomain.sdnn,
      lfhf: m.frequencyDomain.lfhf,
      stress: m.stress.valid ? m.stress.score : null,
      resp: m.respiration.rateBpm,
      spo2: m.spo2.value,
      motion: frame.accelMag.length ? frame.accelMag[frame.accelMag.length - 1] : 0,
      activityId: frame.activityId,
      reliable: m.rateReliable,
    };
    const trend = [...useStore.getState().trend, point];
    // Keep two hours of simulated time at 1 Hz.
    patch.trend = trend.length > 7200 ? trend.slice(trend.length - 7200) : trend;
  }

  useStore.setState(patch as Store);
}
