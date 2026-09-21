import { useStore } from '../state/store';
import { getActivity } from '../engine/activities';
import { getHardware } from '../engine/hardware';
import { rmssdNorm, sdnnNorm } from '../dsp/hrv';
import { Scope } from '../components/Scope';
import { LineChart } from '../components/charts';
import { Callout, Card, Chip, Icon, Num, Stat } from '../ui/primitives';

const QUALITY_TONE: Record<string, 'good' | 'warning' | 'serious' | 'critical' | undefined> = {
  excellent: 'good',
  good: 'good',
  fair: 'warning',
  poor: 'serious',
  unusable: 'critical',
};

const STRESS_TONE: Record<string, 'good' | 'warning' | 'serious' | 'critical' | undefined> = {
  recovered: 'good',
  balanced: 'good',
  elevated: 'warning',
  high: 'serious',
  'very-high': 'critical',
};

const STRESS_LABEL: Record<string, string> = {
  recovered: 'Recovered',
  balanced: 'Balanced',
  elevated: 'Elevated',
  high: 'High',
  'very-high': 'Very high',
};

export function MonitorView() {
  const { metrics, started, activity, sensor, subject, trend, elapsed, perfusionIndex } = useStore();
  const hw = getHardware(sensor.hardwareId);
  const profile = getActivity(activity.activityId);

  if (!started || !metrics) {
    return (
      <div className="empty">
        <Icon name="pulse" size={30} color="var(--ink-muted)" />
        <h2>No session running</h2>
        <p>
          Press Start in the top bar. Waveforms appear immediately; heart-rate variability needs a minute or
          two of intervals before its numbers mean anything, so the 20x speed control is there for a reason.
        </p>
      </div>
    );
  }

  const m = metrics;
  const qTone = QUALITY_TONE[m.quality.band];
  const rNorm = rmssdNorm(subject.age);
  const sNorm = sdnnNorm(subject.age);

  const trendWindow = trend.slice(-600);
  const hrSeries = [
    {
      points: trendWindow.map((p) => [p.t, p.hr] as [number, number]),
      color: 'var(--series-1)',
      label: 'Reported',
    },
    {
      points: trendWindow.map((p) => [p.t, p.trueHr] as [number, number]),
      color: 'var(--series-6)',
      label: 'Ground truth',
      dashed: true,
      width: 1.6,
    },
  ];

  return (
    <div className="stack">
      {/* -------------------------------------------------------------- hero */}
      <Card>
        <div className="hero">
          <div>
            <div className="stat-label" style={{ marginBottom: 6 }}>
              Heart rate
              {m.harmonicCorrected && <Chip tone="warning">harmonic corrected</Chip>}
              {!m.rateReliable && <Chip tone="critical">holding — low confidence</Chip>}
            </div>
            <div
              className="hero-figure"
              style={{ color: m.rateReliable ? 'var(--ink)' : 'var(--ink-muted)' }}
            >
              <Num value={m.heartRate} />
              <span className="stat-unit">bpm</span>
            </div>
          </div>

          <div className="hero-meta">
            <div className="row">
              <Chip dot="var(--series-1)">
                detector {m.detectorHeartRate > 0 ? Math.round(m.detectorHeartRate) : '--'}
              </Chip>
              <Chip dot="var(--series-2)">
                spectral {m.spectralHeartRate > 0 ? Math.round(m.spectralHeartRate) : '--'}
              </Chip>
              <Chip>
                {Math.round(m.detectorWeight * 100)}% detector · {Math.round((1 - m.detectorWeight) * 100)}%
                spectral
              </Chip>
            </div>
            <div className="stat-sub">
              Ground truth {m.truth.hr.toFixed(1)} bpm — error{' '}
              <b style={{ color: Math.abs(m.truth.hrErrorBpm) > 8 ? 'var(--critical)' : 'var(--ink)' }}>
                {m.truth.hrErrorBpm >= 0 ? '+' : ''}
                {m.truth.hrErrorBpm.toFixed(1)}
              </b>{' '}
              bpm. The pipeline never sees this number; it is shown only so you can score it.
            </div>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--s-5)', flexWrap: 'wrap' }}>
            <Stat
              label="Signal quality"
              value={<Num value={m.quality.score} />}
              unit="/ 100"
              tone={qTone}
              sub={m.quality.limitingFactor}
              size="sm"
            />
            <Stat
              label="Beat detection"
              value={<Num value={m.truth.detectionSensitivity * 100} />}
              unit="% found"
              sub={`${(m.truth.detectionPpv * 100).toFixed(0)}% of detections real · ${m.truth.beatTimingMae.toFixed(1)} ms jitter`}
              size="sm"
            />
            <Stat
              label="Wearing"
              value={<span style={{ fontSize: 17 }}>{hw.name}</span>}
              sub={`${sensor.sampleRateHz} Hz · ${sensor.primaryChannel} · ${sensor.ledCurrentMa} mA`}
              size="sm"
            />
          </div>
        </div>
      </Card>

      {m.cadenceLockSuspected && (
        <Callout tone="warning" icon={<Icon name="alert" size={15} />}>
          <b>Possible cadence lock.</b> The beat detector and the spectrum disagree by{' '}
          {Math.abs(m.spectralHeartRate - m.detectorHeartRate).toFixed(0)} bpm. During gait the step rate and
          its harmonics land inside the cardiac band, and a tracker that follows the largest peak will report
          cadence rather than pulse. This is what the rate-fusion stage exists to catch.
        </Callout>
      )}

      {/* ------------------------------------------------------------ scopes */}
      <div className="grid cols-2">
        <Card
          title="Raw signal"
          note={`ADC counts exactly as the ${hw.name} reports them. The pulse is a fraction of a percent of this value — almost everything visible here is DC pedestal, ambient light and motion.`}
        >
          <Scope
            traces={[{ channel: 'raw', color: '--series-1', label: 'Raw counts' }]}
            seconds={10}
            height={168}
            unit="ADC counts"
          />
        </Card>

        <Card
          title="Filtered signal"
          note="After DC removal, band-passing, motion cancellation and smoothing, drawn over the true pulse the tissue actually produced. Dots mark accepted beats, crosses mark detections the interval screen rejected, and the faint ticks along the bottom are the true beat times."
        >
          <Scope
            traces={[
              { channel: 'clean', color: '--series-6', label: 'True pulse', width: 1.3, dashed: true },
              { channel: 'smoothed', color: '--series-3', label: 'Recovered' },
            ]}
            seconds={10}
            height={168}
            showBeats
            showTruthBeats
            includeZero
            unit="counts, DC removed"
          />
        </Card>
      </div>

      <div className="grid cols-2">
        <Card
          title="Wrist acceleration"
          note={
            profile.cadence
              ? `At ${activity.cadence} ${profile.cadence.unit} the arm swings at ${(activity.cadence / 120).toFixed(2)} Hz and the feet strike at ${(activity.cadence / 60).toFixed(2)} Hz — ${Math.round(activity.cadence)} bpm equivalent.`
              : 'Aperiodic movement: no cadence line for an adaptive filter to lock onto.'
          }
        >
          <Scope
            traces={[{ channel: 'accelMag', color: '--series-2', label: 'Magnitude', fill: true }]}
            seconds={10}
            height={130}
            includeZero
            unit="g"
          />
        </Card>

        <Card
          title="Motion cancellation, before and after"
          note="The band-passed signal going into the adaptive filter, and what comes out. What survives is the part of the artefact that is not a linear function of the accelerometer — no FIR filter can represent one, so nothing here can remove it."
        >
          <Scope
            traces={[
              { channel: 'bandpassed', color: '--series-5', label: 'Before', width: 1.3 },
              { channel: 'motionCancelled', color: '--series-3', label: 'After' },
            ]}
            seconds={10}
            height={130}
            includeZero
            unit="counts"
          />
        </Card>
      </div>

      {/* ------------------------------------------------------------- tiles */}
      <div className="grid cols-4">
        <Card>
          <Stat
            label="RMSSD"
            value={<Num value={m.timeDomain.rmssd} digits={1} />}
            unit="ms"
            sub={
              <>
                Age-expected {rNorm.low.toFixed(0)}–{rNorm.high.toFixed(0)} ms.{' '}
                {m.timeDomain.beats} intervals in window.
              </>
            }
          />
        </Card>
        <Card>
          <Stat
            label="SDNN"
            value={<Num value={m.timeDomain.sdnn} digits={1} />}
            unit="ms"
            sub={`Age-expected ${sNorm.low.toFixed(0)}–${sNorm.high.toFixed(0)} ms over a short window.`}
          />
        </Card>
        <Card>
          <Stat
            label="LF / HF"
            value={m.frequencyDomain.lfValid ? <Num value={m.frequencyDomain.lfhf} digits={2} /> : <span className="na">—</span>}
            sub={
              m.frequencyDomain.lfValid
                ? `${m.frequencyDomain.lfNu.toFixed(0)} LF / ${m.frequencyDomain.hfNu.toFixed(0)} HF normalised units`
                : 'Needs 2 minutes of intervals before the LF band is estimable.'
            }
          />
        </Card>
        <Card>
          <Stat
            label="Autonomic load"
            value={m.stress.valid ? <Num value={m.stress.score} /> : <span className="na">—</span>}
            unit={m.stress.valid ? '/ 100' : undefined}
            tone={m.stress.valid ? STRESS_TONE[m.stress.band] : undefined}
            sub={m.stress.valid ? STRESS_LABEL[m.stress.band] : m.stress.reason}
          />
        </Card>

        <Card>
          <Stat
            label="Respiration"
            value={m.respiration.rateBpm !== null ? <Num value={m.respiration.rateBpm} digits={1} /> : <span className="na">—</span>}
            unit={m.respiration.rateBpm !== null ? '/min' : undefined}
            sub={
              m.respiration.rateBpm !== null
                ? `Three inductions agree within ${m.respiration.agreementBpm.toFixed(1)}/min. True ${m.truth.respRate.toFixed(1)}.`
                : 'Inductions disagree — no value is better than a wrong one.'
            }
          />
        </Card>
        <Card>
          <Stat
            label="SpO2"
            value={m.spo2.value !== null ? <Num value={m.spo2.value} digits={1} /> : <span className="na">—</span>}
            unit={m.spo2.value !== null ? '%' : undefined}
            sub={m.spo2.value !== null ? `Ratio of ratios ${m.spo2.ratio.toFixed(3)} · true ${m.truth.spo2.toFixed(1)}%` : m.spo2.reason}
          />
        </Card>
        <Card>
          <Stat
            label="Perfusion index"
            value={<Num value={m.quality.perfusionIndexPct} digits={2} />}
            unit="%"
            sub={`Measured from the signal. The tissue is actually presenting ${perfusionIndex.toFixed(2)}%.`}
          />
        </Card>
        <Card>
          <Stat
            label="Pipeline latency"
            value={<Num value={m.groupDelayMs} />}
            unit="ms"
            sub="Group delay of the causal filters plus half the smoothing window. Nothing here is zero-phase, because a wearable cannot be."
          />
        </Card>
      </div>

      {/* ------------------------------------------------------------- trend */}
      <Card
        title="Heart rate over the session"
        note="Reported against ground truth. Steps in the truth line are activity changes; the lag after each one is the heart's own response time, not the pipeline's."
      >
        <LineChart
          series={hrSeries}
          height={180}
          xLabel="s"
          yFormat={(v) => v.toFixed(0)}
          xFormat={(v) => `${Math.round(v)}`}
          tooltipFormat={(x) => `t = ${x.toFixed(0)} s`}
        />
      </Card>

      <div className="grid cols-2">
        <Card title="Signal quality over the session" note="Quality tracks activity closely. Watch it fall the moment the wrist starts moving and recover within seconds of stopping.">
          <LineChart
            series={[
              {
                points: trendWindow.map((p) => [p.t, p.quality] as [number, number]),
                color: 'var(--series-3)',
                label: 'Quality',
                fill: true,
              },
            ]}
            height={150}
            yMin={0}
            yMax={100}
            xLabel="s"
            yFormat={(v) => v.toFixed(0)}
            showLegend={false}
          />
        </Card>
        <Card title="Wrist motion over the session" note="Accelerometer magnitude. The strongest single predictor of whether anything else on this screen can be believed.">
          <LineChart
            series={[
              {
                points: trendWindow.map((p) => [p.t, p.motion] as [number, number]),
                color: 'var(--series-2)',
                label: 'Motion',
                fill: true,
              },
            ]}
            height={150}
            yMin={0}
            xLabel="s"
            yFormat={(v) => v.toFixed(1)}
            showLegend={false}
          />
        </Card>
      </div>

      <p className="card-note" style={{ textAlign: 'center' }}>
        Simulated elapsed time {Math.round(elapsed)} s · {profile.name}
        {profile.cadence ? ` at ${activity.cadence} ${profile.cadence.unit}` : ''} · {m.beatsAccepted} beats
        accepted, {m.beatsRejected} rejected
      </p>
    </div>
  );
}
