# Wrist PPG Simulator

https://ppgsimulator.netlify.app/

A workbench for the whole wrist photoplethysmography signal chain: pick a real
optical front end, describe the person wearing it, put them through a realistic
activity, and watch every stage of the DSP pipeline try to recover a heart rate
from what comes back.

It exists to make the pipeline legible. Most PPG tooling shows you a waveform
and a number. This shows you the waveform, the number, every intermediate stage
that produced it, the ground truth it should have matched, and — when it fails —
which physical or algorithmic limit it ran into.

```bash
npm install
npm run dev      # http://localhost:5183
```

```bash
npm run build      # production bundle
npm test           # physiological validation suite
npm run typecheck
```

No backend, no network calls, no data leaves the browser. Generation and DSP run
in a Web Worker; the UI never blocks.

---

## What it models

**Physiology.** Beat times come from an integral pulse frequency modulation
accumulator driven by respiratory sinus arrhythmia, a Mayer wave near 0.1 Hz, a
very-low-frequency term and 1/f noise — the oscillatory structure that real
heart-rate variability has, rather than a mean rate plus white noise. Amplitudes
are set per activity and scaled for the subject: variability falls with age and
with heart rate, and rises with aerobic fitness. Each pulse is a sum of Gaussians
whose ejection time shortens with rate (Weissler) and whose reflected wave
arrives earlier in stiffer arteries and fades as rate climbs.

**Activities.** 21 states across sleep, rest, daily living, ambulation, exercise
and recovery. Each states a heart-rate band, a demand in percent of heart-rate
reserve, MET values, a cadence range with the wrist accelerations that go with
it, respiration, and an autonomic profile — all cited, and all listed in the
Reference view.

**Motion.** Gait deposits energy at the arm-swing rate, the step rate and their
harmonics, with a damped footstrike ring on top. The optical artefact is a
lag-filtered mixture of the three accelerometer axes *plus a squared term*. The
linear part is what an adaptive filter can remove; the squared part is what it
cannot, because no linear filter maps `a` to `a²`.

**Silicon.** Eight front-end profiles from research grade to legacy, plus a
noiseless reference. An automatic gain loop parks the DC level mid-converter;
on top sit electronic noise from the part's dynamic range, photon shot noise,
noise bandwidth scaling with sample rate, an ambient pedestal after front-end
rejection, a mains flicker tone that aliases if the sample rate is low enough,
quantisation, and hard clipping at the rail.

## The pipeline

Raw counts → DC block → cardiac band-pass → NLMS motion cancellation →
smoothing → systolic detection → interval screening → rate fusion → metrics.

Every stage shows its own output and its parameters are editable live. The
pipeline sees only the ADC counts and the accelerometer; ground truth is carried
alongside purely so the interface can score the result.

Recovered metrics: heart rate, time- and frequency-domain HRV to the 1996 Task
Force definitions, respiration by three-induction fusion, ratio-of-ratios SpO2,
a fused signal-quality index, and a composite autonomic-load score that
deliberately marks itself invalid during movement.

## Things worth trying

| Try this | What you should see |
|---|---|
| Walk at 108 spm | The step rate lands on the heart rate. Watch the rate-fusion stage refuse to let the detector be "corrected" onto a cadence harmonic. |
| Walk at 90, then at 126 | Brisk walking is *cleaner*. Its second cadence harmonic falls outside the band-pass; slow walking's does not. |
| Turn motion cancellation off, then jog | The reported rate migrates onto the cadence. |
| Switch MAX86141 → Si1143 | Same physiology, three times the motion coupling and 20 dB less SNR. |
| Set skin temperature to 26 °C | Vasoconstriction collapses the perfusion index and the pulse disappears into the noise. |
| Set Fitzpatrick VI on the green channel | Melanin absorbs at 525 nm; compare against infrared. |
| Set ectopic beats to 6/min | Watch what uncorrected intervals do to RMSSD, then tighten the interval screen. |
| Run a sprint | It fails, and says so. At 190 spm the cadence line sits 0.25 Hz from the pulse and nothing separates them. |

## Validation

`npm test` is not a unit-test suite — it checks that the whole chain lands where
the literature says it should. Resting heart rate inside the published band,
heart rate rising monotonically across walking/jogging/running, deep sleep below
resting, age-appropriate HRV that halves between 25 and 68, recovered heart rate
within published wrist-PPG tolerances across fourteen activities, respiration and
SpO2 recovered at rest, and no NaNs at the extremes.

## Layout

```
src/
  engine/      physiology and hardware — generates the signal
    activities.ts   activity catalogue with citations
    hardware.ts     front-end spec profiles
    cardiac.ts      beat generation and HRV structure
    pulse.ts        waveform morphology, perfusion, wavelength response
    motion.ts       accelerometer synthesis and optical coupling
    afe.ts          gain loop, noise, ambient, quantisation, clipping
  dsp/         the pipeline — recovers from the signal
    filters.ts fft.ts nlms.ts peaks.ts hrv.ts vitals.ts sqi.ts rate.ts
    pipeline.ts     stage orchestration and metric bundle
  worker/      real-time generation loop
  state/       store, signal ring buffers, defaults and presets
  views/       Setup · Monitor · Pipeline · Analysis · Reference
```

## Limits

It is a model, not a dataset. It reproduces documented behaviours and failure
modes; it is not a substitute for recording from real wrists, and nothing from it
should be reported as an empirical finding. The recovered variability is pulse
rate variability, not R-R variability. The hardware profiles are calibrated to
reproduce relative differences between parts, not to predict any specific part's
absolute performance — check the current datasheet before designing against them.
