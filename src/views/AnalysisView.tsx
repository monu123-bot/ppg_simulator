import { useStore } from '../state/store';
import { HRV_BANDS, rmssdNorm, sdnnNorm } from '../dsp/hrv';
import { ACTIVITY_BY_ID } from '../engine/activities';
import { LineChart, PoincareChart } from '../components/charts';
import { Callout, Card, Chip, Icon, Num, SectionHead, Stat } from '../ui/primitives';
import { formatClock } from '../ui/primitives';

export function AnalysisView() {
  const { metrics, started, subject, trend, timeline, elapsed, pipeline } = useStore();
  const exportCsv = useStore((s) => s.exportCsv);

  if (!started || !metrics) {
    return (
      <div className="empty">
        <Icon name="chart" size={30} color="var(--ink-muted)" />
        <h2>Nothing to analyse yet</h2>
        <p>
          Run a session first. Frequency-domain HRV needs at least two minutes of intervals for the
          low-frequency band and five for very-low-frequency, so consider running at 20x.
        </p>
      </div>
    );
  }

  const m = metrics;
  const td = m.timeDomain;
  const fd = m.frequencyDomain;
  const rNorm = rmssdNorm(subject.age);
  const sNorm = sdnnNorm(subject.age);

  const psdSeries = fd.spectrum
    ? [
        {
          points: Array.from(fd.spectrum.freq).map(
            (f, i) => [f, fd.spectrum!.psd[i]] as [number, number],
          ),
          color: 'var(--series-1)',
          label: 'Tachogram PSD',
          fill: true,
        },
      ]
    : [];

  const t0 = m.nnSeries.t[0] ?? 0;

  // Accuracy over the session, from the trend record.
  const scored = trend.filter((p) => p.t > 20);
  const mae = scored.length
    ? scored.reduce((s, p) => s + Math.abs(p.hr - p.trueHr), 0) / scored.length
    : 0;
  const within5 = scored.length
    ? (scored.filter((p) => Math.abs(p.hr - p.trueHr) <= 5).length / scored.length) * 100
    : 0;
  const meanQuality = scored.length ? scored.reduce((s, p) => s + p.quality, 0) / scored.length : 0;

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <SectionHead title="Analysis">
        Heart-rate variability over a rolling {pipeline.hrvWindowSec}-second window, following the band
        definitions in the 1996 Task Force standard, plus a session-level scorecard against the ground truth
        the simulator knows and the pipeline does not.
      </SectionHead>

      {/* ------------------------------------------------------- scorecard */}
      <div className="grid cols-4">
        <Card>
          <Stat
            label="Mean absolute HR error"
            value={<Num value={mae} digits={1} />}
            unit="bpm"
            tone={mae < 3 ? 'good' : mae < 8 ? 'warning' : 'critical'}
            sub="Against ground truth, excluding the first 20 s of settling."
          />
        </Card>
        <Card>
          <Stat
            label="Within 5 bpm"
            value={<Num value={within5} />}
            unit="% of time"
            tone={within5 > 90 ? 'good' : within5 > 70 ? 'warning' : 'critical'}
            sub="The tolerance most consumer wearable validation studies report against."
          />
        </Card>
        <Card>
          <Stat
            label="Mean signal quality"
            value={<Num value={meanQuality} />}
            unit="/ 100"
            sub={`${m.beatsAccepted} beats accepted, ${m.beatsRejected} rejected across the session.`}
          />
        </Card>
        <Card>
          <Stat
            label="Beat timing jitter"
            value={<Num value={m.truth.beatTimingMae} digits={1} />}
            unit="ms"
            sub="After removing the pipeline's constant latency. This is what limits HRV precision."
          />
        </Card>
      </div>

      {/* ------------------------------------------------------ time domain */}
      <div className="grid cols-2">
        <Card
          title="Time-domain HRV"
          note="Computed from the screened interval series. Normative ranges are age-adjusted from Nunan (2010) and Shaffer & Ginsberg (2017)."
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="num">Value</th>
                  <th className="num">Expected</th>
                  <th>Reads as</th>
                </tr>
              </thead>
              <tbody>
                <MetricRow
                  name="Mean NN"
                  value={td.meanNn}
                  digits={1}
                  unit="ms"
                  meaning={`${td.meanHr.toFixed(1)} bpm average over the window`}
                />
                <MetricRow
                  name="SDNN"
                  value={td.sdnn}
                  digits={1}
                  unit="ms"
                  expected={`${sNorm.low.toFixed(0)}–${sNorm.high.toFixed(0)}`}
                  meaning="Total variability, all frequencies"
                />
                <MetricRow
                  name="RMSSD"
                  value={td.rmssd}
                  digits={1}
                  unit="ms"
                  expected={`${rNorm.low.toFixed(0)}–${rNorm.high.toFixed(0)}`}
                  meaning="Short-term, vagally mediated"
                />
                <MetricRow name="pNN50" value={td.pnn50} digits={1} unit="%" meaning="Successive differences over 50 ms" />
                <MetricRow name="CV(NN)" value={td.cvnn} digits={2} unit="%" meaning="SDNN normalised to mean rate" />
                <MetricRow name="SD1" value={td.sd1} digits={1} unit="ms" meaning="Poincare short axis — beat to beat" />
                <MetricRow name="SD2" value={td.sd2} digits={1} unit="ms" meaning="Poincare long axis — longer term" />
                <MetricRow name="SD1/SD2" value={td.sd1sd2} digits={3} meaning="Balance of short and long-term variability" />
                <MetricRow name="Triangular index" value={td.triangularIndex} digits={2} meaning="Geometric measure, robust to artefact" />
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Poincare plot"
          note="Each interval against the one before it. The ellipse is the SD1/SD2 fit. A healthy resting tachogram makes a comet shape; a locked-on-cadence one makes a tight blob, and ectopy throws satellite clusters off the diagonal."
        >
          <PoincareChart nn={m.nnSeries.nn} sd1={td.sd1} sd2={td.sd2} height={280} />
        </Card>
      </div>

      {/* ------------------------------------------------- frequency domain */}
      <div className="grid cols-2">
        <Card
          title="Tachogram power spectrum"
          note="The interval series resampled to 4 Hz, detrended and windowed. Band edges follow the Task Force standard: VLF below 0.04 Hz, LF to 0.15 Hz, HF to 0.40 Hz."
        >
          <LineChart
            series={psdSeries}
            height={210}
            xLabel="Hz"
            yFormat={(v) => v.toExponential(0)}
            xFormat={(v) => v.toFixed(2)}
            showLegend={false}
            bands={[
              { from: HRV_BANDS.vlf[0], to: HRV_BANDS.vlf[1], color: 'var(--series-4)' },
              { from: HRV_BANDS.lf[0], to: HRV_BANDS.lf[1], color: 'var(--series-2)' },
              { from: HRV_BANDS.hf[0], to: HRV_BANDS.hf[1], color: 'var(--series-3)' },
            ]}
            markers={
              fd.hfPeakHz > 0
                ? [{ x: fd.hfPeakHz, color: 'var(--series-3)', dashed: true }]
                : []
            }
          />
          <div className="row" style={{ paddingTop: 'var(--s-2)', fontSize: 11.5 }}>
            <Chip dot="var(--series-4)">VLF</Chip>
            <Chip dot="var(--series-2)">LF — baroreflex</Chip>
            <Chip dot="var(--series-3)">HF — respiratory</Chip>
          </div>

          {!fd.lfValid && (
            <Callout tone="warning" icon={<Icon name="alert" size={15} />}>
              Window is shorter than two minutes. The LF band needs roughly ten cycles of its lowest frequency
              before a number means anything, so these figures are shown but should not be read.
            </Callout>
          )}
        </Card>

        <Card title="Frequency-domain HRV" note="Absolute powers in ms² and the normalised units that make LF and HF comparable across people.">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Band</th>
                  <th className="num">Power (ms²)</th>
                  <th className="num">n.u.</th>
                  <th>Physiology</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="name">VLF</td>
                  <td className="num">{fd.vlf.toFixed(1)}</td>
                  <td className="num">—</td>
                  <td>Thermoregulation, humoral factors {!fd.vlfValid && <em>(needs 5 min)</em>}</td>
                </tr>
                <tr>
                  <td className="name">LF</td>
                  <td className="num">{fd.lf.toFixed(1)}</td>
                  <td className="num">{fd.lfNu.toFixed(1)}</td>
                  <td>Baroreflex loop; both branches contribute</td>
                </tr>
                <tr>
                  <td className="name">HF</td>
                  <td className="num">{fd.hf.toFixed(1)}</td>
                  <td className="num">{fd.hfNu.toFixed(1)}</td>
                  <td>Respiratory sinus arrhythmia — vagal</td>
                </tr>
                <tr>
                  <td className="name">Total</td>
                  <td className="num">{fd.totalPower.toFixed(1)}</td>
                  <td className="num">—</td>
                  <td>Everything below 0.4 Hz</td>
                </tr>
                <tr>
                  <td className="name">LF/HF</td>
                  <td className="num">{fd.lfhf.toFixed(2)}</td>
                  <td className="num">—</td>
                  <td>Often called "sympathovagal balance"; the interpretation is contested</td>
                </tr>
                <tr>
                  <td className="name">HF peak</td>
                  <td className="num">{fd.hfPeakHz > 0 ? `${fd.hfPeakHz.toFixed(3)} Hz` : '—'}</td>
                  <td className="num">
                    {fd.hfPeakHz > 0 ? `${(fd.hfPeakHz * 60).toFixed(1)}/min` : '—'}
                  </td>
                  <td>Respiratory frequency as it appears in the intervals</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ------------------------------------------------ stress and resp */}
      <div className="grid cols-2">
        <Card
          title="Autonomic load"
          note="A composite of four measures that move together under sympathetic activation: suppressed RMSSD against age expectation, raised LF/HF, the Baevsky stress index, and heart rate elevated above this person's own resting rate."
        >
          <div className="row" style={{ gap: 'var(--s-5)', alignItems: 'flex-start' }}>
            <Stat
              label="Composite score"
              value={m.stress.valid ? <Num value={m.stress.score} /> : <span className="na">—</span>}
              unit={m.stress.valid ? '/ 100' : undefined}
            />
            <Stat label="Baevsky index" value={<Num value={m.stress.baevskySi} digits={1} />} />
          </div>
          {!m.stress.valid ? (
            <Callout tone="warning" icon={<Icon name="alert" size={15} />}>
              <b>Not valid right now.</b> {m.stress.reason}. Exercise suppresses heart-rate variability in
              exactly the way psychological stress does, so a "stress score" computed while someone is moving
              is measuring the movement. Consumer wearables routinely report one anyway.
            </Callout>
          ) : (
            <Callout icon={<Icon name="info" size={15} />}>
              Valid: the wrist is still enough and the heart rate is close enough to resting for the
              variability to reflect autonomic state rather than exertion.
            </Callout>
          )}
        </Card>

        <Card
          title="Respiration"
          note="Three independent inductions, fused only when they agree — the rule from Karlen et al. (2013). When they disagree the pipeline reports nothing rather than guessing."
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Induction</th>
                  <th className="num">Estimate</th>
                  <th>Mechanism</th>
                </tr>
              </thead>
              <tbody>
                <RespRow name="RIAV" value={m.respiration.riav} mech="Pulse amplitude — stroke volume varies with intrathoracic pressure" />
                <RespRow name="RIIV" value={m.respiration.riiv} mech="Baseline — venous return shifts tissue blood volume" />
                <RespRow name="RIFV" value={m.respiration.rifv} mech="Interval — respiratory sinus arrhythmia" />
                <tr>
                  <td className="name">Fused</td>
                  <td className="num">
                    {m.respiration.rateBpm !== null ? `${m.respiration.rateBpm.toFixed(1)}/min` : '—'}
                  </td>
                  <td>
                    {m.respiration.valid
                      ? `Agreement within ${m.respiration.agreementBpm.toFixed(1)}/min · truth ${m.truth.respRate.toFixed(1)}`
                      : 'Spread too wide to fuse'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* --------------------------------------------------------- session */}
      <Card
        title="Session"
        note="Everything that happened, and the record you can take away."
        actions={
          <button className="btn" onClick={exportCsv}>
            <Icon name="download" size={14} />
            Export CSV
          </button>
        }
      >
        <div className="grid cols-2" style={{ gap: 'var(--s-4)' }}>
          <div>
            <div className="stat-label" style={{ marginBottom: 'var(--s-2)' }}>
              Activity timeline
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>At</th>
                    <th>Activity</th>
                    <th className="num">Cadence</th>
                    <th className="num">Literature HR band</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((seg, i) => {
                    const a = ACTIVITY_BY_ID[seg.activityId];
                    return (
                      <tr key={i}>
                        <td className="num">{formatClock(seg.t)}</td>
                        <td className="name">{a?.name ?? seg.activityId}</td>
                        <td className="num">
                          {a?.cadence ? `${seg.cadence} ${a.cadence.unit}` : '—'}
                        </td>
                        <td className="num">
                          {a ? `${a.hrRangeBpm[0]}–${a.hrRangeBpm[1]} bpm` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="stack tight">
            <div className="stat-label">Recovered metrics over time</div>
            <LineChart
              series={[
                {
                  points: trend.filter((p) => p.rmssd > 0).map((p) => [p.t, p.rmssd] as [number, number]),
                  color: 'var(--series-3)',
                  label: 'RMSSD ms',
                },
                {
                  points: trend.filter((p) => p.sdnn > 0).map((p) => [p.t, p.sdnn] as [number, number]),
                  color: 'var(--series-4)',
                  label: 'SDNN ms',
                },
              ]}
              height={160}
              xLabel="s"
              yFormat={(v) => v.toFixed(0)}
              xFormat={(v) => v.toFixed(0)}
            />
            <div className="field-hint">
              Session length {formatClock(elapsed)} · {m.nnSeries.nn.length} intervals in the current window
            </div>
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------- tachogram */}
      <Card
        title="Tachogram"
        note="The screened interval series that every number above is computed from. Respiratory sinus arrhythmia appears here as a regular ripple; ectopic beats appear as a short interval immediately followed by a long one."
      >
        <LineChart
          series={[
            {
              points: m.nnSeries.t.map((t, i) => [t - t0, m.nnSeries.nn[i]] as [number, number]),
              color: 'var(--series-1)',
              label: 'NN interval',
              width: 1.5,
            },
          ]}
          height={180}
          xLabel="s"
          yFormat={(v) => `${v.toFixed(0)}`}
          xFormat={(v) => v.toFixed(0)}
          showLegend={false}
          tooltipFormat={(x) => `t+${x.toFixed(0)} s`}
        />
      </Card>
    </div>
  );
}

function MetricRow({
  name,
  value,
  digits,
  unit,
  expected,
  meaning,
}: {
  name: string;
  value: number;
  digits: number;
  unit?: string;
  expected?: string;
  meaning: string;
}) {
  return (
    <tr>
      <td className="name">{name}</td>
      <td className="num">
        {Number.isFinite(value) ? value.toFixed(digits) : '—'}
        {unit && <span style={{ color: 'var(--ink-muted)' }}> {unit}</span>}
      </td>
      <td className="num" style={{ color: 'var(--ink-muted)' }}>
        {expected ?? '—'}
      </td>
      <td style={{ color: 'var(--ink-secondary)' }}>{meaning}</td>
    </tr>
  );
}

function RespRow({ name, value, mech }: { name: string; value: number | null; mech: string }) {
  return (
    <tr>
      <td className="name">{name}</td>
      <td className="num">{value !== null ? `${value.toFixed(1)}/min` : '—'}</td>
      <td style={{ color: 'var(--ink-secondary)' }}>{mech}</td>
    </tr>
  );
}
