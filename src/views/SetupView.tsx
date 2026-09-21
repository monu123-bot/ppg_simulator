import { useMemo } from 'react';
import { useStore } from '../state/store';
import { HARDWARE_CATALOG, TIER_LABEL, getHardware } from '../engine/hardware';
import { getActivity } from '../engine/activities';
import { AnalogFrontEnd } from '../engine/afe';
import { perfusionIndexPercent } from '../engine/pulse';
import { maxHeartRate } from '../engine/cardiac';
import { PIPELINE_PRESETS, SUBJECT_PRESETS } from '../state/defaults';
import { Callout, Card, Chip, Icon, Num, SectionHead, Select, Slider, Stat } from '../ui/primitives';

const WAVELENGTH_SWATCH: Record<string, string> = {
  green: '#2fbf71',
  red: '#d64545',
  ir: '#6b5bd2',
};

const FITZPATRICK_NOTE: Record<number, string> = {
  1: 'I — always burns, never tans',
  2: 'II — usually burns',
  3: 'III — sometimes burns',
  4: 'IV — rarely burns',
  5: 'V — very rarely burns',
  6: 'VI — never burns',
};

export function SetupView() {
  const { sensor, subject, wear, pipeline, activity, started } = useStore();
  const selectHardware = useStore((s) => s.selectHardware);
  const setSensor = useStore((s) => s.setSensor);
  const setSubject = useStore((s) => s.setSubject);
  const setWear = useStore((s) => s.setWear);
  const setPipeline = useStore((s) => s.setPipeline);
  const setView = useStore((s) => s.setView);
  const start = useStore((s) => s.start);

  const hw = getHardware(sensor.hardwareId);

  /**
   * Front-end preview.
   *
   * Recomputed on the main thread from the same model the worker runs, so the
   * consequences of a slider are visible before the session starts rather than
   * ten seconds after it does.
   */
  const preview = useMemo(() => {
    const afe = new AnalogFrontEnd(hw, subject, wear, sensor.sampleRateHz, sensor.ledCurrentMa, 1);
    const pi = perfusionIndexPercent(subject, getActivity(activity.activityId), wear);
    return { diag: afe.diagnostics(sensor.primaryChannel, pi), pi };
  }, [hw, subject, wear, sensor, activity.activityId]);

  const { diag, pi } = preview;
  const snrTone = diag.acSnrDb > 32 ? 'good' : diag.acSnrDb > 20 ? 'warning' : 'critical';
  const headroomPct = diag.headroomUsed * 100;
  const activePreset = PIPELINE_PRESETS.find(
    (p) => JSON.stringify(p.pipeline) === JSON.stringify(pipeline),
  );

  return (
    <div className="stack" style={{ gap: 'var(--s-6)' }}>
      <SectionHead title="Configure the measurement">
        Pick an optical front end, describe the person wearing it and set up how it sits on the wrist. Every
        choice here changes the signal the pipeline has to work with — the preview on the right updates as you
        go, so you can see a decision land before you start a session.
      </SectionHead>

      <div className="grid sidebar">
        <div className="stack" style={{ gap: 'var(--s-6)' }}>
          {/* ---------------------------------------------------------- sensor */}
          <div>
            <header className="card-head">
              <div>
                <h2 className="card-title">Optical front end</h2>
                <p className="card-note">
                  Eight widely-deployed parts spanning research grade to legacy, plus a noiseless reference so
                  you can separate what the physiology is doing from what the silicon is adding.
                </p>
              </div>
            </header>
            <div className="hw-grid">
              {HARDWARE_CATALOG.map((h) => (
                <button
                  key={h.id}
                  className="hw-card"
                  aria-pressed={h.id === sensor.hardwareId}
                  onClick={() => selectHardware(h.id)}
                >
                  <div className="hw-card-top">
                    <div style={{ minWidth: 0 }}>
                      <h3 className="hw-name">{h.name}</h3>
                      <div className="hw-vendor">{h.vendor}</div>
                    </div>
                    <div className="wavelengths" title={h.channels.map((c) => `${c.wavelength} ${c.nm} nm`).join(', ')}>
                      {h.channels.map((c) => (
                        <i key={c.wavelength} style={{ background: WAVELENGTH_SWATCH[c.wavelength] }} />
                      ))}
                    </div>
                  </div>
                  <Chip tone={h.tier === 'reference' ? 'accent' : undefined}>{TIER_LABEL[h.tier]}</Chip>
                  <p className="hw-tagline">{h.tagline}</p>
                  <div className="hw-specs">
                    <div className="hw-spec">
                      <b>{h.adcBits}</b>
                      <span>bits</span>
                    </div>
                    <div className="hw-spec">
                      <b>{h.noiseFloorPArms < 1 ? '<1' : h.noiseFloorPArms}</b>
                      <span>pA rms</span>
                    </div>
                    <div className="hw-spec">
                      <b>{Math.round(h.motionRobustness * 100)}</b>
                      <span>motion rej.</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <Card
            title={`${hw.name} operating point`}
            note={hw.description}
          >
            <div className="grid cols-3" style={{ gap: 'var(--s-4)', marginTop: 'var(--s-3)' }}>
              <Select
                label="Sample rate"
                value={sensor.sampleRateHz}
                options={hw.sampleRates.map((r) => ({ value: r, label: `${r} Hz` }))}
                onChange={(v) => setSensor({ sampleRateHz: v })}
                hint="Higher rates resolve the systolic upstroke better and place peaks more precisely, at the cost of power and noise bandwidth."
              />
              <Select
                label="Primary channel"
                value={sensor.primaryChannel}
                options={hw.channels.map((c) => ({
                  value: c.wavelength,
                  label: `${c.wavelength} · ${c.nm} nm`,
                }))}
                onChange={(v) => setSensor({ primaryChannel: v })}
                hint="Green gives the largest wrist pulse and the best motion tolerance; infrared penetrates deeper but picks up more venous modulation."
              />
              <Slider
                label="LED drive current"
                value={sensor.ledCurrentMa}
                min={hw.ledCurrentMaRange[0] || 1}
                max={hw.ledCurrentMaRange[1]}
                step={1}
                onChange={(v) => setSensor({ ledCurrentMa: v })}
                format={(v) => `${v} mA`}
                hint="More light lifts the signal above the electronic noise floor, until the gain loop or the ADC runs out of headroom."
              />
            </div>

            <ul style={{ margin: 'var(--s-4) 0 0', paddingLeft: '1.1em', color: 'var(--ink-secondary)', fontSize: 12.5, lineHeight: 1.6 }}>
              {hw.highlights.map((hl) => (
                <li key={hl}>{hl}</li>
              ))}
            </ul>
            <p className="card-note" style={{ marginTop: 'var(--s-3)', fontStyle: 'italic' }}>
              {hw.sourceNote}
            </p>
          </Card>

          {/* --------------------------------------------------------- subject */}
          <Card
            title="Subject"
            note="Physiology is generated for this person specifically: the activity catalogue states a demand as a percentage of heart-rate reserve, and that is mapped onto their own resting rate and age-predicted maximum."
          >
            <div className="row" style={{ marginBottom: 'var(--s-4)' }}>
              {SUBJECT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="btn"
                  onClick={() => setSubject(p.subject)}
                  title={p.note}
                >
                  {p.name}
                </button>
              ))}
            </div>

            <div className="grid cols-3" style={{ gap: 'var(--s-4)' }}>
              <Slider
                label="Age"
                value={subject.age}
                min={18}
                max={85}
                onChange={(v) => setSubject({ age: v })}
                format={(v) => `${v} yr`}
                hint={`Predicted maximum ${Math.round(maxHeartRate(subject.age))} bpm (Tanaka 2001). HRV amplitude and arterial stiffness both track age.`}
              />
              <Slider
                label="Resting heart rate"
                value={subject.restingHr}
                min={38}
                max={90}
                onChange={(v) => setSubject({ restingHr: v })}
                format={(v) => `${v} bpm`}
                hint="The bottom of the heart-rate reserve every activity is scaled against."
              />
              <Slider
                label="Aerobic fitness"
                value={subject.fitness}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setSubject({ fitness: v })}
                format={(v) => `${Math.round(v * 100)}%`}
                hint="A fitter person reaches the same external workload at a lower fraction of their reserve, and carries more vagal reserve at rest."
              />
              <Slider
                label="Skin phototype"
                value={subject.fitzpatrick}
                min={1}
                max={6}
                onChange={(v) => setSubject({ fitzpatrick: v as 1 | 2 | 3 | 4 | 5 | 6 })}
                format={(v) => `${['', 'I', 'II', 'III', 'IV', 'V', 'VI'][v]}`}
                hint={`${FITZPATRICK_NOTE[subject.fitzpatrick]}. Melanin absorbs strongly at 525 nm, so the same LED current returns a smaller green pulse at higher phototypes — a documented and consequential source of wearable inaccuracy.`}
              />
              <Slider
                label="Body-mass index"
                value={subject.bmi}
                min={17}
                max={42}
                step={0.5}
                onChange={(v) => setSubject({ bmi: v })}
                format={(v) => v.toFixed(1)}
                hint="More subcutaneous tissue between the sensor and the vasculature lowers the pulsatile fraction."
              />
              <Slider
                label="Ectopic beats"
                value={subject.ectopicPerMin}
                min={0}
                max={12}
                step={0.5}
                onChange={(v) => setSubject({ ectopicPerMin: v })}
                format={(v) => (v === 0 ? 'none' : `${v}/min`)}
                hint="Premature beats with a compensatory pause. The fastest way to see why an interval series has to be screened before HRV is computed."
              />
            </div>
          </Card>

          {/* ------------------------------------------------------------ wear */}
          <Card
            title="Wear and environment"
            note="How the sensor sits on the wrist decides more about signal quality than which part you bought."
          >
            <div className="grid cols-3" style={{ gap: 'var(--s-4)' }}>
              <Slider
                label="Band tightness"
                value={wear.bandTightness}
                min={0.1}
                max={1}
                step={0.01}
                onChange={(v) => setWear({ bandTightness: v })}
                format={(v) => (v < 0.4 ? 'loose' : v < 0.72 ? 'firm' : 'tight')}
                hint="Loose lets the sensor move against the skin and couples motion straight into the optical path. Too tight occludes the very capillaries being measured."
              />
              <Slider
                label="Placement from styloid"
                value={wear.placementMm}
                min={5}
                max={45}
                onChange={(v) => setWear({ placementMm: v })}
                format={(v) => `${v} mm`}
                hint="Sitting on the wrist bone rather than soft tissue costs perfusion."
              />
              <Slider
                label="Ambient light"
                value={wear.ambientLight}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setWear({ ambientLight: v })}
                format={(v) => (v < 0.15 ? 'dark room' : v < 0.45 ? 'indoors' : v < 0.8 ? 'daylight' : 'direct sun')}
                hint="Consumes converter headroom and injects a flicker tone at twice the mains frequency."
              />
              <Slider
                label="Skin temperature"
                value={wear.skinTempC}
                min={24}
                max={37}
                step={0.5}
                onChange={(v) => setWear({ skinTempC: v })}
                format={(v) => `${v.toFixed(1)} °C`}
                hint="Cold peripheries vasoconstrict. Below about 28 °C the pulsatile signal collapses — the single most common reason a wrist tracker fails outdoors in winter."
              />
              <Select
                label="Mains frequency"
                value={wear.mainsHz}
                options={[
                  { value: 50, label: '50 Hz' },
                  { value: 60, label: '60 Hz' },
                ]}
                onChange={(v) => setWear({ mainsHz: v as 50 | 60 })}
                hint={`Artificial light flickers at twice this. At ${sensor.sampleRateHz} Hz it aliases to ${diag.flickerAliasHz.toFixed(1)} Hz.`}
              />
            </div>
          </Card>

          {/* -------------------------------------------------------- pipeline */}
          <Card
            title="Processing preset"
            note="A starting point for the pipeline. Every parameter stays editable stage by stage in the Pipeline view."
          >
            <div className="grid cols-2" style={{ gap: 'var(--s-3)' }}>
              {PIPELINE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="hw-card"
                  aria-pressed={activePreset?.id === p.id}
                  onClick={() => setPipeline(p.pipeline)}
                  style={{ padding: 'var(--s-3)' }}
                >
                  <h3 className="hw-name" style={{ fontSize: 13.5 }}>
                    {p.name}
                  </h3>
                  <p className="hw-tagline">{p.note}</p>
                </button>
              ))}
            </div>
          </Card>
        </div>

        {/* ------------------------------------------------------------ preview */}
        <div className="stack" style={{ position: 'sticky', top: 0 }}>
          <Card title="Front-end preview" note="Computed from the current configuration before any samples are generated.">
            <div className="stack" style={{ gap: 'var(--s-4)', marginTop: 'var(--s-2)' }}>
              <Stat
                label="Pulsatile SNR"
                value={<Num value={diag.acSnrDb} digits={1} />}
                unit="dB"
                tone={snrTone}
                sub={
                  diag.acSnrDb > 32
                    ? 'Comfortable margin — the pulse sits well above the noise floor.'
                    : diag.acSnrDb > 20
                      ? 'Workable, but filtering will be doing real work.'
                      : 'The pulse is close to the noise floor. Expect missed beats.'
                }
              />
              <Stat
                label="Perfusion index"
                value={<Num value={pi} digits={2} />}
                unit="% AC/DC"
                sub="Wrist reflectance normally falls between 0.2% and 2%, against 1–10% at a fingertip."
              />
              <Stat
                label="Converter headroom used"
                value={<Num value={headroomPct} digits={0} />}
                unit="%"
                tone={headroomPct > 88 ? 'critical' : headroomPct > 70 ? 'warning' : undefined}
                sub={`DC pedestal plus ${Math.round(diag.ambientCounts).toLocaleString('en-US')} counts of ambient, out of ${diag.fullScale.toLocaleString('en-US')} full scale.`}
              />
              <Stat
                label="Pulse amplitude"
                value={<Num value={diag.lsbPerPulse} digits={diag.lsbPerPulse < 10 ? 1 : 0} />}
                unit="LSB"
                tone={diag.lsbPerPulse < 4 ? 'critical' : diag.lsbPerPulse < 20 ? 'warning' : undefined}
                sub={
                  diag.lsbPerPulse < 4
                    ? 'Below a handful of codes the waveform is being quantised into steps.'
                    : 'Enough codes that quantisation is not the limiting factor.'
                }
              />
            </div>
          </Card>

          {diag.agcSaturated && (
            <Callout tone="critical" icon={<Icon name="alert" size={15} />}>
              <b>Gain loop saturated.</b> Too little light is coming back for the front end to reach its target
              operating point. Raise the LED current, tighten the band, or accept a smaller signal.
            </Callout>
          )}

          {headroomPct > 90 && (
            <Callout tone="warning" icon={<Icon name="alert" size={15} />}>
              <b>Close to the rail.</b> Ambient light plus the DC pedestal is nearly filling the converter. Any
              motion will clip, and clipped samples cannot be recovered by anything downstream.
            </Callout>
          )}

          {subject.fitzpatrick >= 5 && sensor.primaryChannel === 'green' && (
            <Callout tone="warning" icon={<Icon name="alert" size={15} />}>
              <b>Green on a deep phototype.</b> Melanin absorbs strongly at this wavelength, so the returned
              pulse is markedly smaller. Compare the infrared channel, or raise the drive current, and watch
              what happens to signal quality during movement.
            </Callout>
          )}

          {!started && (
            <Card>
              <div className="stack tight">
                <p className="card-note" style={{ margin: 0 }}>
                  Ready. The session opens at seated rest; change the activity at any time from the bar along
                  the bottom of the monitor.
                </p>
                <button
                  className="btn primary lg"
                  onClick={() => {
                    setView('monitor');
                    start();
                  }}
                >
                  <Icon name="play" size={14} />
                  Start session
                </button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
