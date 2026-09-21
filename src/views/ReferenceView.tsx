import { useState } from 'react';
import { ACTIVITIES, CATEGORY_LABEL, CATEGORY_ORDER, REFERENCES } from '../engine/activities';
import { HARDWARE_CATALOG, TIER_LABEL } from '../engine/hardware';
import { Card, Chip, SectionHead, Segmented } from '../ui/primitives';

type Tab = 'activities' | 'hardware' | 'method';

export function ReferenceView() {
  const [tab, setTab] = useState<Tab>('activities');

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }}>
      <SectionHead title="Reference">
        Where the numbers come from. The activity bands, hardware profiles and metric definitions used by the
        simulator are listed here in full, so any figure on screen can be traced back to a source rather than
        taken on trust.
      </SectionHead>

      <Segmented
        value={tab}
        onChange={setTab}
        label="Reference section"
        options={[
          { value: 'activities', label: 'Activity bands' },
          { value: 'hardware', label: 'Hardware profiles' },
          { value: 'method', label: 'Method and sources' },
        ]}
      />

      {tab === 'activities' && <ActivityTable />}
      {tab === 'hardware' && <HardwareTable />}
      {tab === 'method' && <MethodNotes />}
    </div>
  );
}

function ActivityTable() {
  return (
    <div className="stack">
      {CATEGORY_ORDER.map((cat) => {
        const items = ACTIVITIES.filter((a) => a.category === cat);
        if (!items.length) return null;
        return (
          <Card key={cat} title={CATEGORY_LABEL[cat]}>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ minWidth: 190 }}>Activity</th>
                    <th className="num">HR band</th>
                    <th className="num">% HRR</th>
                    <th className="num">METs</th>
                    <th className="num">Cadence</th>
                    <th className="num">Wrist accel</th>
                    <th className="num">Resp</th>
                    <th className="num">RSA p–p</th>
                    <th>Sources</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="name">{a.name}</div>
                        <div style={{ color: 'var(--ink-muted)', fontSize: 11.5, lineHeight: 1.45, maxWidth: '42ch' }}>
                          {a.summary}
                        </div>
                      </td>
                      <td className="num">
                        {a.hrRangeBpm[0]}–{a.hrRangeBpm[1]}
                      </td>
                      <td className="num">
                        {Math.round(a.hrrRange[0] * 100)}–{Math.round(a.hrrRange[1] * 100)}%
                      </td>
                      <td className="num">
                        {a.metRange[0].toFixed(1)}–{a.metRange[1].toFixed(1)}
                      </td>
                      <td className="num">
                        {a.cadence ? `${a.cadence.min}–${a.cadence.max} ${a.cadence.unit}` : '—'}
                      </td>
                      <td className="num">
                        {a.cadence
                          ? `${a.cadence.accelGRange[0].toFixed(2)}–${a.cadence.accelGRange[1].toFixed(2)} g`
                          : `${a.randomMotionG.toFixed(2)} g rms`}
                      </td>
                      <td className="num">
                        {a.respRateRange[0]}–{a.respRateRange[1]}
                      </td>
                      <td className="num">{a.autonomic.rsaAmplitudeBpm.toFixed(1)}</td>
                      <td style={{ fontSize: 11 }}>
                        {a.references.map((r) => (
                          <div key={r} style={{ color: 'var(--ink-muted)' }}>
                            {shortCite(r)}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function HardwareTable() {
  return (
    <Card
      title="Optical front ends"
      note="Representative spec profiles compiled from public datasheets and application notes. They reproduce the differences that matter to a pipeline — resolution, noise floor, ambient rejection, motion coupling — but check the current datasheet before designing hardware against them."
    >
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ minWidth: 170 }}>Part</th>
              <th>Tier</th>
              <th className="num">Bits</th>
              <th className="num">Rates (Hz)</th>
              <th className="num">Noise</th>
              <th className="num">Ambient rej.</th>
              <th className="num">Dyn. range</th>
              <th className="num">PD area</th>
              <th className="num">Motion rej.</th>
              <th className="num">Current</th>
              <th>Wavelengths</th>
            </tr>
          </thead>
          <tbody>
            {HARDWARE_CATALOG.map((h) => (
              <tr key={h.id}>
                <td>
                  <div className="name">{h.name}</div>
                  <div style={{ color: 'var(--ink-muted)', fontSize: 11.5 }}>{h.vendor}</div>
                </td>
                <td>
                  <Chip tone={h.tier === 'reference' ? 'accent' : undefined}>{TIER_LABEL[h.tier]}</Chip>
                </td>
                <td className="num">{h.adcBits}</td>
                <td className="num">
                  {h.sampleRates[0]}–{h.sampleRates[h.sampleRates.length - 1]}
                </td>
                <td className="num">{h.noiseFloorPArms < 1 ? '<1' : h.noiseFloorPArms} pA</td>
                <td className="num">{h.ambientRejectionDb} dB</td>
                <td className="num">{h.dynamicRangeDb} dB</td>
                <td className="num">{h.photodiodeAreaMm2} mm²</td>
                <td className="num">{Math.round(h.motionRobustness * 100)}%</td>
                <td className="num">{h.typicalCurrentUa ? `${h.typicalCurrentUa} µA` : '—'}</td>
                <td style={{ fontSize: 11.5 }}>
                  {h.channels.map((c) => `${c.wavelength} ${c.nm}`).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MethodNotes() {
  return (
    <div className="stack">
      <Card title="How the signal is built">
        <div className="stack tight" style={{ color: 'var(--ink-secondary)', fontSize: 13, lineHeight: 1.65 }}>
          <p style={{ margin: 0 }}>
            <b style={{ color: 'var(--ink)' }}>Rhythm.</b> Beat times come from an integral pulse frequency
            modulation accumulator driven by four oscillators: respiratory sinus arrhythmia at the current
            breathing rate, a Mayer wave near 0.1 Hz, a very-low-frequency term, and 1/f noise. Their
            amplitudes are set per activity and then scaled for the subject — variability falls with age and
            with heart rate, and rises with aerobic fitness. Heart rate itself follows the activity target
            through two cascaded lags, which is what gives onset its S-shape and recovery its faster fall.
          </p>
          <p style={{ margin: 0 }}>
            <b style={{ color: 'var(--ink)' }}>Waveform.</b> Each cycle is a sum of Gaussians — systolic wave,
            reflected wave, a small late diastolic wave — plus a windkessel runoff so the trace never quite
            returns to baseline. Ejection time shortens with heart rate following Weissler's regression; the
            reflected wave arrives earlier in stiffer arteries and fades as rate rises, until the dicrotic
            notch disappears entirely. Respiration modulates both the amplitude and the baseline, which is
            what makes respiratory rate recoverable downstream.
          </p>
          <p style={{ margin: 0 }}>
            <b style={{ color: 'var(--ink)' }}>Motion.</b> Gait puts energy at the arm-swing rate, the step
            rate and their harmonics, with a damped footstrike ring on top. The optical artefact is a
            lag-filtered mixture of the three accelerometer axes plus a squared term — the linear part is what
            an adaptive filter can remove, and the squared part is what it cannot, because no linear filter
            maps a to a².
          </p>
          <p style={{ margin: 0 }}>
            <b style={{ color: 'var(--ink)' }}>Silicon.</b> An automatic gain loop parks the DC level in the
            middle of the converter. On top of that sit electronic noise from the part's dynamic range, photon
            shot noise, noise bandwidth scaling with sample rate, an ambient pedestal after front-end
            rejection, a mains flicker tone that aliases if the sample rate is low enough, quantisation, and
            hard clipping at the rail.
          </p>
          <p style={{ margin: 0 }}>
            <b style={{ color: 'var(--ink)' }}>What the pipeline can see.</b> Only the ADC counts and the
            accelerometer. Ground-truth heart rate, the clean pulse and the injected artefact are carried
            alongside purely so the interface can score the result; no stage reads them.
          </p>
        </div>
      </Card>

      <Card title="Sources">
        <ol style={{ margin: 0, paddingLeft: '1.3em', color: 'var(--ink-secondary)', fontSize: 12.5, lineHeight: 1.7 }}>
          {Object.entries(REFERENCES).map(([key, text]) => (
            <li key={key} style={{ marginBottom: 6 }}>
              {text}
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Known limits">
        <ul style={{ margin: 0, paddingLeft: '1.3em', color: 'var(--ink-secondary)', fontSize: 12.5, lineHeight: 1.7 }}>
          <li>
            This is a model, not a dataset. It reproduces the behaviours and failure modes documented in the
            literature; it is not a substitute for recording from real wrists, and no result from it should be
            reported as an empirical finding.
          </li>
          <li>
            Metrics recovered here are pulse rate variability, not R-R variability. Pulse transit time varies
            beat to beat, so PRV runs slightly above ECG-derived HRV; agreement is good at rest and degrades
            with movement.
          </li>
          <li>
            SpO2 uses the standard linear ratio-of-ratios calibration. Real oximeters use a vendor lookup table
            fitted against arterial blood gas measurements, and are only validated down to about 70%.
          </li>
          <li>
            The hardware profiles are modelled, not measured. They are calibrated to reproduce relative
            differences between parts, not to predict any specific part's absolute performance.
          </li>
          <li>
            Sprinting at a cadence close to the heart rate is not solvable from the PPG alone, here or in
            reality. The pipeline reports reduced confidence rather than a plausible-looking number.
          </li>
        </ul>
      </Card>
    </div>
  );
}

function shortCite(key: string): string {
  const full = REFERENCES[key];
  if (!full) return key;
  const match = full.match(/^([^(]+)\((\d{4})\)/);
  if (!match) return key;
  const authors = match[1].trim();
  const first = authors.split(/,| and /)[0].trim();
  return `${first} ${match[2]}`;
}
