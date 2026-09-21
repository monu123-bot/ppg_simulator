import { useEffect, useRef } from 'react';
import { signalBus, type ChannelId, type WindowView } from '../state/signalBus';

/**
 * Real-time waveform scope.
 *
 * Draws on canvas inside `requestAnimationFrame` and reads straight from the
 * signal ring buffers, so nothing about a 60 fps trace passes through React.
 *
 * Two details matter more than they look:
 *
 *   - Columns are decimated by min/max rather than by sampling. At 128 Hz over
 *     a 10-second window there are more samples than pixels; picking one per
 *     column would alias the systolic peak away on some frames and not others,
 *     making the trace flicker. Drawing the vertical extent of each column
 *     keeps every peak visible.
 *   - Auto-scaling is critically damped rather than instantaneous. A scope that
 *     re-fits its axis every frame turns a changing amplitude into a stationary
 *     trace, which hides exactly the thing worth seeing.
 */

export interface Trace {
  channel: ChannelId;
  /** CSS custom property or colour literal. */
  color: string;
  label: string;
  width?: number;
  /** Draw as a filled area down to the baseline. */
  fill?: boolean;
  dashed?: boolean;
}

export interface ScopeProps {
  traces: Trace[];
  seconds: number;
  height?: number;
  /** Show detected beats as markers on the first trace. */
  showBeats?: boolean;
  /** Show ground-truth beat times as faint ticks, for comparison. */
  showTruthBeats?: boolean;
  /** Force the vertical axis to include zero. */
  includeZero?: boolean;
  /** Fixed vertical range; disables auto-scaling. */
  range?: [number, number];
  /** Y-axis unit label drawn bottom-right. */
  unit?: string;
  /** Hide the legend when the card header already names the series. */
  hideLegend?: boolean;
  gridRows?: number;
}

function cssVar(el: HTMLElement, name: string): string {
  if (!name.startsWith('--')) return name;
  return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
}

export function Scope({
  traces,
  seconds,
  height = 150,
  showBeats,
  showTruthBeats,
  includeZero,
  range,
  unit,
  hideLegend,
  gridRows = 4,
}: ScopeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewsRef = useRef<Map<ChannelId, WindowView>>(new Map());
  const scaleRef = useRef<{ lo: number; hi: number } | null>(null);

  /**
   * Current props, held in a ref.
   *
   * The draw loop must not be torn down and rebuilt when props change. `traces`
   * is a fresh array on every render, and this component's parent re-renders
   * twenty times a second, so making the render loop depend on it means the
   * effect is destroyed and recreated at that rate — each rebuild reassigns
   * `canvas.width`, which blanks the canvas, and two loops racing over one
   * animation-frame handle will cancel each other outright. Reading the live
   * props from a ref keeps a single loop alive for the lifetime of the
   * component.
   */
  const propsRef = useRef({ traces, seconds, showBeats, showTruthBeats, includeZero, range, gridRows });
  propsRef.current = { traces, seconds, showBeats, showTruthBeats, includeZero, range, gridRows };

  const traceKey = traces.map((t) => `${t.channel}:${t.color}`).join(',');
  useEffect(() => {
    // A different set of traces is a different vertical scale; start it fresh
    // rather than easing from the previous one.
    scaleRef.current = null;
  }, [traceKey, seconds]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      dpr = Math.min(2.5, window.devicePixelRatio || 1);
      width = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (width < 2 || h < 2) return;

      const { traces, seconds, showBeats, showTruthBeats, includeZero, range, gridRows } =
        propsRef.current;

      const gridColor = cssVar(host, '--grid');
      const axisColor = cssVar(host, '--axis');
      const mutedColor = cssVar(host, '--ink-muted');

      ctx.clearRect(0, 0, width, h);

      // --- collect windows
      let lo = Infinity;
      let hi = -Infinity;
      const windows: Array<{ trace: Trace; view: WindowView }> = [];
      for (const trace of traces) {
        const prev = viewsRef.current.get(trace.channel);
        const view = signalBus.window(trace.channel, seconds, prev);
        viewsRef.current.set(trace.channel, view);
        windows.push({ trace, view });
        for (let i = 0; i < view.count; i++) {
          const v = view.values[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }

      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        lo = -1;
        hi = 1;
      }
      if (includeZero) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      if (hi - lo < 1e-9) {
        hi = lo + 1;
      }

      if (range) {
        [lo, hi] = range;
      } else {
        // Pad, then ease toward the new extents so the axis never snaps.
        const pad = (hi - lo) * 0.12;
        const targetLo = lo - pad;
        const targetHi = hi + pad;
        const cur = scaleRef.current;
        if (!cur) {
          scaleRef.current = { lo: targetLo, hi: targetHi };
        } else {
          // Expand quickly so a transient is never clipped; contract slowly so
          // the trace does not breathe.
          const kExpand = 0.35;
          const kContract = 0.035;
          cur.lo += (targetLo - cur.lo) * (targetLo < cur.lo ? kExpand : kContract);
          cur.hi += (targetHi - cur.hi) * (targetHi > cur.hi ? kExpand : kContract);
        }
        lo = scaleRef.current!.lo;
        hi = scaleRef.current!.hi;
      }

      const span = hi - lo || 1;
      const yOf = (v: number) => h - ((v - lo) / span) * h;

      // --- grid
      ctx.save();
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let r = 1; r < gridRows; r++) {
        const y = Math.round((r / gridRows) * h) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      const cols = Math.max(2, Math.round(seconds / (seconds > 20 ? 5 : 2)));
      for (let c = 1; c < cols; c++) {
        const x = Math.round((c / cols) * width) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      ctx.stroke();
      ctx.restore();

      // --- zero line
      if (lo < 0 && hi > 0) {
        ctx.save();
        ctx.strokeStyle = axisColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const y = Math.round(yOf(0)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.restore();
      }

      const tEnd = signalBus.tEnd;
      const tStart = tEnd - seconds;
      const xOf = (t: number) => ((t - tStart) / seconds) * width;

      // --- truth beat ticks, drawn under the traces
      if (showTruthBeats) {
        const truth = signalBus.truthBeatsSince(tStart);
        ctx.save();
        ctx.strokeStyle = mutedColor;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const t of truth) {
          const x = Math.round(xOf(t)) + 0.5;
          ctx.moveTo(x, h - 9);
          ctx.lineTo(x, h);
        }
        ctx.stroke();
        ctx.restore();
      }

      // --- traces
      for (const { trace, view } of windows) {
        if (view.count < 2) continue;
        const color = cssVar(host, trace.color);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = trace.width ?? 1.6;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        if (trace.dashed) ctx.setLineDash([4, 4]);

        const perColumn = view.count / width;
        ctx.beginPath();
        if (perColumn > 2) {
          // Decimate by min/max so no peak is lost between pixels — but keep it
          // one continuous path. Stroking each column as its own segment leaves
          // the trace looking stippled wherever the waveform is steep enough
          // that successive columns do not overlap vertically.
          let open = false;
          for (let px = 0; px < width; px++) {
            const i0 = Math.floor(px * perColumn);
            const i1 = Math.min(view.count, Math.floor((px + 1) * perColumn));
            if (i1 <= i0) continue;
            let mn = Infinity;
            let mx = -Infinity;
            for (let i = i0; i < i1; i++) {
              const v = view.values[i];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
            const x = px + 0.5;
            if (!open) {
              ctx.moveTo(x, yOf(mn));
              open = true;
            } else {
              ctx.lineTo(x, yOf(mn));
            }
            ctx.lineTo(x, yOf(mx));
          }
        } else {
          for (let i = 0; i < view.count; i++) {
            const x = xOf(view.times[i]);
            const y = yOf(view.values[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        }
        ctx.stroke();

        if (trace.fill) {
          ctx.globalAlpha = 0.14;
          ctx.fillStyle = color;
          ctx.lineTo(xOf(view.times[view.count - 1]), yOf(Math.max(lo, 0)));
          ctx.lineTo(xOf(view.times[0]), yOf(Math.max(lo, 0)));
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }

      // --- detected beats
      if (showBeats && windows.length) {
        const beats = signalBus.beatsSince(tStart);
        ctx.save();
        for (const b of beats) {
          const x = xOf(b.t);
          if (x < 0 || x > width) continue;
          const y = yOf(b.amp);
          ctx.beginPath();
          if (b.rejected) {
            ctx.strokeStyle = cssVar(host, '--critical');
            ctx.lineWidth = 1.4;
            ctx.moveTo(x - 3.5, y - 3.5);
            ctx.lineTo(x + 3.5, y + 3.5);
            ctx.moveTo(x + 3.5, y - 3.5);
            ctx.lineTo(x - 3.5, y + 3.5);
            ctx.stroke();
          } else {
            ctx.fillStyle = cssVar(host, '--series-4');
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
            // 2px surface ring keeps overlapping markers separable.
            ctx.strokeStyle = cssVar(host, '--surface-sunken');
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // --- time axis labels
      ctx.save();
      ctx.fillStyle = mutedColor;
      ctx.font = '10px var(--font), system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`-${seconds}s`, 4, h - 2);
      ctx.restore();
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="scope" ref={hostRef} style={{ height }}>
      <canvas ref={canvasRef} />
      {!hideLegend && traces.length > 0 && (
        <div className="scope-legend">
          {traces.map((t) => (
            <span key={t.channel}>
              <i style={{ background: t.color.startsWith('--') ? `var(${t.color})` : t.color }} />
              {t.label}
            </span>
          ))}
        </div>
      )}
      {unit && <div className="scope-unit">{unit}</div>}
    </div>
  );
}
