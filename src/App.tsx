import { useStore } from './state/store';
import { ActivityDock, NavRail, TopBar } from './components/Shell';
import { SetupView } from './views/SetupView';
import { MonitorView } from './views/MonitorView';
import { PipelineView } from './views/PipelineView';
import { AnalysisView } from './views/AnalysisView';
import { ReferenceView } from './views/ReferenceView';

export default function App() {
  const view = useStore((s) => s.view);
  const started = useStore((s) => s.started);
  const showDock = started && view !== 'setup' && view !== 'reference';

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <NavRail />
        <main className="main">
          <div className="main-inner">
            {view === 'setup' && <SetupView />}
            {view === 'monitor' && <MonitorView />}
            {view === 'pipeline' && <PipelineView />}
            {view === 'analysis' && <AnalysisView />}
            {view === 'reference' && <ReferenceView />}
          </div>
          {showDock && <ActivityDock />}
        </main>
      </div>
    </div>
  );
}
