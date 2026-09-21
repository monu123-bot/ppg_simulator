/// <reference lib="webworker" />
import { PpgSimulator, makeBlock, type ActivityState, type SimBlock } from '../engine/simulator';
import { getHardware } from '../engine/hardware';
import { PpgPipeline, makePipelineOutput, type PipelineMetrics, type PipelineOutput } from '../dsp/pipeline';
import type { SimulationConfig } from '../engine/types';
import { TICK_MS, type FrameMessage, type WorkerCommand } from './protocol';

/**
 * Simulation worker.
 *
 * Generation and processing run here so the main thread never has to choose
 * between keeping the scopes at 60 fps and keeping the DSP deterministic.
 * The loop is wall-clock driven and catches up when a tick runs long, so the
 * simulated clock stays honest even if the tab is throttled.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let config: SimulationConfig | null = null;
let activity: ActivityState | null = null;
let sim: PpgSimulator | null = null;
let pipeline: PpgPipeline | null = null;
let block: SimBlock | null = null;
let out: PipelineOutput | null = null;

let running = false;
let speed = 1;
let timer: ReturnType<typeof setInterval> | null = null;
let lastWall = 0;
let carry = 0;
let lastMetrics: PipelineMetrics | null = null;

/** Rolling record of the session, for CSV export. */
const exportRows: string[] = [];
let lastExportAt = -1;

function build(): void {
  if (!config || !activity) return;
  const hw = getHardware(config.sensor.hardwareId);
  sim = new PpgSimulator(config, activity);
  pipeline = new PpgPipeline(
    config.pipeline,
    config.sensor.sampleRateHz,
    hw.hasAccelerometer || hw.id === 'ideal',
    config.subject,
    sim.hasRedIr,
  );
  const capacity = Math.max(64, Math.ceil((config.sensor.sampleRateHz * TICK_MS * 20) / 1000));
  block = makeBlock(capacity);
  out = makePipelineOutput(capacity);
  lastMetrics = null;
  exportRows.length = 0;
  exportRows.push(
    'time_s,hr_bpm,true_hr_bpm,rmssd_ms,sdnn_ms,lfhf,stress_score,resp_bpm,spo2_pct,quality,accel_g,activity',
  );
  lastExportAt = -1;
  ctx.postMessage({ type: 'ready', sampleRate: config.sensor.sampleRateHz, hasRedIr: sim.hasRedIr });
}

function tick(): void {
  if (!running || !sim || !pipeline || !block || !out || !config) return;

  const now = performance.now();
  const wallDt = Math.min(500, now - lastWall);
  lastWall = now;

  const wanted = (wallDt / 1000) * config.sensor.sampleRateHz * speed + carry;
  let n = Math.floor(wanted);
  carry = wanted - n;
  if (n <= 0) return;
  n = Math.min(n, block.raw.length);

  sim.generate(n, block);
  pipeline.process(block, out);

  const metrics = pipeline.metrics;
  const metricsChanged = metrics !== lastMetrics;
  if (metricsChanged) lastMetrics = metrics;

  const tEnd = block.t[n - 1];

  if (metricsChanged && (lastExportAt < 0 || tEnd - lastExportAt >= 1)) {
    lastExportAt = tEnd;
    exportRows.push(
      [
        tEnd.toFixed(2),
        metrics.heartRate.toFixed(2),
        metrics.truth.hr.toFixed(2),
        metrics.timeDomain.rmssd.toFixed(2),
        metrics.timeDomain.sdnn.toFixed(2),
        metrics.frequencyDomain.lfhf.toFixed(3),
        metrics.stress.valid ? metrics.stress.score.toFixed(1) : '',
        metrics.respiration.rateBpm !== null ? metrics.respiration.rateBpm.toFixed(2) : '',
        metrics.spo2.value !== null ? metrics.spo2.value.toFixed(1) : '',
        metrics.quality.score.toFixed(1),
        out.accelMag[n - 1].toFixed(4),
        sim.currentActivity.id,
      ].join(','),
    );
    if (exportRows.length > 40000) exportRows.splice(1, 1000);
  }

  const beats = out.beats;
  const beatTimes = new Float32Array(beats.length);
  const beatAmps = new Float32Array(beats.length);
  const beatRejected = new Uint8Array(beats.length);
  for (let i = 0; i < beats.length; i++) {
    beatTimes[i] = beats[i].tSec;
    beatAmps[i] = beats[i].amplitude;
    beatRejected[i] = beats[i].rejected ? 1 : 0;
  }
  const truthBeatTimes = new Float32Array(block.beats.length);
  for (let i = 0; i < block.beats.length; i++) truthBeatTimes[i] = block.beats[i].tSec;

  // The ground-truth channels are generated in normalised pulse units while
  // every pipeline channel is in ADC counts. Scaling them here means a scope
  // can overlay truth on a recovered waveform and have the comparison mean
  // something, instead of drawing one of them as a flat line.
  const diagnostics = sim.diagnostics();
  const truthScale = diagnostics.lsbPerPulse || 1;
  const cleanScaled = f32(block.clean, n);
  const artifactScaled = f32(block.artifact, n);
  for (let i = 0; i < n; i++) {
    cleanScaled[i] *= truthScale;
    artifactScaled[i] *= truthScale;
  }

  const msg: FrameMessage = {
    type: 'frame',
    tEnd,
    n,
    t: f32(out.t, n),
    raw: f32(out.raw, n),
    dcBlocked: f32(out.dcBlocked, n),
    bandpassed: f32(out.bandpassed, n),
    motionCancelled: f32(out.motionCancelled, n),
    artifactEstimate: f32(out.artifactEstimate, n),
    smoothed: f32(out.smoothed, n),
    respBaseline: f32(out.respBaseline, n),
    clean: cleanScaled,
    trueArtifact: artifactScaled,
    ax: f32(block.ax, n),
    ay: f32(block.ay, n),
    az: f32(block.az, n),
    accelMag: f32(out.accelMag, n),
    beatTimes,
    beatAmps,
    beatRejected,
    truthBeatTimes,
    diagnostics,
    activityId: sim.currentActivity.id,
    cadence: sim.currentCadence,
    perfusionIndex: sim.perfusionIndex,
    motionCoupling: sim.motionCouplingGain(),
    clippedCount: block.clippedCount,
  };
  if (metricsChanged) msg.metrics = metrics;

  const transfer: Transferable[] = [
    msg.t.buffer,
    msg.raw.buffer,
    msg.dcBlocked.buffer,
    msg.bandpassed.buffer,
    msg.motionCancelled.buffer,
    msg.artifactEstimate.buffer,
    msg.smoothed.buffer,
    msg.respBaseline.buffer,
    msg.clean.buffer,
    msg.trueArtifact.buffer,
    msg.ax.buffer,
    msg.ay.buffer,
    msg.az.buffer,
    msg.accelMag.buffer,
    beatTimes.buffer,
    beatAmps.buffer,
    beatRejected.buffer,
    truthBeatTimes.buffer,
  ];
  ctx.postMessage(msg, transfer);
}

function f32(src: Float64Array, n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = src[i];
  return a;
}

function startLoop(): void {
  if (timer !== null) return;
  lastWall = performance.now();
  carry = 0;
  timer = setInterval(tick, TICK_MS);
}

function stopLoop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

ctx.onmessage = (ev: MessageEvent<WorkerCommand>) => {
  const cmd = ev.data;
  switch (cmd.type) {
    case 'init':
      config = cmd.config;
      activity = cmd.activity;
      build();
      break;

    case 'start':
      if (!sim) build();
      running = true;
      startLoop();
      break;

    case 'pause':
      running = false;
      stopLoop();
      break;

    case 'reset':
      running = false;
      stopLoop();
      build();
      break;

    case 'setActivity':
      activity = cmd.activity;
      sim?.setActivity(cmd.activity);
      break;

    case 'setPipeline':
      if (config) config.pipeline = cmd.pipeline;
      pipeline?.reconfigure(cmd.pipeline);
      break;

    case 'setSensor':
      // Sample rate and hardware changes require rebuilding every filter, so
      // the session restarts rather than silently producing invalid state.
      if (config) {
        config.sensor = cmd.sensor;
        const wasRunning = running;
        stopLoop();
        build();
        if (wasRunning) startLoop();
      }
      break;

    case 'setWear':
      if (config) {
        config.wear = cmd.wear;
        const wasRunning = running;
        stopLoop();
        build();
        if (wasRunning) startLoop();
      }
      break;

    case 'setSubject':
      if (config) {
        config.subject = cmd.subject;
        const wasRunning = running;
        stopLoop();
        build();
        if (wasRunning) startLoop();
      }
      break;

    case 'setSpeed':
      speed = cmd.speed;
      break;

    case 'exportRequest':
      ctx.postMessage({ type: 'export', csv: exportRows.join('\n') });
      break;
  }
};
