import type { FrameMessage } from '../worker/protocol';

/**
 * Waveform transport, deliberately outside React.
 *
 * Waveforms arrive twenty times a second and are drawn on canvas at the display
 * refresh rate. Routing that through component state would re-render the whole
 * tree for data that never appears as text. Instead the frames land in ring
 * buffers here, scopes read from them inside `requestAnimationFrame`, and React
 * only ever sees the once-a-second metric bundle.
 */

export const CHANNELS = [
  'raw',
  'dcBlocked',
  'bandpassed',
  'motionCancelled',
  'artifactEstimate',
  'smoothed',
  'respBaseline',
  'clean',
  'trueArtifact',
  'ax',
  'ay',
  'az',
  'accelMag',
] as const;

export type ChannelId = (typeof CHANNELS)[number];

export interface BeatMark {
  t: number;
  amp: number;
  rejected: boolean;
}

export interface WindowView {
  /** Sample values, oldest first. */
  values: Float32Array;
  /** Timestamps matching `values`. */
  times: Float32Array;
  count: number;
  tStart: number;
  tEnd: number;
}

/** Seconds of waveform history retained. */
const HISTORY_SEC = 60;

class Ring {
  buf: Float32Array;
  head = 0;
  size = 0;
  constructor(public capacity: number) {
    this.buf = new Float32Array(capacity);
  }
  resize(capacity: number): void {
    this.buf = new Float32Array(capacity);
    this.capacity = capacity;
    this.head = 0;
    this.size = 0;
  }
  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }
  clear(): void {
    this.buf.fill(0);
    this.head = 0;
    this.size = 0;
  }
}

class SignalBus {
  private rings = new Map<ChannelId, Ring>();
  private times: Ring;
  private beats: BeatMark[] = [];
  private truthBeats: number[] = [];
  private listeners = new Set<() => void>();

  sampleRate = 128;
  tEnd = 0;

  constructor() {
    const cap = Math.ceil(this.sampleRate * HISTORY_SEC);
    for (const c of CHANNELS) this.rings.set(c, new Ring(cap));
    this.times = new Ring(cap);
  }

  setSampleRate(fs: number): void {
    if (fs === this.sampleRate) return;
    this.sampleRate = fs;
    const cap = Math.ceil(fs * HISTORY_SEC);
    for (const c of CHANNELS) this.rings.get(c)!.resize(cap);
    this.times.resize(cap);
    this.beats = [];
    this.truthBeats = [];
    this.tEnd = 0;
  }

  reset(): void {
    for (const c of CHANNELS) this.rings.get(c)!.clear();
    this.times.clear();
    this.beats = [];
    this.truthBeats = [];
    this.tEnd = 0;
    this.emit();
  }

  ingest(frame: FrameMessage): void {
    const n = frame.n;
    for (let i = 0; i < n; i++) this.times.push(frame.t[i]);
    for (const c of CHANNELS) {
      const ring = this.rings.get(c)!;
      const src = frame[c];
      for (let i = 0; i < n; i++) ring.push(src[i]);
    }
    for (let i = 0; i < frame.beatTimes.length; i++) {
      this.beats.push({
        t: frame.beatTimes[i],
        amp: frame.beatAmps[i],
        rejected: frame.beatRejected[i] === 1,
      });
    }
    for (let i = 0; i < frame.truthBeatTimes.length; i++) {
      this.truthBeats.push(frame.truthBeatTimes[i]);
    }
    this.tEnd = frame.tEnd;

    const cutoff = this.tEnd - HISTORY_SEC;
    if (this.beats.length > 0 && this.beats[0].t < cutoff) {
      this.beats = this.beats.filter((b) => b.t >= cutoff);
    }
    if (this.truthBeats.length > 0 && this.truthBeats[0] < cutoff) {
      this.truthBeats = this.truthBeats.filter((t) => t >= cutoff);
    }
    this.emit();
  }

  /** Most recent `seconds` of a channel, oldest-first. */
  window(channel: ChannelId, seconds: number, out?: WindowView): WindowView {
    const ring = this.rings.get(channel)!;
    const want = Math.min(ring.size, Math.ceil(this.sampleRate * seconds));
    const view: WindowView =
      out && out.values.length >= want
        ? out
        : { values: new Float32Array(Math.max(1, want)), times: new Float32Array(Math.max(1, want)), count: 0, tStart: 0, tEnd: 0 };

    const start = (ring.head - want + ring.capacity * 2) % ring.capacity;
    for (let i = 0; i < want; i++) {
      const idx = (start + i) % ring.capacity;
      view.values[i] = ring.buf[idx];
      view.times[i] = this.times.buf[idx];
    }
    view.count = want;
    view.tStart = want ? view.times[0] : 0;
    view.tEnd = want ? view.times[want - 1] : 0;
    return view;
  }

  beatsSince(tStart: number): BeatMark[] {
    return this.beats.filter((b) => b.t >= tStart);
  }

  truthBeatsSince(tStart: number): number[] {
    return this.truthBeats.filter((t) => t >= tStart);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const signalBus = new SignalBus();
