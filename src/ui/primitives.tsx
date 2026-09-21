import type { CSSProperties, ReactNode } from 'react';

/** Small, unopinionated building blocks shared by every view. */

export function Card({
  title,
  note,
  actions,
  children,
  flush,
  style,
  className,
}: {
  title?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <section className={`card${flush ? ' flush' : ''}${className ? ` ${className}` : ''}`} style={style}>
      {(title || actions) && (
        <header className="card-head" style={flush ? { padding: 'var(--s-4) var(--s-4) 0' } : undefined}>
          <div style={{ minWidth: 0 }}>
            {title && <h2 className="card-title">{title}</h2>}
            {note && <p className="card-note">{note}</p>}
          </div>
          {actions && <div className="row" style={{ flexWrap: 'nowrap' }}>{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="section-head">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  tone,
  size = 'md',
  badge,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: 'good' | 'warning' | 'serious' | 'critical';
  size?: 'md' | 'sm';
  badge?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        {badge}
      </div>
      <div
        className={`stat-value${size === 'sm' ? ' sm' : ''}`}
        style={tone ? { color: `var(--${tone})` } : undefined}
      >
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** Renders a number, or a clearly-marked dash when the value is unavailable. */
export function Num({
  value,
  digits = 0,
  fallback = '—',
}: {
  value: number | null | undefined;
  digits?: number;
  fallback?: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="na">{fallback}</span>;
  }
  return <>{value.toFixed(digits)}</>;
}

export function Chip({
  children,
  tone,
  dot,
}: {
  children: ReactNode;
  tone?: 'good' | 'warning' | 'serious' | 'critical' | 'accent';
  dot?: string;
}) {
  return (
    <span className={`chip${tone ? ` ${tone}` : ''}`}>
      {dot && <i className="dot" style={{ background: dot }} />}
      {children}
    </span>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  hint,
  disabled,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = `sl-${String(label).replace(/\W+/g, '-')}`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        <span>{label}</span>
        <span className="field-value">{format ? format(value) : value}</span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="field">
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch-track" />
        <span style={{ fontSize: 12.5, fontWeight: 540 }}>{label}</span>
      </label>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: ReactNode;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  hint?: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
      </div>
      <select
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Meter({ value, max = 100, tone }: { value: number; max?: number; tone?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="meter">
      <i style={{ width: `${pct}%`, background: tone ?? 'var(--accent)' }} />
    </div>
  );
}

export function Callout({
  children,
  tone,
  icon,
}: {
  children: ReactNode;
  tone?: 'warning' | 'critical' | 'accent';
  icon?: ReactNode;
}) {
  return (
    <div className={`callout${tone ? ` ${tone}` : ''}`} role={tone === 'critical' ? 'alert' : undefined}>
      {icon ?? <Icon name="info" size={15} />}
      <div>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ icons */

const PATHS: Record<string, string> = {
  pulse: 'M2 12h3.5l2-7 3.5 14 3-10 2 3H21',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 14l9 5 9-5M3 11l9 5 9-5',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5ZM19 19H6',
  play: 'M6 4l13 8-13 8V4Z',
  pause: 'M8 4v16M16 4v16',
  reset: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  sun: 'M12 5V3M12 21v-2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z',
  info: 'M12 16v-5M12 8h0M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  alert: 'M12 9v4M12 17h0M10.3 3.9 2.4 17a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  check: 'M4 12.5 9 17.5 20 6.5',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  wave: 'M2 12c2-6 4 6 6 0s4 6 6 0 4 6 6 0',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  gauge: 'M12 14 16 9M21 16a9 9 0 1 0-18 0',
  chevron: 'm9 6 6 6-6 6',
};

export function Icon({
  name,
  size = 16,
  color = 'currentColor',
  strokeWidth = 1.7,
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const d = PATHS[name] ?? PATHS.info;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
