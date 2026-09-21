import { useStore, type ViewId } from '../state/store';
import { ACTIVITIES, ACTIVITY_BY_ID, CATEGORY_LABEL, CATEGORY_ORDER, getActivity } from '../engine/activities';
import { Icon, Num, Segmented, Slider, formatClock } from '../ui/primitives';

const NAV: Array<{ id: ViewId; label: string; hint: string; icon: string }> = [
  { id: 'setup', label: 'Setup', hint: 'Sensor, subject, wear', icon: 'sliders' },
  { id: 'monitor', label: 'Live monitor', hint: 'Waveforms and vitals', icon: 'pulse' },
  { id: 'pipeline', label: 'Pipeline', hint: 'Every stage, inspectable', icon: 'layers' },
  { id: 'analysis', label: 'Analysis', hint: 'HRV, spectra, session', icon: 'chart' },
  { id: 'reference', label: 'Reference', hint: 'Sources and bands', icon: 'book' },
];

export function TopBar() {
  const { running, started, elapsed, speed, metrics, theme } = useStore();
  const start = useStore((s) => s.start);
  const pause = useStore((s) => s.pause);
  const reset = useStore((s) => s.reset);
  const setSpeed = useStore((s) => s.setSpeed);
  const toggleTheme = useStore((s) => s.toggleTheme);

  const hr = metrics?.heartRate ?? 0;
  const reliable = metrics?.rateReliable ?? false;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="pulse" size={15} color="#fff" strokeWidth={2.1} />
        </span>
        Wrist PPG Simulator
        <span className="brand-sub">signal chain workbench</span>
      </div>

      <div className="topbar-spacer" />

      <div className={`live-hr${!reliable && started ? ' is-stale' : ''}`} title={reliable ? 'Heart rate' : 'Signal quality too low — value is being held'}>
        <b>{hr > 0 ? Math.round(hr) : '--'}</b>
        <span>bpm</span>
      </div>

      <div className="session-clock" aria-label="Simulated session time">
        {formatClock(elapsed)}
      </div>

      <div className="topbar-group">
        <Segmented
          label="Simulation speed"
          value={speed}
          onChange={setSpeed}
          options={[
            { value: 1, label: '1x', title: 'Real time' },
            { value: 5, label: '5x', title: 'Five times real time' },
            { value: 20, label: '20x', title: 'Twenty times real time — for accumulating HRV windows' },
          ]}
        />
        <button
          className="btn primary"
          onClick={running ? pause : start}
          aria-label={running ? 'Pause simulation' : 'Start simulation'}
        >
          <Icon name={running ? 'pause' : 'play'} size={14} />
          {running ? 'Pause' : started ? 'Resume' : 'Start'}
        </button>
        <button className="btn icon" onClick={reset} title="Reset session" aria-label="Reset session">
          <Icon name="reset" size={15} />
        </button>
        <button
          className="btn icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle colour theme"
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
        </button>
      </div>
    </header>
  );
}

export function NavRail() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const metrics = useStore((s) => s.metrics);

  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-label">Workspace</div>
      {NAV.map((n) => (
        <button
          key={n.id}
          className="rail-item"
          aria-current={view === n.id ? 'page' : undefined}
          onClick={() => setView(n.id)}
        >
          <Icon name={n.icon} size={17} />
          <span>
            {n.label}
            <small>{n.hint}</small>
          </span>
        </button>
      ))}

      <div className="rail-foot">
        {metrics ? (
          <>
            <div style={{ marginBottom: 6 }}>
              Signal quality{' '}
              <b style={{ color: 'var(--ink)' }}>
                <Num value={metrics.quality.score} /> / 100
              </b>
            </div>
            <div>{metrics.quality.limitingFactor}</div>
          </>
        ) : (
          <div>
            Configure a sensor and a scenario, then press Start. Every number on screen is computed from
            the synthesised optical signal, never read back from the model.
          </div>
        )}
      </div>
    </nav>
  );
}

export function ActivityDock() {
  const activity = useStore((s) => s.activity);
  const setActivity = useStore((s) => s.setActivity);
  const setCadence = useStore((s) => s.setCadence);
  const setEffort = useStore((s) => s.setEffort);

  const profile = getActivity(activity.activityId);
  const cadence = profile.cadence;

  return (
    <div className="dock">
      <div className="dock-activities" role="group" aria-label="Activity">
        {CATEGORY_ORDER.map((cat) => {
          const items = ACTIVITIES.filter((a) => a.category === cat);
          if (!items.length) return null;
          return (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <span
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--ink-muted)',
                  whiteSpace: 'nowrap',
                  paddingRight: 2,
                }}
              >
                {CATEGORY_LABEL[cat]}
              </span>
              {items.map((a) => (
                <button
                  key={a.id}
                  className="act-btn"
                  aria-pressed={a.id === activity.activityId}
                  onClick={() => setActivity(a.id)}
                  title={a.summary}
                >
                  {a.name}
                </button>
              ))}
              <span className="dock-divider" style={{ margin: '0 4px' }} />
            </div>
          );
        })}
      </div>

      <span className="dock-divider" />

      <div className="dock-cadence">
        {cadence ? (
          <Slider
            label={cadence.unit === 'spm' ? 'Cadence' : 'Pedal cadence'}
            value={activity.cadence}
            min={cadence.min}
            max={cadence.max}
            step={1}
            onChange={setCadence}
            format={(v) => `${v} ${cadence.unit}`}
          />
        ) : (
          <Slider
            label="Effort within band"
            value={activity.effort}
            min={0}
            max={1}
            step={0.01}
            onChange={setEffort}
            format={(v) =>
              `${Math.round(v * 100)}% · ${Math.round(
                ACTIVITY_BY_ID[activity.activityId].hrRangeBpm[0] +
                  v *
                    (ACTIVITY_BY_ID[activity.activityId].hrRangeBpm[1] -
                      ACTIVITY_BY_ID[activity.activityId].hrRangeBpm[0]),
              )} bpm band`
            }
          />
        )}
      </div>
    </div>
  );
}

export { NAV };
