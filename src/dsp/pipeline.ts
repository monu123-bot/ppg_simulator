import type { PipelineConfig, SubjectProfile } from '../engine/types';
import type { SimBlock } from '../engine/simulator';
import { Bandpass, Cascade, Ewma, MovingAverage, RunningStats, butterworthHighpass } from './filters';
import { NlmsCanceller } from './nlms';
import { PeakDetector, type DetectedBeat, scoreDetections } from './peaks';
import { BeatTemplate, assessQuality, type SignalQuality } from './sqi';
import { RingArray, RingF64 } from './ring';
import {
  assessStress,
  correctIntervals,
  frequencyDomain,
  timeDomain,
  type FrequencyDomainHrv,
  type StressAssessment,
  type TimeDomainHrv,
} from './hrv';
import { estimateRespiration, estimateSpo2, spectralHeartRate, type RespirationEstimate, type Spo2Estimate } from './vitals';
import { powerSpectrum } from './fft';
import { RateTracker, type RateEstimate } from './rate';

/**
 * The processing pipeline, stage by stage.
 *
 * Every stage keeps its own output so the UI can show what each one actually
 * did, rather than presenting the pipeline as a black box with a number coming
 * out of it. The stages are, in order:
 *
 *   0  Raw      — ADC counts exactly as the part reports them
 *   1  DC block — high-pass removes the optical DC pedestal, which is 100x the
 *                 pulse and would otherwise dominate every subsequent scale
 *   2  Band-pass— Butterworth 0.5-4 Hz keeps the cardiac band and discards
 *                 baseline wander below it and mains/shock energy above it
 *   3  Motion   — NLMS adaptive cancellation against the accelerometer axes
 *   4  Smooth   — short moving average to stabilise the peak detector
 *   5  Peaks    — adaptive-threshold systolic detection with sub-sample timing
 *   6  Intervals— plausibility screening and median correction
 *   7  Metrics  — HR, HRV, respiration, SpO2, quality, autonomic load
 */

export const STAGE_IDS = [
  'raw',
  'dcBlock',
  'bandpass',
  'motion',
  'smooth',
  'peaks',
  'intervals',
  'rateFusion',
  'metrics',
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface StageMeta {
  id: StageId;
  name: string;
  purpose: string;
  /** What breaks if you remove it. */
  ifRemoved: string;
  /** Latency this stage contributes, in ms. */
  latencyMs: number;
  /** Short technical descriptor shown as a chip. */
  technique: string;
}

export interface PipelineOutput {
  samples: number;
  t: Float64Array;
  raw: Float64Array;
  dcBlocked: Float64Array;
  bandpassed: Float64Array;
  motionCancelled: Float64Array;
  artifactEstimate: Float64Array;
  smoothed: Float64Array;
  /** Low-frequency respiratory-induced intensity component. */
  respBaseline: Float64Array;
  accelMag: Float64Array;
  /** Beats detected within this block. */
  beats: DetectedBeat[];
}

export interface PipelineMetrics {
  /** Reported heart rate after fusing the beat detector with the spectrum. */
  heartRate: number;
  /** Heart rate from the beat detector alone, bpm. */
  detectorHeartRate: number;
  /** How the reported rate was arrived at. */
  rateSource: RateEstimate['source'];
  /** Weight the fusion gave the beat detector, 0-1. */
  detectorWeight: number;
  /** True when the detector was snapped off a harmonic this second. */
  harmonicCorrected: boolean;
  /** False when the pipeline has lost the pulse and is holding its last value. */
  rateReliable: boolean;
  /** Heart rate from the spectrum, as an independent cross-check. */
  spectralHeartRate: number;
  spectralConfidence: number;
  /** True when the two disagree enough to suspect cadence lock. */
  cadenceLockSuspected: boolean;
  confidence: number;

  timeDomain: TimeDomainHrv;
  frequencyDomain: FrequencyDomainHrv;
  stress: StressAssessment;
  respiration: RespirationEstimate;
  spo2: Spo2Estimate;
  quality: SignalQuality;

  /** Beats accepted and rejected since the session started. */
  beatsAccepted: number;
  beatsRejected: number;
  correctedFraction: number;

  /** Ground-truth comparison — only the simulator can compute these. */
  truth: {
    hr: number;
    respRate: number;
    spo2: number;
    perfusionIndex: number;
    hrErrorBpm: number;
    hrAbsErrorBpm: number;
    detectionSensitivity: number;
    detectionPpv: number;
    beatTimingMae: number;
  };

  /** Current NN interval series for the tachogram and Poincare plot. */
  nnSeries: { t: number[]; nn: number[] };
  /** The beat template the quality stage has converged on. */
  template: Float64Array;
  /** Spectrum of the filtered PPG, for the signal-spectrum view. */
  ppgSpectrum: { freq: Float64Array; psd: Float64Array } | null;
  /** Spectrum of accelerometer magnitude, overlaid to expose cadence harmonics. */
  accelSpectrum: { freq: Float64Array; psd: Float64Array } | null;
  /** Frequencies the rate estimator masked out as motion, Hz. */
  maskedHz: number[];
  /** Filter magnitude response, for the pipeline view. */
  filterResponse: { freq: Float64Array; mag: Float64Array } | null;
  groupDelayMs: number;
  /** How hard the adaptive canceller is working. */
  cancellerEnergy: number;
}

export function makePipelineOutput(capacity: number): PipelineOutput {
  return {
    samples: 0,
    t: new Float64Array(capacity),
    raw: new Float64Array(capacity),
    dcBlocked: new Float64Array(capacity),
    bandpassed: new Float64Array(capacity),
    motionCancelled: new Float64Array(capacity),
    artifactEstimate: new Float64Array(capacity),
    smoothed: new Float64Array(capacity),
    respBaseline: new Float64Array(capacity),
    accelMag: new Float64Array(capacity),
    beats: [],
  };
}

/**
 * Signal-quality score below which the reported rate stops tracking and holds.
 * Chosen so that ordinary ambulation still updates while a wrist under several
 * g of sprint acceleration does not.
 */
const TRUST_QUALITY_MIN = 18;

export class PpgPipeline {
  private dcBlock: Cascade;
  private band: Bandpass;
  private respBand: Bandpass;
  /**
   * The accelerometer reference passes through a band-pass identical to the
   * signal path before it reaches the canceller.
   *
   * Without this the adaptive filter has to model the pipeline's own group
   * delay as well as the sensor coupling, and 24 taps of FIR cannot represent
   * the impulse response of a 4th-order IIR band-pass. Matching the paths
   * leaves the filter with nothing to learn but the short mechanical lag,
   * which is exactly what it is good at.
   */
  private refBand: [Bandpass, Bandpass, Bandpass];
  private nlms: NlmsCanceller;
  private smoother: MovingAverage;
  private detector: PeakDetector;
  private template = new BeatTemplate();
  private rateTracker = new RateTracker();
  private skewStats: RunningStats;

  // Rolling histories.
  private smoothedHistory: RingF64;
  private redHistory: RingF64;
  private irHistory: RingF64;
  private accelHistory: RingF64;
  private beatHistory = new RingArray<{ t: number; nn: number; amp: number; base: number }>(1200);
  private truthBeatTimes: number[] = [];
  private detectedBeatTimes: number[] = [];

  // Beat segmentation for template matching.
  private beatSegment: number[] = [];
  private lastBeatTime = -1;

  private hrEwma = 0;
  private acceptedCount = 0;
  private rejectedCount = 0;
  private clippedRecent = 0;
  private sampleCount = 0;
  private lastMetricsAt = -1;
  private lastRateAt = -1;
  private cachedMetrics: PipelineMetrics;
  private lastRespBaseline = 0;
  private motionRms = 0;
  /** Running estimate of the optical DC pedestal, for the measured perfusion index. */
  private rawDc = new Ewma(0.002);

  constructor(
    private cfg: PipelineConfig,
    private readonly sampleRate: number,
    private readonly hasAccelerometer: boolean,
    private readonly subject: SubjectProfile,
    private readonly hasRedIr: boolean,
  ) {
    this.dcBlock = butterworthHighpass(cfg.dcRemovalHz, sampleRate, 2);
    this.band = new Bandpass(cfg.bandpassLowHz, cfg.bandpassHighHz, sampleRate, cfg.filterOrder);
    this.respBand = new Bandpass(0.08, 0.7, sampleRate, 2);
    this.refBand = [
      new Bandpass(cfg.bandpassLowHz, cfg.bandpassHighHz, sampleRate, cfg.filterOrder),
      new Bandpass(cfg.bandpassLowHz, cfg.bandpassHighHz, sampleRate, cfg.filterOrder),
      new Bandpass(cfg.bandpassLowHz, cfg.bandpassHighHz, sampleRate, cfg.filterOrder),
    ];
    this.nlms = new NlmsCanceller(cfg.nlmsTaps, 3, cfg.nlmsMu, sampleRate);
    this.smoother = new MovingAverage(Math.max(1, Math.round((cfg.smoothingMs / 1000) * sampleRate)));
    this.detector = new PeakDetector({
      sampleRate,
      refractoryFraction: cfg.peakRefractoryFraction,
      rejectFraction: cfg.ibiRejectFraction,
      minIbiMs: 280,
      maxIbiMs: 2000,
    });
    this.skewStats = new RunningStats(Math.round(sampleRate * 6));
    this.smoothedHistory = new RingF64(Math.round(sampleRate * 30));
    this.redHistory = new RingF64(Math.round(sampleRate * 8));
    this.irHistory = new RingF64(Math.round(sampleRate * 8));
    this.accelHistory = new RingF64(Math.round(sampleRate * 30));
    this.cachedMetrics = emptyMetrics();
  }

  reconfigure(cfg: PipelineConfig): void {
    const rebuildFilters =
      cfg.dcRemovalHz !== this.cfg.dcRemovalHz ||
      cfg.bandpassLowHz !== this.cfg.bandpassLowHz ||
      cfg.bandpassHighHz !== this.cfg.bandpassHighHz ||
      cfg.filterOrder !== this.cfg.filterOrder;
    const rebuildSmoother = cfg.smoothingMs !== this.cfg.smoothingMs;
    const rebuildNlms = cfg.nlmsTaps !== this.cfg.nlmsTaps;

    this.cfg = cfg;
    if (rebuildFilters) {
      this.dcBlock = butterworthHighpass(cfg.dcRemovalHz, this.sampleRate, 2);
      this.band = new Bandpass(cfg.bandpassLowHz, cfg.bandpassHighHz, this.sampleRate, cfg.filterOrder);
      this.refBand = [
        new Bandpass(cfg.bandpassLowHz, cfg.bandpassHighHz, this.sampleRate, cfg.filterOrder),
        new Bandpass(cfg.bandpassLowHz, cfg.bandpassHighHz, this.sampleRate, cfg.filterOrder),
        new Bandpass(cfg.bandpassLowHz, cfg.bandpassHighHz, this.sampleRate, cfg.filterOrder),
      ];
    }
    if (rebuildSmoother) {
      this.smoother = new MovingAverage(
        Math.max(1, Math.round((cfg.smoothingMs / 1000) * this.sampleRate)),
      );
    }
    if (rebuildNlms) this.nlms = new NlmsCanceller(cfg.nlmsTaps, 3, cfg.nlmsMu, this.sampleRate);
    else this.nlms.setMu(cfg.nlmsMu);
    this.detector.reconfigure({
      refractoryFraction: cfg.peakRefractoryFraction,
      rejectFraction: cfg.ibiRejectFraction,
    });
  }

  reset(): void {
    this.dcBlock.reset();
    this.band.reset();
    this.respBand.reset();
    for (const b of this.refBand) b.reset();
    this.nlms.reset();
    this.smoother.reset();
    this.detector.reset();
    this.template.reset();
    this.rateTracker.reset();
    this.skewStats.reset();
    this.rawDc.reset();
    this.smoothedHistory.clear();
    this.redHistory.clear();
    this.irHistory.clear();
    this.accelHistory.clear();
    this.beatHistory.clear();
    this.truthBeatTimes = [];
    this.detectedBeatTimes = [];
    this.beatSegment = [];
    this.lastBeatTime = -1;
    this.hrEwma = 0;
    this.acceptedCount = 0;
    this.rejectedCount = 0;
    this.clippedRecent = 0;
    this.sampleCount = 0;
    this.lastMetricsAt = -1;
    this.lastRateAt = -1;
    this.cachedMetrics = emptyMetrics();
  }

  process(block: SimBlock, out: PipelineOutput): PipelineOutput {
    const n = block.samples;
    out.samples = n;
    out.beats = [];

    for (const b of block.beats) this.truthBeatTimes.push(b.tSec);
    if (this.truthBeatTimes.length > 4000) this.truthBeatTimes.splice(0, this.truthBeatTimes.length - 4000);

    for (let i = 0; i < n; i++) {
      const t = block.t[i];
      const raw = block.raw[i];
      if (this.sampleCount === 0) {
        // Prime every filter to the incoming DC level so the session does not
        // open with a multi-second start-up transient.
        this.dcBlock.prime(raw);
        this.band.prime(0);
        this.respBand.prime(0);
        this.rawDc.step(raw);
      }
      this.sampleCount++;
      this.rawDc.step(raw);

      // --- Stage 1: DC block
      const dc = this.dcBlock.step(raw);

      // --- Stage 2: cardiac band-pass
      const bp = this.band.step(dc);

      // Respiratory-induced intensity variation lives below the cardiac band.
      const respB = this.respBand.step(dc);
      this.lastRespBaseline = respB;

      // --- Stage 3: accelerometer-referenced motion cancellation
      const accelMag = Math.hypot(block.ax[i], block.ay[i], block.az[i]);
      this.accelHistory.push(accelMag);
      this.motionRms += 0.01 * (accelMag - this.motionRms);

      const refX = this.refBand[0].step(block.ax[i]);
      const refY = this.refBand[1].step(block.ay[i]);
      const refZ = this.refBand[2].step(block.az[i]);

      let cancelled = bp;
      let estimate = 0;
      if (this.cfg.motionCancellation && this.hasAccelerometer) {
        const r = this.nlms.step(bp, [refX, refY, refZ]);
        cancelled = r.clean;
        estimate = r.estimate;
      }

      // --- Stage 4: smoothing
      const sm = this.smoother.step(cancelled);
      this.smoothedHistory.push(sm);
      this.skewStats.push(sm);
      if (this.hasRedIr) {
        this.redHistory.push(block.red[i]);
        this.irHistory.push(block.ir[i]);
      }

      // --- Stage 5: peak detection
      this.beatSegment.push(sm);
      if (this.beatSegment.length > this.sampleRate * 2.5) this.beatSegment.shift();

      const beat = this.detector.step(sm, t);
      if (beat) {
        out.beats.push(beat);
        this.detectedBeatTimes.push(beat.tSec);
        if (this.detectedBeatTimes.length > 4000) {
          this.detectedBeatTimes.splice(0, this.detectedBeatTimes.length - 4000);
        }

        if (beat.rejected) {
          this.rejectedCount++;
        } else if (beat.ibiMs > 0) {
          this.acceptedCount++;
          this.beatHistory.push({
            t: beat.tSec,
            nn: beat.ibiMs,
            amp: beat.amplitude,
            base: this.lastRespBaseline,
          });
          // HR smoothing: fast enough to follow a real change, slow enough not
          // to flicker on a single odd interval.
          const inst = 60000 / beat.ibiMs;
          this.hrEwma = this.hrEwma === 0 ? inst : this.hrEwma + 0.22 * (inst - this.hrEwma);
        }

        // Segment the beat that just closed and score its shape.
        if (this.lastBeatTime >= 0) {
          const span = Math.round((beat.tSec - this.lastBeatTime) * this.sampleRate);
          if (span > 8 && span <= this.beatSegment.length) {
            const seg = Float64Array.from(this.beatSegment.slice(this.beatSegment.length - span));
            this.template.addBeat(seg);
          }
        }
        this.lastBeatTime = beat.tSec;
      }

      out.t[i] = t;
      out.raw[i] = raw;
      out.dcBlocked[i] = dc;
      out.bandpassed[i] = bp;
      out.motionCancelled[i] = cancelled;
      out.artifactEstimate[i] = estimate;
      out.smoothed[i] = sm;
      out.respBaseline[i] = respB;
      out.accelMag[i] = accelMag;
    }

    this.clippedRecent = this.clippedRecent * 0.85 + (block.clippedCount / Math.max(1, n)) * 0.15;

    const now = block.samples ? block.t[block.samples - 1] : 0;
    if (this.lastMetricsAt < 0 || now - this.lastMetricsAt >= 1.0) {
      this.lastMetricsAt = now;
      this.cachedMetrics = this.computeMetrics(block, now);
    }
    return out;
  }

  get metrics(): PipelineMetrics {
    return this.cachedMetrics;
  }

  /** Band-pass magnitude response, for the filter plot. */
  filterResponse(points = 160): { freq: Float64Array; mag: Float64Array } {
    const freq = new Float64Array(points);
    const mag = new Float64Array(points);
    const fMax = Math.min(this.sampleRate / 2, 12);
    for (let i = 0; i < points; i++) {
      const f = (i / (points - 1)) * fMax;
      freq[i] = f;
      mag[i] = this.band.magnitudeAt(Math.max(0.01, f), this.sampleRate);
    }
    return { freq, mag };
  }

  private computeMetrics(block: SimBlock, now: number): PipelineMetrics {
    const history = this.beatHistory.toArray();
    const windowStart = now - this.cfg.hrvWindowSec;
    const inWindow = history.filter((b) => b.t >= windowStart);

    const nnRaw = inWindow.map((b) => b.nn);
    const { corrected, correctedCount } = correctIntervals(nnRaw, this.cfg.ibiRejectFraction);

    const times = inWindow.map((b) => b.t);
    const td = timeDomain(corrected);
    const fd = frequencyDomain(times, corrected);

    const smoothedWindow = this.smoothedHistory.toArray(Math.round(this.sampleRate * 12));
    const accelWindow = this.accelHistory.toArray(Math.round(this.sampleRate * 12));
    const spectral = spectralHeartRate(
      smoothedWindow,
      accelWindow,
      this.sampleRate,
      this.rateTracker.current,
    );

    const hrFromBeats = this.hrEwma || td.meanHr;
    const spectralAgreement =
      spectral.hr > 0 && hrFromBeats > 0
        ? Math.max(0, 1 - Math.abs(spectral.hr - hrFromBeats) / 18)
        : 0.5;

    // Detector confidence: how self-consistent the beat train is. Template
    // correlation says the beats look alike, interval regularity says they are
    // spaced plausibly, and the rejection rate says how much had to be thrown
    // away to get there.
    const rejectRate =
      this.acceptedCount + this.rejectedCount > 0
        ? this.rejectedCount / (this.acceptedCount + this.rejectedCount)
        : 0;

    const recentIbis = corrected.slice(-12);
    const quality = assessQuality({
      stats: this.skewStats,
      templateCorrelation: this.template.meanCorrelation,
      recentIbisMs: recentIbis,
      perfusionIndexPct: this.measuredPerfusion(),
      clippedFraction: this.clippedRecent,
      rejectedFraction:
        this.acceptedCount + this.rejectedCount > 0
          ? this.rejectedCount / (this.acceptedCount + this.rejectedCount)
          : 0,
      spectralAgreement,
    });

    const stress = assessStress(td, fd, {
      age: this.subject.age,
      restingHr: this.subject.restingHr,
      motionG: this.motionRms,
      signalQuality: quality.score,
    });

    const respiration = estimateRespiration(
      times,
      inWindow.map((b) => b.amp),
      inWindow.map((b) => b.base),
      corrected,
    );

    const spo2 = estimateSpo2(
      this.redHistory.toArray(),
      this.irHistory.toArray(),
      this.motionRms,
      this.hasRedIr,
    );

    let intervalRegularity = 0;
    if (recentIbis.length >= 4) {
      const med = recentIbis.slice().sort((a, b) => a - b)[Math.floor(recentIbis.length / 2)];
      let dev = 0;
      for (const v of recentIbis) dev += Math.abs(v - med) / Math.max(1, med);
      intervalRegularity = Math.max(0, 1 - dev / recentIbis.length / 0.28);
    }
    // Self-consistency alone cannot arbitrate between the two estimators. A beat
    // detector that has locked onto every other beat produces a beautifully
    // regular train of near-identical beats — it scores well on template
    // correlation and interval regularity precisely when it is most wrong.
    //
    // Movement is the independent evidence that breaks the tie. The detector is
    // believed in proportion to how still the wrist is, because that is the
    // condition under which a time-domain peak means what it appears to mean.
    const selfConsistency =
      0.5 * Math.max(0, this.template.meanCorrelation) +
      0.3 * intervalRegularity +
      0.2 * (1 - Math.min(1, rejectRate * 2));
    const motionPenalty = Math.max(0.2, Math.min(1, 1 - (this.motionRms - 0.35) / 1.4));
    const detectorConfidence = Math.max(0.02, selfConsistency * motionPenalty);

    const rate = this.rateTracker.update(
      hrFromBeats,
      detectorConfidence,
      spectral.hr,
      spectral.confidence,
      now - Math.max(0, this.lastRateAt),
      quality.score >= TRUST_QUALITY_MIN,
    );
    this.lastRateAt = now;

    const hr = rate.hr;
    const cadenceLock =
      spectral.hr > 0 &&
      hrFromBeats > 0 &&
      Math.abs(spectral.hr - hrFromBeats) > 12 &&
      spectral.confidence > 0.35;

    // Ground-truth scoring over the last 30 seconds.
    const cutoff = now - 30;
    const truthRecent = this.truthBeatTimes.filter((t) => t >= cutoff);
    const detRecent = this.detectedBeatTimes.filter((t) => t >= cutoff);
    const score = scoreDetections(truthRecent, detRecent, 180);

    const ppgSpec = spectrumOf(smoothedWindow, this.sampleRate, 6);
    const accelSpec = spectrumOf(accelWindow, this.sampleRate, 6);

    return {
      heartRate: hr,
      detectorHeartRate: hrFromBeats,
      rateSource: rate.source,
      detectorWeight: rate.detectorWeight,
      harmonicCorrected: rate.harmonicCorrected,
      rateReliable: rate.reliable,
      spectralHeartRate: spectral.hr,
      spectralConfidence: spectral.confidence,
      cadenceLockSuspected: cadenceLock,
      confidence: Math.max(0, Math.min(1, (quality.score / 100) * (cadenceLock ? 0.45 : 1))),
      timeDomain: td,
      frequencyDomain: fd,
      stress,
      respiration,
      spo2,
      quality,
      beatsAccepted: this.acceptedCount,
      beatsRejected: this.rejectedCount,
      correctedFraction: corrected.length ? correctedCount / corrected.length : 0,
      truth: {
        hr: block.truth.hr,
        respRate: block.truth.respRate,
        spo2: block.truth.spo2,
        perfusionIndex: block.truth.perfusionIndex,
        hrErrorBpm: hr - block.truth.hr,
        hrAbsErrorBpm: Math.abs(hr - block.truth.hr),
        detectionSensitivity: score.tp + score.fn > 0 ? score.tp / (score.tp + score.fn) : 0,
        detectionPpv: score.tp + score.fp > 0 ? score.tp / (score.tp + score.fp) : 0,
        beatTimingMae: score.meanAbsErrorMs,
      },
      nnSeries: { t: times, nn: corrected },
      template: this.template.shape,
      ppgSpectrum: ppgSpec,
      accelSpectrum: accelSpec,
      maskedHz: spectral.maskedHz,
      filterResponse: this.filterResponse(),
      groupDelayMs:
        (this.band.groupDelaySamples(Math.max(0.8, hr / 60), this.sampleRate) / this.sampleRate) * 1000 +
        (this.smoother.windowSamples / 2 / this.sampleRate) * 1000,
      cancellerEnergy: this.nlms.weightNorm,
    };
  }

  /**
   * Perfusion index as the *algorithm* can measure it, from the ratio of the
   * pulsatile amplitude to the DC level it removed. This is deliberately an
   * estimate from the signal rather than the simulator's known value.
   */
  private measuredPerfusion(): number {
    const w = this.smoothedHistory.toArray(Math.round(this.sampleRate * 4));
    if (w.length < 16) return 0;
    const sorted = Array.from(w).sort((a, b) => a - b);
    // 5th-95th percentile rather than min-max, so one artefact spike does not
    // report itself as a magnificent pulse.
    const ac = sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)];
    const dc = Math.abs(this.rawDc.value) || 1;
    return Math.max(0, (ac / dc) * 100);
  }
}

function spectrumOf(
  data: Float64Array,
  fs: number,
  maxHz: number,
): { freq: Float64Array; psd: Float64Array } | null {
  if (data.length < fs * 3) return null;
  const spec = powerSpectrum(data, fs, { detrend: true, zeroPad: data.length * 2 });
  let cut = spec.freq.length;
  for (let i = 0; i < spec.freq.length; i++) {
    if (spec.freq[i] > maxHz) {
      cut = i;
      break;
    }
  }
  return { freq: spec.freq.slice(0, cut), psd: spec.psd.slice(0, cut) };
}


function emptyMetrics(): PipelineMetrics {
  return {
    heartRate: 0,
    detectorHeartRate: 0,
    rateSource: 'detector',
    detectorWeight: 1,
    harmonicCorrected: false,
    rateReliable: false,
    spectralHeartRate: 0,
    spectralConfidence: 0,
    cadenceLockSuspected: false,
    confidence: 0,
    timeDomain: timeDomain([]),
    frequencyDomain: frequencyDomain([], []),
    stress: { baevskySi: 0, score: 0, band: 'balanced', valid: false, reason: 'Starting up' },
    respiration: { rateBpm: null, riav: null, riiv: null, rifv: null, agreementBpm: Infinity, valid: false },
    spo2: { value: null, ratio: 0, valid: false, reason: 'Starting up' },
    quality: {
      score: 0,
      band: 'unusable',
      skewness: 0,
      templateCorrelation: 0,
      intervalRegularity: 0,
      perfusionIndexPct: 0,
      clippedFraction: 0,
      limitingFactor: 'Starting up',
    },
    beatsAccepted: 0,
    beatsRejected: 0,
    correctedFraction: 0,
    truth: {
      hr: 0,
      respRate: 0,
      spo2: 0,
      perfusionIndex: 0,
      hrErrorBpm: 0,
      hrAbsErrorBpm: 0,
      detectionSensitivity: 0,
      detectionPpv: 0,
      beatTimingMae: 0,
    },
    nnSeries: { t: [], nn: [] },
    template: new Float64Array(64),
    ppgSpectrum: null,
    accelSpectrum: null,
    maskedHz: [],
    filterResponse: null,
    groupDelayMs: 0,
    cancellerEnergy: 0,
  };
}

export const STAGE_META: StageMeta[] = [
  {
    id: 'raw',
    name: 'Raw acquisition',
    purpose:
      'Integer ADC counts straight from the optical front end. The pulse is a fraction of a percent of this number; everything else you can see is DC pedestal, ambient light and motion.',
    ifRemoved: 'Nothing — this is the input.',
    latencyMs: 0,
    technique: 'Photodiode → TIA → ADC',
  },
  {
    id: 'dcBlock',
    name: 'DC removal',
    purpose:
      'A 2nd-order high-pass strips the optical pedestal, which is typically 100 to 1000 times larger than the pulse. Until it is gone, no automatic scaling can show you the waveform at all.',
    ifRemoved: 'The pulse stays invisible under the DC level and every downstream gain is wasted on a constant.',
    latencyMs: 0,
    technique: 'Butterworth HPF, 2nd order',
  },
  {
    id: 'bandpass',
    name: 'Cardiac band-pass',
    purpose:
      'Keeps 0.5-4 Hz — roughly 30 to 240 bpm — and discards respiratory baseline wander below it along with footstrike shock, mains flicker and quantisation hash above it.',
    ifRemoved: 'Baseline wander swamps the peak detector and high-frequency noise creates false peaks on every slope.',
    latencyMs: 0,
    technique: 'Butterworth band-pass, configurable order',
  },
  {
    id: 'motion',
    name: 'Motion cancellation',
    purpose:
      'An NLMS adaptive filter learns the transfer function from each accelerometer axis into the optical signal and subtracts its estimate. It works because the pulse is uncorrelated with wrist acceleration.',
    ifRemoved: 'During gait the cadence harmonics dominate the cardiac band and the tracker reports step rate as heart rate.',
    latencyMs: 0,
    technique: 'Multi-reference NLMS, leaky',
  },
  {
    id: 'smooth',
    name: 'Smoothing',
    purpose:
      'A short moving average removes the residual ripple that survives cancellation, at the cost of half its window in latency.',
    ifRemoved: 'The peak detector fires on noise riding the systolic upstroke, splitting single beats into two.',
    latencyMs: 0,
    technique: 'Boxcar moving average',
  },
  {
    id: 'peaks',
    name: 'Systolic detection',
    purpose:
      'Adaptive amplitude threshold plus a refractory period derived from the expected interval, with parabolic interpolation to place each peak to a fraction of a sample.',
    ifRemoved: 'No beats, no intervals, no HRV. Sub-sample interpolation matters most here: at 50 Hz one sample is 20 ms of fictional RMSSD.',
    latencyMs: 0,
    technique: 'Adaptive threshold + parabolic vertex',
  },
  {
    id: 'intervals',
    name: 'Interval screening',
    purpose:
      'Each interval is checked against physiological bounds and a running median. Deviant intervals are corrected toward that median rather than deleted, so the tachogram keeps its time base.',
    ifRemoved: 'One missed beat doubles an interval and inflates RMSSD by tens of milliseconds — HRV is exquisitely sensitive to this.',
    latencyMs: 0,
    technique: 'Median-based correction (Kubios-style)',
  },
  {
    id: 'rateFusion',
    name: 'Rate fusion',
    purpose:
      'Blends the beat-detector rate with an independent spectral estimate, weighted by how self-consistent each one currently is, then holds the result to a physiological slew limit. A detector sitting on an exact harmonic is snapped back rather than averaged.',
    ifRemoved:
      'Under heavy motion the detector does not get noisy, it locks onto half or double the true rate and stays there. Nothing in the time domain alone can tell you that has happened.',
    latencyMs: 0,
    technique: 'Confidence-weighted fusion + slew limit',
  },
  {
    id: 'metrics',
    name: 'Metric extraction',
    purpose:
      'Time- and frequency-domain HRV over a rolling window, respiration by three-induction fusion, ratio-of-ratios SpO2, a fused quality index and a composite autonomic-load score.',
    ifRemoved: 'You have a beat train and no interpretation of it.',
    latencyMs: 0,
    technique: 'Task Force 1996 definitions',
  },
];
