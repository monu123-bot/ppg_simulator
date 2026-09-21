import { useStore } from '../state/store';
import { STAGE_META } from '../dsp/pipeline';
import { getHardware } from '../engine/hardware';
import { getActivity } from '../engine/activities';
import { cadenceHarmonics } from '../engine/motion';
import { Scope, type Trace } from '../components/Scope';
import { LineChart } from '../components/charts';
import { Callout, Card, Chip, Icon, Num, SectionHead, Segmented, Slider, Stat, Switch } from '../ui/primitives';
import type { ReactNode } from 'react';

const STAGE_TRACES: Record<string, Trace[]> = {
  raw: [{ channel: 'raw', color: '--series-1', label: 'Raw counts' }],
  dcBlock: [{ channel: 'dcBlocked', color: '--series-1', label: 'DC removed' }],
  bandpass: [{ channel: 'bandpassed', color: '--series-1', label: 'Band-passed' }],
  motion: [
    { channel: 'bandpassed', color: '--series-5', label: 'Before', width: 1.2 },
    { channel: 'motionCancelled', color: '--series-3', label: 'After' },
  ],
  smooth: [
    { channel: 'motionCancelled', color: '--series-5', label: 'Before', width: 1.2 },
    { channel: 'smoothed', color: '--series-3', label: 'Smoothed' },
  ],
  peaks: [{ channel: 'smoothed', color: '--series-3', label: 'Filtered' }],
};

export function PipelineView() {
  const { metrics, started, pipeline, sensor, activity } = useStore();
  const setPipeline = useStore((s) => s.setPipeline);
  const hw = getHardware(sensor.hardwareId);
  const profile = getActivity(activity.activityId);

  if (!started) {
    return (
      <div className="empty">
        <Icon name="layers" size={30} color="var(--ink-muted)" />
        <h2>Start a session to inspect the pipeline</h2>
        <p>
          Each stage shows its own output alongside what it is for and what breaks without it. Parameters are
          editable live, so you can switch a stage off and watch the consequence arrive downstream.
        </p>
      </div>
    );
  }

  const m = metrics;
  const harmonics = cadenceHarmonics(profile, activity.cadence);
  const nyquist = sensor.sampleRateHz / 2;

  const filterSeries = m?.filterResponse
    ? [
        {
          points: Array.from(m.filterResponse.freq).map(
            (f, i) => [f, m.filterResponse!.mag[i]] as [number, number],
          ),
          color: 'var(--series-1)',
          label: 'Band-pass response',
          fill: true,
        },
      ]
    : [];

  const ppgSpectrum = m?.ppgSpectrum
    ? normalise(Array.from(m.ppgSpectrum.freq), Array.from(m.ppgSpectrum.psd))
    : [];
  const accelSpectrum = m?.accelSpectrum
    ? normalise(Array.from(m.accelSpectrum.freq), Array.from(m.accelSpectrum.psd))
    : [];

  const stageControls: Record<string, ReactNode> = {
    dcBlock: (
      <Slider
        label="High-pass corner"
        value={pipeline.dcRemovalHz}
        min={0.05}
        max={1.5}
        step={0.05}
        onChange={(v) => setPipeline({ dcRemovalHz: v })}
        format={(v) => `${v.toFixed(2)} Hz`}
        hint="Higher corners settle faster after a step but eat into respiratory baseline information."
      />
    ),
    bandpass: (
      <div className="grid cols-3" style={{ gap: 'var(--s-3)' }}>
        <Slider
          label="Low corner"
          value={pipeline.bandpassLowHz}
          min={0.2}
          max={1.2}
          step={0.05}
          onChange={(v) => setPipeline({ bandpassLowHz: v })}
          format={(v) => `${v.toFixed(2)} Hz · ${Math.round(v * 60)} bpm`}
        />
        <Slider
          label="High corner"
          value={pipeline.bandpassHighHz}
          min={2}
          max={Math.min(12, nyquist - 0.5)}
          step={0.25}
          onChange={(v) => setPipeline({ bandpassHighHz: v })}
          format={(v) => `${v.toFixed(2)} Hz · ${Math.round(v * 60)} bpm`}
        />
        <div className="field">
          <div className="field-label">
            <span>Order</span>
          </div>
          <Segmented
            value={pipeline.filterOrder}
            onChange={(v) => setPipeline({ filterOrder: v })}
            options={[
              { value: 2, label: '2nd' },
              { value: 4, label: '4th' },
            ]}
          />
          <div className="field-hint">Steeper skirts, more group delay.</div>
        </div>
      </div>
    ),
    motion: (
      <div className="grid cols-3" style={{ gap: 'var(--s-3)' }}>
        <Switch
          checked={pipeline.motionCancellation}
          onChange={(v) => setPipeline({ motionCancellation: v })}
          label="Adaptive cancellation"
          hint={
            hw.hasAccelerometer
              ? 'Turn it off during walking or running and watch the reported rate move onto the cadence.'
              : `${hw.name} has no companion accelerometer in this configuration, so this stage has no reference to work from.`
          }
        />
        <Slider
          label="Filter length"
          value={pipeline.nlmsTaps}
          min={4}
          max={64}
          step={4}
          onChange={(v) => setPipeline({ nlmsTaps: v })}
          format={(v) => `${v} taps · ${((v / sensor.sampleRateHz) * 1000).toFixed(0)} ms`}
          hint="Must span the mechanical coupling delay, but every extra tap is another degree of freedom that can fit the pulse instead."
        />
        <Slider
          label="Step size"
          value={pipeline.nlmsMu}
          min={0.002}
          max={0.15}
          step={0.002}
          onChange={(v) => setPipeline({ nlmsMu: v })}
          format={(v) => v.toFixed(3)}
          hint="Large converges fast on a running artefact; small avoids cancelling the pulse when cadence sits near heart rate. 0.01 was the best compromise across the whole activity catalogue."
        />
      </div>
    ),
    smooth: (
      <Slider
        label="Smoothing window"
        value={pipeline.smoothingMs}
        min={0}
        max={120}
        step={5}
        onChange={(v) => setPipeline({ smoothingMs: v })}
        format={(v) => (v === 0 ? 'off' : `${v} ms`)}
        hint={`Adds ${(pipeline.smoothingMs / 2).toFixed(0)} ms of latency. Past roughly 80 ms the systolic peak itself starts to round over.`}
      />
    ),
    peaks: (
      <Slider
        label="Refractory fraction"
        value={pipeline.peakRefractoryFraction}
        min={0.2}
        max={0.8}
        step={0.05}
        onChange={(v) => setPipeline({ peakRefractoryFraction: v })}
        format={(v) => `${v.toFixed(2)} of expected interval`}
        hint="Clamped to 240–340 ms whatever you choose here. An unclamped refractory that exceeds the true interval locks out every other beat, and the detector then sits at half the true rate indefinitely."
      />
    ),
    intervals: (
      <div className="grid cols-2" style={{ gap: 'var(--s-3)' }}>
        <Slider
          label="Rejection threshold"
          value={pipeline.ibiRejectFraction}
          min={0.05}
          max={0.95}
          step={0.05}
          onChange={(v) => setPipeline({ ibiRejectFraction: v })}
          format={(v) => `±${Math.round(v * 100)}% of median`}
          hint="Tight thresholds clean the tachogram but discard genuine arrhythmia along with artefact."
        />
        <Slider
          label="HRV window"
          value={pipeline.hrvWindowSec}
          min={30}
          max={300}
          step={30}
          onChange={(v) => setPipeline({ hrvWindowSec: v })}
          format={(v) => `${v} s`}
          hint="The LF band needs at least two minutes, VLF at least five. Shorter windows respond faster and mean less."
        />
      </div>
    ),
  };

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <SectionHead title="The signal chain, stage by stage">
        Each stage below shows what it produced from what it was given. Parameters are live — change one and
        the effect propagates through every stage under it within a second. The pipeline sees only the raw
        counts and the accelerometer; nothing here has access to the model that generated them.
      </SectionHead>

      <div className="grid cols-3">
        <Card>
          <Stat
            label="End-to-end latency"
            value={<Num value={m?.groupDelayMs ?? 0} />}
            unit="ms"
            sub="Causal filters only. A zero-phase design would look better and could not run on a wrist."
          />
        </Card>
        <Card>
          <Stat
            label="Canceller effort"
            value={<Num value={m?.cancellerEnergy ?? 0} digits={1} />}
            sub="Norm of the adaptive weights — how much coupling the filter currently believes there is."
          />
        </Card>
        <Card>
          <Stat
            label="Intervals corrected"
            value={<Num value={(m?.correctedFraction ?? 0) * 100} digits={1} />}
            unit="%"
            sub={`${m?.beatsRejected ?? 0} detections rejected outright this session.`}
          />
        </Card>
      </div>

      <div className="stage-list">
        {STAGE_META.map((stage, i) => {
          const traces = STAGE_TRACES[stage.id];
          const bypassed = stage.id === 'motion' && !pipeline.motionCancellation;
          return (
            <article key={stage.id} className={`stage${bypassed ? ' bypassed' : ''}`}>
              <div className="stage-index">{i}</div>
              <div className="stage-body">
                <div className="stage-title">
                  <h3>{stage.name}</h3>
                  <Chip>{stage.technique}</Chip>
                  {bypassed && <Chip tone="warning">bypassed</Chip>}
                </div>
                <p className="stage-purpose">{stage.purpose}</p>
                <p className="stage-removed">
                  <b style={{ color: 'var(--ink-secondary)' }}>Without it: </b>
                  {stage.ifRemoved}
                </p>

                {traces && (
                  <Scope
                    traces={traces}
                    seconds={8}
                    height={112}
                    showBeats={stage.id === 'peaks'}
                    showTruthBeats={stage.id === 'peaks'}
                    includeZero={stage.id !== 'raw'}
                  />
                )}

                {stage.id === 'intervals' && m && <Tachogram nn={m.nnSeries} />}

                {stage.id === 'rateFusion' && m && <FusionPanel />}

                {stage.id === 'metrics' && m && (
                  <div className="row" style={{ gap: 'var(--s-4)' }}>
                    <Chip dot="var(--series-1)">HR {m.heartRate.toFixed(0)} bpm</Chip>
                    <Chip dot="var(--series-3)">RMSSD {m.timeDomain.rmssd.toFixed(0)} ms</Chip>
                    <Chip dot="var(--series-4)">SDNN {m.timeDomain.sdnn.toFixed(0)} ms</Chip>
                    <Chip dot="var(--series-5)">
                      Resp {m.respiration.rateBpm !== null ? `${m.respiration.rateBpm.toFixed(1)}/min` : '—'}
                    </Chip>
                    <Chip dot="var(--series-2)">
                      SpO2 {m.spo2.value !== null ? `${m.spo2.value.toFixed(1)}%` : '—'}
                    </Chip>
                  </div>
                )}

                {stageControls[stage.id] && (
                  <div
                    style={{
                      marginTop: 'var(--s-2)',
                      paddingTop: 'var(--s-3)',
                      borderTop: '1px solid var(--border)',
                    }}
                  >
                    {stageControls[stage.id]}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {/* ------------------------------------------------------- frequency */}
      <div className="grid cols-2">
        <Card
          title="Band-pass response"
          note="The filter the cardiac band passes through, with the current heart rate and the cadence harmonics marked. A cadence line inside the passband is an artefact the filter cannot help you with."
        >
          <LineChart
            series={filterSeries}
            height={200}
            yMin={0}
            yMax={1.05}
            xLabel="Hz"
            yFormat={(v) => v.toFixed(1)}
            xFormat={(v) => v.toFixed(1)}
            showLegend={false}
            markers={[
              ...(m && m.heartRate > 0
                ? [{ x: m.heartRate / 60, color: 'var(--series-3)', label: 'heart rate' }]
                : []),
              ...harmonics.map((f) => ({ x: f, color: 'var(--series-2)', dashed: true })),
            ]}
          />
          <div className="row" style={{ paddingTop: 'var(--s-2)', fontSize: 11.5, color: 'var(--ink-secondary)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i style={{ width: 11, height: 2.5, background: 'var(--series-3)', display: 'block', borderRadius: 2 }} />
              heart rate
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i style={{ width: 11, height: 2.5, background: 'var(--series-2)', display: 'block', borderRadius: 2 }} />
              cadence harmonics
            </span>
          </div>
        </Card>

        <Card
          title="Where the energy is"
          note="Power spectra of the filtered signal and of wrist acceleration, each normalised to its own peak. Vertical marks are the cadence lines the rate estimator suppressed before choosing a pulse peak."
        >
          <LineChart
            series={[
              { points: ppgSpectrum, color: 'var(--series-1)', label: 'Filtered PPG', fill: true },
              { points: accelSpectrum, color: 'var(--series-2)', label: 'Acceleration' },
            ]}
            height={200}
            yMin={0}
            yMax={1.05}
            xLabel="Hz"
            yFormat={(v) => v.toFixed(1)}
            xFormat={(v) => v.toFixed(1)}
            markers={(m?.maskedHz ?? []).map((f) => ({ x: f, color: 'var(--critical)', dashed: true }))}
          />
        </Card>
      </div>

      {harmonics.some((f) => f * 60 > 0 && m && Math.abs(f * 60 - m.heartRate) < 12) && (
        <Callout tone="warning" icon={<Icon name="alert" size={15} />}>
          <b>Cadence is sitting on the heart rate.</b> A cadence line within about 12 bpm of the pulse cannot
          be separated from it by any amount of filtering — the two occupy the same spectral bin. The rate
          estimator deliberately leaves that bin alone rather than deleting the pulse along with the artefact,
          and reports reduced confidence instead.
        </Callout>
      )}
    </div>
  );
}

function normalise(freq: number[], psd: number[]): Array<[number, number]> {
  let max = 0;
  for (const v of psd) if (v > max) max = v;
  if (max <= 0) return [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] > 6) break;
    out.push([freq[i], psd[i] / max]);
  }
  return out;
}

function Tachogram({ nn }: { nn: { t: number[]; nn: number[] } }) {
  if (nn.t.length < 4) {
    return <div className="field-hint">Collecting intervals…</div>;
  }
  const t0 = nn.t[0];
  return (
    <LineChart
      series={[
        {
          points: nn.t.map((t, i) => [t - t0, nn.nn[i]] as [number, number]),
          color: 'var(--series-1)',
          label: 'NN interval',
          width: 1.5,
        },
      ]}
      height={130}
      xLabel="s"
      yFormat={(v) => v.toFixed(0)}
      xFormat={(v) => v.toFixed(0)}
      showLegend={false}
      tooltipFormat={(x) => `t+${x.toFixed(0)} s`}
    />
  );
}

function FusionPanel() {
  const trend = useStore((s) => s.trend).slice(-300);
  const m = useStore((s) => s.metrics);
  if (!m) return null;
  return (
    <div className="stack tight">
      <div className="row">
        <Chip dot="var(--series-1)">detector {m.detectorHeartRate.toFixed(0)}</Chip>
        <Chip dot="var(--series-2)">spectral {m.spectralHeartRate.toFixed(0)}</Chip>
        <Chip tone={m.rateReliable ? undefined : 'critical'}>
          reported {m.heartRate.toFixed(0)} · {m.rateSource}
        </Chip>
        {m.harmonicCorrected && <Chip tone="warning">harmonic snapped</Chip>}
      </div>
      <LineChart
        series={[
          {
            points: trend.map((p) => [p.t, p.hr] as [number, number]),
            color: 'var(--series-1)',
            label: 'Reported',
          },
          {
            points: trend.map((p) => [p.t, p.trueHr] as [number, number]),
            color: 'var(--series-6)',
            label: 'Truth',
            dashed: true,
            width: 1.5,
          },
        ]}
        height={130}
        xLabel="s"
        yFormat={(v) => v.toFixed(0)}
        xFormat={(v) => v.toFixed(0)}
      />
    </div>
  );
}
