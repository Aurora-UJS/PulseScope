
import React, { useState, useMemo, useCallback } from 'react';
import {
  Cpu,
  Video,
  AlertCircle,
  Eye,
  EyeOff
} from 'lucide-react';
import VideoFeed from './components/VideoFeed';
import SplittablePlotContainer from './components/SplittablePlotContainer';
import { DataProvider, useDataContext } from './components/DataContext';
import DataSeriesList from './components/DataSeriesList';
import Sidebar from './components/Sidebar';
import ConsoleLog from './components/ConsoleLog';
import StatusCard from './components/StatusCard';
import MapView from './components/MapView';
import ParamPanel from './components/ParamPanel';
import { LogEntry, LogLevel, ControlParams } from './type';

const AppContent: React.FC = () => {
  const { mapData, systemStatus, isConnected, timeSeriesData } = useDataContext();
  const [activeTab, setActiveTab] = useState<'dashboard' | 'navigation' | 'tuning'>('dashboard');
  const [showVideoFeed, setShowVideoFeed] = useState(false);
  const [isKillingProcess, setIsKillingProcess] = useState(false);
  const [params, setParams] = useState<ControlParams>({
    pid_p: 1.2, pid_i: 0.05, pid_d: 0.1, exposure: 5000, fire_enabled: true
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const addLog = useCallback((message: string, level: LogLevel = LogLevel.INFO) => {
    const newLog: LogEntry = {
      id: Math.random().toString(36).substr(2, 9),
      level, message, time: new Date().toLocaleTimeString()
    };
    setLogs(prev => [newLog, ...prev].slice(0, 50));
  }, []);

  const mergedStatus = useMemo(() => ({
    ...systemStatus,
    backendConnected: isConnected && systemStatus.backendConnected
  }), [isConnected, systemStatus]);

  const latestFps = useMemo(() => {
    const fpsData = timeSeriesData.get('fps');
    if (!fpsData || fpsData.length === 0) return '--';
    return fpsData[fpsData.length - 1].value.toFixed(0);
  }, [timeSeriesData]);

  const handleKillProcess = useCallback(async () => {
    if (isKillingProcess) return;

    setIsKillingProcess(true);
    try {
      const resp = await fetch('/api/process/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'vision_producer' })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        addLog(`KILL_PROCESS failed: ${errText || resp.statusText}`, LogLevel.ERROR);
        return;
      }

      const payload = await resp.json() as { killed_count?: number };
      addLog(`KILL_PROCESS finished, terminated ${payload.killed_count ?? 0} process(es)`, LogLevel.WARN);
    } catch (err) {
      addLog(`KILL_PROCESS request error: ${err instanceof Error ? err.message : String(err)}`, LogLevel.ERROR);
    } finally {
      setIsKillingProcess(false);
    }
  }, [addLog, isKillingProcess]);

  return (
    <div className="flex h-screen w-screen bg-slate-950 font-sans selection:bg-cyan-500/30">
      <Sidebar status={mergedStatus} activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="flex-1 flex flex-col overflow-hidden border-l border-slate-800/50">
        <header className="h-14 flex items-center justify-between px-6 bg-slate-900/50 backdrop-blur-md border-b border-slate-800/50">
          <div className="flex items-center gap-4">
            <h1 className="text-sm font-bold tracking-widest text-slate-200 uppercase">
              {activeTab === 'dashboard' && 'Combat Dashboard'}
              {activeTab === 'navigation' && 'ESDF Navigation Map'}
              {activeTab === 'tuning' && 'Dynamic Parameter Tuning'}
            </h1>
            <div className="h-4 w-[1px] bg-slate-700"></div>
            <div className={`flex items-center gap-2 text-xs ${mergedStatus.shmActive ? 'text-cyan-400' : 'text-amber-400'}`}>
              <div className={`w-2 h-2 rounded-full animate-pulse ${mergedStatus.shmActive ? 'bg-cyan-400' : 'bg-amber-400'}`}></div>
              {mergedStatus.shmActive ? 'SHM_LINK_ACTIVE' : 'SHM_LINK_DEGRADED'}
            </div>
          </div>
          <div className="flex gap-2">
            {activeTab === 'dashboard' && (
              <button
                onClick={() => setShowVideoFeed(!showVideoFeed)}
                className={`px-3 py-1 text-xs rounded border transition-all flex items-center gap-2 ${showVideoFeed
                  ? 'bg-cyan-900/20 hover:bg-cyan-900/40 text-cyan-400 border-cyan-900/50'
                  : 'bg-slate-800/50 hover:bg-slate-700/50 text-slate-400 border-slate-700/50'
                  }`}
              >
                {showVideoFeed ? <Eye size={14} /> : <EyeOff size={14} />}
                Video
              </button>
            )}
            <button
              onClick={handleKillProcess}
              disabled={isKillingProcess}
              className="px-3 py-1 bg-red-900/20 hover:bg-red-900/40 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 text-xs rounded border border-red-900/50 transition-all flex items-center gap-2"
            >
              <AlertCircle size={14} /> {isKillingProcess ? 'KILLING...' : 'KILL_PROCESS'}
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {activeTab === 'dashboard' && (
            <div className="h-full flex flex-col xl:flex-row gap-4">
              <div className="flex-1 min-w-0 flex flex-row gap-4">
                {showVideoFeed && (
                  <div className="shrink-0 w-64 h-64 bg-slate-900/40 border border-slate-800/50 rounded-lg overflow-hidden relative">
                    <VideoFeed />
                  </div>
                )}
                <div className="flex-1 min-w-[300px] bg-slate-900/40 border border-slate-800/50 rounded-lg p-2">
                  <SplittablePlotContainer />
                </div>
              </div>
              <div className="w-full xl:w-64 shrink-0 flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-2">
                  <StatusCard label="NUC" value={`${mergedStatus.nucCpuLoad.toFixed(0)}%`} subValue={`${mergedStatus.nucTemp.toFixed(0)}°C`} icon={<Cpu size={16} className="text-orange-400" />} />
                  <StatusCard label="Vision" value={latestFps} subValue="FPS" icon={<Video size={16} className="text-purple-400" />} />
                </div>
                <div className="flex-1 min-h-[200px] border border-slate-800/50 rounded-lg overflow-hidden">
                  <DataSeriesList />
                </div>
                <div className="h-40 bg-slate-900/80 border border-slate-800/50 rounded-lg flex flex-col overflow-hidden">
                  <div className="px-3 py-1.5 border-b border-slate-800/50 text-xs font-bold text-slate-400 uppercase tracking-wider">Console</div>
                  <ConsoleLog logs={logs} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'navigation' && (
            <div className="h-full flex flex-col gap-4">
              <div className="flex-1 bg-slate-900/40 border border-slate-800/50 rounded-lg overflow-hidden p-4">
                <MapView data={mapData} />
              </div>
            </div>
          )}

          {activeTab === 'tuning' && (
            <div className="max-w-4xl mx-auto py-8">
              <ParamPanel params={params} onUpdate={setParams} addLog={addLog} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <DataProvider>
      <AppContent />
    </DataProvider>
  );
};

export default App;
