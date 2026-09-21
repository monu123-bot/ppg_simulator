import { useMemo, useRef, useState } from 'react';

/**
 * Static SVG charts: trends, spectra, tachograms and Poincare plots.
 *
 * These are the charts you read rather than watch, so they live in SVG with a
 * crosshair and a tooltip. Everything scales off the same geometry helpers so
 * axes, gridlines and type sit identically across every view.
 */

export interface Series {
  points: Array<[number, number]>;
  color: string;
  label: string;
  fill?: boolean;
  dashed?: boolean;
  width?: number;
}

export interface Band {
  from: number;
  to: number;
  color: string;
  label?: string;
}

interface Axis {
  min: number;
  max: number;
  ticks: number[];
}

function niceAxis(min: number, max: number, count = 4): Axis {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const c = Number.isFinite(min) ? min : 0;
    return { min: c - 1, max: c + 1, ticks: [c - 1, c, c + 1] };
  }
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return { min: lo, max: hi, ticks };
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}

const PAD = { top: 12, right: 14, bottom: 26, left: 46 };

export function LineChart({
  series,
  height = 190,
  bands,
  markers,
  xLabel,
  yLabel,
  yMin,
  yMax,
  xFormat = fmt,
  yFormat = fmt,
  tooltipFormat,
  showLegend = true,
  area = false,
}: {
  series: Series[];
  height?: number;
  bands?: Band[];
  markers?: Array<{ x: number; color: string; label?: string; dashed?: boolean }>;
  xLabel?: string;
  yLabel?: string;
  yMin?: number;
  yMax?: number;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  tooltipFormat?: (x: number, values: Array<{ label: string; value: number; color: string }>) => string;
  showLegend?: boolean;
  area?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; px: number } | null>(null);
  const [w, setW] = useState(640);

  const measured = useRef<ResizeObserver | null>(null);
  const attach = (node: SVGSVGElement | null) => {
    (ref as { current: SVGSVGElement | null }).current = node;
    if (!node) {
      measured.current?.disconnect();
      measured.current = null;
      return;
    }
    if (!measured.current) {
      measured.current = new ResizeObserver(() => {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0) setW(rect.width);
      });
      measured.current.observe(node);
    }
  };

  const { xAxis, yAxis, hasData } = useMemo(() => {
    let xmin = Infinity;
    let xmax = -Infinity;
    let ymin = Infinity;
    let ymax = -Infinity;
    let n = 0;
    for (const s of series) {
      for (const [x, y] of s.points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        n++;
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
      }
    }
    if (yMin !== undefined) ymin = yMin;
    if (yMax !== undefined) ymax = yMax;
    return {
      xAxis: niceAxis(xmin, xmax, 5),
      yAxis: niceAxis(ymin, ymax, 4),
      hasData: n > 1,
    };
  }, [series, yMin, yMax]);

  const plotW = Math.max(10, w - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom);
  const sx = (x: number) => PAD.left + ((x - xAxis.min) / (xAxis.max - xAxis.min || 1)) * plotW;
  const sy = (y: number) => PAD.top + plotH - ((y - yAxis.min) / (yAxis.max - yAxis.min || 1)) * plotH;

  const hoverValues = useMemo(() => {
    if (hover === null) return [];
    return series
      .map((s) => {
        let best: [number, number] | null = null;
        let bestD = Infinity;
        for (const p of s.points) {
          const d = Math.abs(p[0] - hover.x);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        return best ? { label: s.label, value: best[1], color: s.color, x: best[0] } : null;
      })
      .filter((v): v is { label: string; value: number; color: string; x: number } => v !== null);
  }, [hover, series]);

  if (!hasData) {
    return (
      <div
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink-muted)',
          fontSize: 12,
          border: '1px dashed var(--border)',
          borderRadius: 'var(--r-sm)',
        }}
      >
        Not enough data yet
      </div>
    );
  }

  return (
    <div>
      <svg
        ref={attach}
        width="100%"
        height={height}
        role="img"
        aria-label={`${series.map((s) => s.label).join(', ')} chart`}
        style={{ display: 'block', touchAction: 'none' }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left;
          if (px < PAD.left || px > w - PAD.right) {
            setHover(null);
            return;
          }
          const x = xAxis.min + ((px - PAD.left) / plotW) * (xAxis.max - xAxis.min);
          setHover({ x, px });
        }}
        onPointerLeave={() => setHover(null)}
      >
        {bands?.map((b, i) => (
          <rect
            key={i}
            x={sx(b.from)}
            y={PAD.top}
            width={Math.max(0, sx(b.to) - sx(b.from))}
            height={plotH}
            fill={b.color}
            opacity={0.1}
          />
        ))}

        {yAxis.ticks.map((t) => (
          <g key={`y${t}`}>
            <line
              x1={PAD.left}
              x2={w - PAD.right}
              y1={sy(t)}
              y2={sy(t)}
              stroke="var(--grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 7}
              y={sy(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              fill="var(--ink-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {yFormat(t)}
            </text>
          </g>
        ))}

        {xAxis.ticks.map((t) => (
          <text
            key={`x${t}`}
            x={sx(t)}
            y={height - 8}
            textAnchor="middle"
            fontSize={10}
            fill="var(--ink-muted)"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {xFormat(t)}
          </text>
        ))}

        <line
          x1={PAD.left}
          x2={w - PAD.right}
          y1={PAD.top + plotH}
          y2={PAD.top + plotH}
          stroke="var(--axis)"
          strokeWidth={1}
        />

        {markers?.map((m, i) => (
          <line
            key={i}
            x1={sx(m.x)}
            x2={sx(m.x)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke={m.color}
            strokeWidth={1.5}
            strokeDasharray={m.dashed ? '3 3' : undefined}
            opacity={0.75}
          />
        ))}

        {series.map((s) => {
          const pts = s.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
          if (pts.length < 2) return null;
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p[0]).toFixed(2)},${sy(p[1]).toFixed(2)}`).join(' ');
          const baseY = sy(Math.max(yAxis.min, 0));
          return (
            <g key={s.label}>
              {(area || s.fill) && (
                <path
                  d={`${d} L${sx(pts[pts.length - 1][0]).toFixed(2)},${baseY} L${sx(pts[0][0]).toFixed(2)},${baseY} Z`}
                  fill={s.color}
                  opacity={0.13}
                />
              )}
              <path
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width ?? 2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? '4 4' : undefined}
              />
            </g>
          );
        })}

        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.px}
              x2={hover.px}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--ink-muted)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {hoverValues.map((v) => (
              <circle
                key={v.label}
                cx={sx(v.x)}
                cy={sy(v.value)}
                r={4}
                fill={v.color}
                stroke="var(--surface)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}

        {yLabel && (
          <text
            x={10}
            y={PAD.top - 2}
            fontSize={10}
            fill="var(--ink-muted)"
            textAnchor="start"
          >
            {yLabel}
          </text>
        )}
        {xLabel && (
          <text x={w - PAD.right} y={height - 8} fontSize={10} fill="var(--ink-muted)" textAnchor="end">
            {xLabel}
          </text>
        )}
      </svg>

      {hover && hoverValues.length > 0 && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--ink-secondary)',
            display: 'flex',
            gap: 'var(--s-3)',
            flexWrap: 'wrap',
            padding: '6px 0 0',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span style={{ color: 'var(--ink-muted)' }}>
            {tooltipFormat ? tooltipFormat(hover.x, hoverValues) : `${xFormat(hover.x)}${xLabel ? ` ${xLabel}` : ''}`}
          </span>
          {hoverValues.map((v) => (
            <span key={v.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <i
                style={{
                  width: 9,
                  height: 2.5,
                  borderRadius: 2,
                  background: v.color,
                  display: 'block',
                }}
              />
              {v.label} <b style={{ color: 'var(--ink)' }}>{yFormat(v.value)}</b>
            </span>
          ))}
        </div>
      )}

      {showLegend && series.length > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--s-4)',
            flexWrap: 'wrap',
            paddingTop: 8,
            fontSize: 11.5,
            color: 'var(--ink-secondary)',
          }}
        >
          {series.map((s) => (
            <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i
                style={{
                  width: 11,
                  height: 2.5,
                  borderRadius: 2,
                  background: s.color,
                  display: 'block',
                }}
              />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Poincare plot: NN(n) against NN(n+1), with the SD1/SD2 ellipse. */
export function PoincareChart({
  nn,
  sd1,
  sd2,
  height = 260,
}: {
  nn: number[];
  sd1: number;
  sd2: number;
  height?: number;
}) {
  const [w, setW] = useState(340);
  const ro = useRef<ResizeObserver | null>(null);
  const attach = (node: SVGSVGElement | null) => {
    if (!node) {
      ro.current?.disconnect();
      ro.current = null;
      return;
    }
    if (!ro.current) {
      ro.current = new ResizeObserver(() => {
        const r = node.getBoundingClientRect();
        if (r.width > 0) setW(r.width);
      });
      ro.current.observe(node);
    }
  };

  const pairs = useMemo(() => {
    const out: Array<[number, number]> = [];
    for (let i = 1; i < nn.length; i++) out.push([nn[i - 1], nn[i]]);
    return out;
  }, [nn]);

  if (pairs.length < 4) {
    return (
      <div
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink-muted)',
          fontSize: 12,
          border: '1px dashed var(--border)',
          borderRadius: 'var(--r-sm)',
        }}
      >
        Collecting intervals
      </div>
    );
  }

  let min = Infinity;
  let max = -Infinity;
  for (const [a, b] of pairs) {
    min = Math.min(min, a, b);
    max = Math.max(max, a, b);
  }
  const pad = (max - min) * 0.14 + 12;
  const axis = niceAxis(min - pad, max + pad, 4);
  // A square plot needs more room top and bottom than a line chart: both axes
  // carry tick labels, and the axis captions have to clear the corner ticks.
  const top = PAD.top + 14;
  const bottom = PAD.bottom + 12;
  const plotW = Math.max(10, w - PAD.left - PAD.right);
  const plotH = Math.max(10, height - top - bottom);
  const sx = (v: number) => PAD.left + ((v - axis.min) / (axis.max - axis.min || 1)) * plotW;
  const sy = (v: number) => top + plotH - ((v - axis.min) / (axis.max - axis.min || 1)) * plotH;

  const mean = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const scale = plotW / (axis.max - axis.min || 1);

  return (
    <svg ref={attach} width="100%" height={height} role="img" aria-label="Poincare plot of successive NN intervals">
      {axis.ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={w - PAD.right} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" />
          <line x1={sx(t)} x2={sx(t)} y1={top} y2={top + plotH} stroke="var(--grid)" />
          <text
            x={PAD.left - 7}
            y={sy(t)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={10}
            fill="var(--ink-muted)"
          >
            {t.toFixed(0)}
          </text>
          <text x={sx(t)} y={top + plotH + 14} textAnchor="middle" fontSize={10} fill="var(--ink-muted)">
            {t.toFixed(0)}
          </text>
        </g>
      ))}

      <line
        x1={sx(axis.min)}
        y1={sy(axis.min)}
        x2={sx(axis.max)}
        y2={sy(axis.max)}
        stroke="var(--axis)"
        strokeDasharray="4 4"
      />

      <ellipse
        cx={sx(mean)}
        cy={sy(mean)}
        rx={Math.max(2, sd2 * scale)}
        ry={Math.max(2, sd1 * scale)}
        transform={`rotate(-45 ${sx(mean)} ${sy(mean)})`}
        fill="var(--series-1)"
        fillOpacity={0.1}
        stroke="var(--series-1)"
        strokeWidth={1.5}
      />

      {pairs.map(([a, b], i) => (
        <circle key={i} cx={sx(a)} cy={sy(b)} r={2.4} fill="var(--series-1)" fillOpacity={0.62} />
      ))}

      <text
        x={PAD.left + plotW / 2}
        y={height - 4}
        textAnchor="middle"
        fontSize={10}
        fill="var(--ink-muted)"
      >
        NN(n) ms
      </text>
      <text x={PAD.left} y={12} fontSize={10} fill="var(--ink-muted)" textAnchor="start">
        NN(n+1) ms
      </text>
    </svg>
  );
}

/** A compact inline sparkline with no axes, for table cells and stat tiles. */
export function Sparkline({
  values,
  color = 'var(--series-1)',
  width = 96,
  height = 26,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <svg width={width} height={height} />;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-9) max = min + 1;
  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - 2) + 1;
      const y = height - 2 - ((v - min) / (max - min)) * (height - 4);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
