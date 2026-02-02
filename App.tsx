
import React, { useState, useEffect, useCallback } from 'react';
import { 
  Activity, 
  Terminal, 
  Cpu, 
  Video, 
  Settings, 
  AlertCircle,
  Database,
  Link,
  Navigation,
  SlidersHorizontal,
  ChevronRight
} from 'lucide-react';
import VideoFeed from './components/VideoFeed';
import TelemetryChart from './components/TelemetryChart';
import Sidebar from './components/Sidebar';
import ConsoleLog from './components/ConsoleLog';
import StatusCard from './components/StatusCard';
import MapView from './components/MapView';
import ParamPanel from './components/ParamPanel';
import { TelemetryPoint, SystemStatus, LogEntry, LogLevel, ControlParams, MapData } from './type';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'navigation' | 'tuning'>('dashboard');
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [mapData, setMapData] = useState<MapData>({ grid: Array(10000).fill(0), width: 100, height: 100 });
  const [params, setParams] = useState<ControlParams>({
    pid_p: 1.2, pid_i: 0.05, pid_d: 0.1, exposure: 5000, fire_enabled: true
  });
  const [status, setStatus] = useState<SystemStatus>({
    backendConnected: true,
    shmActive: true,
    serialPort: '/dev/ttyACM0',
    nucCpuLoad: 12,
    nucTemp: 45
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Simulation of SHM data flow (Telemetry + Map)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      
      // Update Telemetry
      const newPoint: TelemetryPoint = {
        timestamp: now,
        ekf_x: Math.sin(now / 500) * 10 + 20 + Math.random(),
        ekf_y: Math.cos(now / 700) * 15 + 30 + Math.random(),
        target_dist: 2.5 + Math.random() * 0.5,
        fps: 180 + Math.floor(Math.random() * 40),
        latency: 0.5 + Math.random() * 0.2
      };
      setTelemetry(prev => [...prev.slice(-49), newPoint]);

      // Simulate ESDF Map Data (Dynamic obstacles)
      const newGrid = mapData.grid.map((_, i) => {
        const x = i % 100;
        const y = Math.floor(i / 100);
        const d1 = Math.sqrt(Math.pow(x - 50, 2) + Math.pow(y - 50, 2));
        const d2 = Math.sqrt(Math.pow(x - (50 + Math.sin(now/1000)*20), 2) + Math.pow(y - 40, 2));
        return Math.min(d1, d2) / 10;
      });
      setMapData(prev => ({ ...prev, grid: newGrid }));

    }, 100);
    return () => clearInterval(interval);
  }, [mapData.grid]);

  const addLog = useCallback((message: string, level: LogLevel = LogLevel.INFO) => {
    const newLog: LogEntry = {
      id: Math.random().toString(36).substr(2, 9),
      level, message, time: new Date().toLocaleTimeString()
    };
    setLogs(prev => [newLog, ...prev].slice(0, 50));
  }, []);

  return (
    <div className="flex h-screen w-screen bg-slate-950 font-sans selection:bg-cyan-500/30">
      <Sidebar status={status} activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="flex-1 flex flex-col overflow-hidden border-l border-slate-800/50">
        <header className="h-14 flex items-center justify-between px-6 bg-slate-900/50 backdrop-blur-md border-b border-slate-800/50">
          <div className="flex items-center gap-4">
            <h1 className="text-sm font-bold tracking-widest text-slate-200 uppercase">
              {activeTab === 'dashboard' && 'Combat Dashboard'}
              {activeTab === 'navigation' && 'ESDF Navigation Map'}
              {activeTab === 'tuning' && 'Dynamic Parameter Tuning'}
            </h1>
            <div className="h-4 w-[1px] bg-slate-700"></div>
            <div className="flex items-center gap-2 text-xs text-cyan-400">
              <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></div>
              SHM_LINK_ACTIVE
            </div>
          </div>
          <div className="flex gap-4">
             <button className="px-3 py-1 bg-red-900/20 hover:bg-red-900/40 text-red-400 text-xs rounded border border-red-900/50 transition-all flex items-center gap-2">
               <AlertCircle size={14} /> KILL_PROCESS
             </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {activeTab === 'dashboard' && (
            <div className="h-full flex flex-col xl:flex-row gap-4">
              {/* 左侧主区域 */}
              <div className="flex-1 min-w-0 flex flex-col gap-4">
                <div className="flex-1 min-h-[300px] bg-slate-900/40 border border-slate-800/50 rounded-lg overflow-hidden relative">
                  <VideoFeed />
                </div>
                <div className="h-48 shrink-0 bg-slate-900/40 border border-slate-800/50 rounded-lg p-4">
                  <TelemetryChart data={telemetry} />
                </div>
              </div>
              {/* 右侧面板 */}
              <div className="w-full xl:w-80 shrink-0 flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-4">
                  <StatusCard label="NUC Load" value={`${status.nucCpuLoad.toFixed(1)}%`} subValue={`${status.nucTemp.toFixed(1)}°C`} icon={<Cpu size={18} className="text-orange-400" />} />
                  <StatusCard label="Vision" value={`${telemetry[telemetry.length-1]?.fps || 0} FPS`} subValue="210 Avg" icon={<Video size={18} className="text-purple-400" />} />
                </div>
                <div className="flex-1 min-h-[300px] bg-slate-900/80 border border-slate-800/50 rounded-lg flex flex-col overflow-hidden">
                  <div className="px-4 py-2 border-b border-slate-800/50 text-xs font-bold text-slate-400 uppercase tracking-wider">Console Output</div>
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

export default App;
