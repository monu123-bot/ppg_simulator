import type { PipelineConfig, SensorConfig, SimulationConfig, SubjectProfile, WearConfig } from '../engine/types';
import type { AfeDiagnostics } from '../engine/afe';
import type { PipelineMetrics } from '../dsp/pipeline';
import type { ActivityState } from '../engine/simulator';

/** Messages the UI sends into the worker. */
export type WorkerCommand =
  | { type: 'init'; config: SimulationConfig; activity: ActivityState }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'reset' }
  | { type: 'setActivity'; activity: ActivityState }
  | { type: 'setPipeline'; pipeline: PipelineConfig }
  | { type: 'setSensor'; sensor: SensorConfig }
  | { type: 'setWear'; wear: WearConfig }
  | { type: 'setSubject'; subject: SubjectProfile }
  | { type: 'setSpeed'; speed: number }
  | { type: 'exportRequest' };

/** One tick of waveform data plus, when it changed, the metric bundle. */
export interface FrameMessage {
  type: 'frame';
  /** Simulated time at the end of this frame, seconds. */
  tEnd: number;
  n: number;
  t: Float32Array;
  raw: Float32Array;
  dcBlocked: Float32Array;
  bandpassed: Float32Array;
  motionCancelled: Float32Array;
  artifactEstimate: Float32Array;
  smoothed: Float32Array;
  respBaseline: Float32Array;
  clean: Float32Array;
  trueArtifact: Float32Array;
  ax: Float32Array;
  ay: Float32Array;
  az: Float32Array;
  accelMag: Float32Array;
  beatTimes: Float32Array;
  beatAmps: Float32Array;
  beatRejected: Uint8Array;
  truthBeatTimes: Float32Array;
  /** Present only on the ticks where the metric bundle was recomputed. */
  metrics?: PipelineMetrics;
  diagnostics: AfeDiagnostics;
  activityId: string;
  cadence: number;
  perfusionIndex: number;
  motionCoupling: number;
  clippedCount: number;
}

export interface ReadyMessage {
  type: 'ready';
  sampleRate: number;
  hasRedIr: boolean;
}

export interface ExportMessage {
  type: 'export';
  csv: string;
}

export type WorkerEvent = FrameMessage | ReadyMessage | ExportMessage;

export const TICK_MS = 50;
