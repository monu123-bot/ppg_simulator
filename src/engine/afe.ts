import type { HardwareProfile, SubjectProfile, WearConfig, Wavelength } from './types';
import { DriftSource, clamp, makeGaussian, makeRng } from './rng';
import { wavelengthGain } from './pulse';

/**
 * Optical front-end and ADC model.
 *
 * Turns a normalised physiological signal into the integer counts a real part
 * would report, accounting for everything between the artery and the register:
 *
 *   - LED drive current and photodiode area setting the DC operating point
 *   - melanin absorption at the chosen wavelength, which is strongest in green
 *   - electronic noise from the stated dynamic range, plus a photon shot-noise
 *     term that improves as you drive the LED harder
 *   - noise bandwidth scaling with sample rate
 *   - ambient light: a DC pedestal that consumes headroom on parts without
 *     hardware offset cancellation, and a mains-flicker tone at twice the line
 *     frequency that *aliases* if the sample rate is low enough
 *   - quantisation to the part's resolution
 *   - hard clipping when the operating point runs out of headroom
 */

export interface AfeOutput {
  /** Raw ADC counts as the part would report them. */
  counts: number;
  /** DC operating point in counts, for the headroom gauge. */
  dcCounts: number;
  /** Pulsatile amplitude in counts, before noise. */
  acCounts: number;
  /** Total noise in counts rms at this operating point. */
  noiseCounts: number;
  /** True if this sample hit the rail. */
  clipped: boolean;
}

export interface AfeDiagnostics {
  fullScale: number;
  /** DC as a fraction of full scale. */
  headroomUsed: number;
  /** Ambient pedestal in counts after front-end rejection. */
  ambientCounts: number;
  /** Frequency the mains flicker actually appears at after sampling, Hz. */
  flickerAliasHz: number;
  /** Electrical SNR of the pulsatile component, dB. */
  acSnrDb: number;
  /** Pulsatile amplitude in counts — below ~4 LSB quantisation becomes visible. */
  lsbPerPulse: number;
  /** True when the gain loop has run out of range and DC is below target. */
  agcSaturated: boolean;
}

export class AnalogFrontEnd {
  private readonly gauss: () => number;
  private readonly ambientDrift: DriftSource;
  private flickerPhase = 0;
  private t = 0;

  readonly fullScale: number;
  private readonly noiseElectronic: number;

  constructor(
    private readonly hw: HardwareProfile,
    private readonly subject: SubjectProfile,
    private readonly wear: WearConfig,
    private readonly sampleRate: number,
    private readonly ledCurrentMa: number,
    seed: number,
  ) {
    const rng = makeRng(seed ^ 0x27d4eb2f);
    this.gauss = makeGaussian(rng);
    this.ambientDrift = new DriftSource(this.gauss, 0.0015, 1);
    this.fullScale = Math.pow(2, hw.adcBits) - 1;

    // Electronic noise implied by the stated dynamic range, then scaled for the
    // noise bandwidth this sample rate actually integrates over.
    const base = this.fullScale / Math.pow(10, hw.dynamicRangeDb / 20);
    this.noiseElectronic = base * Math.sqrt(sampleRate / 100);
  }

  /**
   * Light actually returned to the photodiode, relative to a nominal design
   * point of 1.0, before any gain is applied.
   */
  private lightReturn(wavelength: Wavelength): number {
    const { dcGain, melaninLoss } = wavelengthGain(wavelength, this.subject.fitzpatrick);
    const currentRatio = this.ledCurrentMa / Math.max(1, this.hw.defaultLedCurrentMa);
    const areaFactor = Math.sqrt(this.hw.photodiodeAreaMm2 / 2.4);
    const contact = clamp(0.55 + 0.6 * clamp(this.wear.bandTightness, 0, 1), 0.5, 1.15);
    return Math.pow(currentRatio, 0.75) * dcGain * (0.55 + 0.45 * melaninLoss) * areaFactor * contact;
  }

  /**
   * DC operating point as a fraction of full scale, after automatic gain
   * control.
   *
   * Every shipping PPG front end runs an AGC loop that trims LED current and
   * transimpedance gain to park the DC level in the middle of the converter's
   * range. Modelling a fixed operating point instead would make the choice of
   * part look like an arbitrary difference in how hard each one is driven,
   * when the real difference is the noise floor underneath that operating
   * point. With AGC in the loop, a weaker optical return costs SNR only once
   * the gain range runs out — which is exactly how it behaves in hardware, and
   * why a deep skin phototype or a loose band degrades gracefully and then
   * suddenly.
   */
  private dcFraction(wavelength: Wavelength): number {
    const light = this.lightReturn(wavelength);
    // Ambient eats headroom first; the loop targets what is left.
    const ambientFrac = this.ambientCounts() / this.fullScale;
    const target = clamp(0.92 - ambientFrac, 0.06, 0.92) * 0.5;
    const maxGain = this.hw.hasDcOffsetCancellation ? 14 : 4;
    const gain = clamp(target / Math.max(1e-4, light), 0.06, maxGain);
    return clamp(light * gain, 0.01, 0.94);
  }

  /** True when the AGC has run out of gain and the operating point is short. */
  agcSaturated(wavelength: Wavelength): boolean {
    const light = this.lightReturn(wavelength);
    const ambientFrac = this.ambientCounts() / this.fullScale;
    const target = clamp(0.92 - ambientFrac, 0.06, 0.92) * 0.5;
    const maxGain = this.hw.hasDcOffsetCancellation ? 14 : 4;
    return target / Math.max(1e-4, light) > maxGain;
  }

  /** Ambient pedestal in counts after the front end's rejection. */
  private ambientCounts(): number {
    const raw = this.wear.ambientLight * this.fullScale * 1.8;
    const rejected = raw / Math.pow(10, this.hw.ambientRejectionDb / 20);
    // Parts without hardware offset cancellation pass much more of it through.
    return this.hw.hasDcOffsetCancellation ? rejected : rejected + raw * 0.06;
  }

  /** Where the 2 x mains flicker tone lands after sampling. */
  flickerAliasHz(): number {
    const f = this.wear.mainsHz * 2;
    const fs = this.sampleRate;
    const folded = Math.abs(f - fs * Math.round(f / fs));
    return folded;
  }

  diagnostics(wavelength: Wavelength, perfusionIndexPct: number): AfeDiagnostics {
    const dc = this.dcFraction(wavelength) * this.fullScale;
    const ambient = this.ambientCounts();
    const { acGain } = wavelengthGain(wavelength, this.subject.fitzpatrick);
    const ac = dc * (perfusionIndexPct / 100) * acGain;
    const shot = 0.03 * Math.sqrt(Math.max(1, dc + ambient));
    const noise = Math.hypot(this.noiseElectronic, shot);
    return {
      fullScale: this.fullScale,
      headroomUsed: clamp((dc + ambient) / this.fullScale, 0, 2),
      ambientCounts: ambient,
      flickerAliasHz: this.flickerAliasHz(),
      acSnrDb: 20 * Math.log10(Math.max(1e-6, ac / Math.max(1e-6, noise))),
      lsbPerPulse: ac,
      agcSaturated: this.agcSaturated(wavelength),
    };
  }

  /**
   * Convert one sample of normalised physiology into ADC counts.
   *
   * `acNorm` is the cardiac pulse (1.0 = one full pulse), `baselineNorm` the
   * slow respiratory/vasomotor component and `artifactNorm` the motion artefact,
   * all in the same normalised units so their relative sizes are meaningful.
   */
  sample(
    dt: number,
    wavelength: Wavelength,
    perfusionIndexPct: number,
    acNorm: number,
    baselineNorm: number,
    artifactNorm: number,
    /**
     * Overrides the wavelength's default AC gain. The red and IR channels pass
     * 1 here because their AC/DC ratios are dictated by the oxygen saturation
     * being simulated, not by a generic per-wavelength factor — applying both
     * would corrupt the ratio of ratios a downstream oximeter computes.
     */
    acGainOverride?: number,
  ): AfeOutput {
    this.t += dt;
    const acGain =
      acGainOverride ?? wavelengthGain(wavelength, this.subject.fitzpatrick).acGain;

    const dcCounts = this.dcFraction(wavelength) * this.fullScale;
    const acCounts = dcCounts * (perfusionIndexPct / 100) * acGain;

    // Ambient: slow drift plus mains flicker, both after front-end rejection.
    const ambientBase = this.ambientCounts();
    const ambient = ambientBase * (1 + 0.25 * this.ambientDrift.next());
    this.flickerPhase += 2 * Math.PI * this.wear.mainsHz * 2 * dt;
    const flicker = ambient * 0.35 * Math.sin(this.flickerPhase);

    // Note the sign: more blood in the tissue absorbs more light, so the
    // photodiode current *falls* at the systolic peak. Most wearables invert
    // this in firmware; the simulator does too, so the trace reads the way
    // everyone draws it.
    const signal = acCounts * (acNorm + baselineNorm + artifactNorm);

    const shot = 0.03 * Math.sqrt(Math.max(1, dcCounts + ambient));
    const noiseCounts = Math.hypot(this.noiseElectronic, shot);
    const noise = noiseCounts * this.gauss();

    let value = dcCounts + ambient + flicker + signal + noise;

    let clipped = false;
    if (value >= this.fullScale) {
      value = this.fullScale;
      clipped = true;
    } else if (value <= 0) {
      value = 0;
      clipped = true;
    }

    // Quantise to the part's resolution.
    const counts = Math.round(value);

    return { counts, dcCounts, acCounts, noiseCounts, clipped };
  }
}
