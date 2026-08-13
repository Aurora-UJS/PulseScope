
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertCircle, Cpu, ExternalLink, HeartPulse } from 'lucide-react';
import ParamPanel from './components/ParamPanel';
import ConsoleLog from './components/ConsoleLog';
import ObservePanel from './components/ObservePanel';
import StatusCard from './components/StatusCard';
import { BackendStatus, ControlParams, LogEntry, LogLevel } from './type';

// Web 实时观测（时序曲线 / 视频）+ 参数写回 + 运维；Rerun 仅用于可选录制与深度分析。
const App: React.FC = () => {
  const [applied, setApplied] = useState<ControlParams | null>(null);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [backendUp, setBackendUp] = useState(false);
  const [isKillingProcess, setIsKillingProcess] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState<'observe' | 'control'>('observe');

  const addLog = useCallback((message: string, level: LogLevel = LogLevel.INFO) => {
    const newLog: LogEntry = {
      id: Math.random().toString(36).substring(2, 11),
      level, message, time: new Date().toLocaleTimeString()
    };
    setLogs(prev => [newLog, ...prev].slice(0, 50));
  }, []);

  const fetchParams = useCallback(async () => {
    try {
      const resp = await fetch('/api/params');
      if (!resp.ok) return false;
      setApplied(await resp.json() as ControlParams);
      return true;
    } catch {
      return false;
    }
  }, []);

  // 1Hz 状态轮询；参数未加载且 SHM 可用时顺带补拉
  useEffect(() => {
    let paramsLoaded = false;
    let cancelled = false;

    const tick = async () => {
      try {
        const resp = await fetch('/api/status');
        if (cancelled) return;
        if (!resp.ok) {
          setBackendUp(false);
          return;
        }
        const st = await resp.json() as BackendStatus;
        setBackendUp(true);
        setStatus(st);
        if (!paramsLoaded && st.shm_valid) {
          paramsLoaded = await fetchParams();
        }
      } catch {
        if (!cancelled) setBackendUp(false);
      }
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [fetchParams]);

  const handleSync = useCallback(async (p: ControlParams): Promise<boolean> => {
    try {
      const resp = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p)
      });
      if (!resp.ok) {
        addLog(`param sync failed: ${await resp.text() || resp.statusText}`, LogLevel.ERROR);
        return false;
      }
      const appliedParams = await resp.json() as ControlParams;
      setApplied(appliedParams);
      addLog(
        `params synced: P=${appliedParams.pid_p.toFixed(2)} I=${appliedParams.pid_i.toFixed(3)} D=${appliedParams.pid_d.toFixed(3)} EXP=${appliedParams.exposure} FIRE=${appliedParams.fire_enabled ? 1 : 0}`,
        LogLevel.INFO
      );
      return true;
    } catch (err) {
      addLog(`param sync error: ${err instanceof Error ? err.message : String(err)}`, LogLevel.ERROR);
      return false;
    }
  }, [addLog]);

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

  const producerAlive = backendUp && (status?.producer_alive ?? false);

  return (
    <div className="min-h-screen w-screen bg-slate-950 font-sans selection:bg-cyan-500/30 text-slate-200">
      <header className="h-14 flex items-center justify-between px-6 bg-slate-900/50 backdrop-blur-md border-b border-slate-800/50">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-bold tracking-widest uppercase">PulseScope Control</h1>
          <div className="h-4 w-[1px] bg-slate-700"></div>
          <nav className="flex items-center gap-1">
            {(['observe', 'control'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider transition-all border ${
                  tab === t
                    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50'
                    : 'text-slate-500 border-transparent hover:text-slate-300'
                }`}
              >
                {t === 'observe' ? 'Observe' : 'Control'}
              </button>
            ))}
          </nav>
          <div className="h-4 w-[1px] bg-slate-700"></div>
          <div className={`flex items-center gap-2 text-xs ${producerAlive ? 'text-cyan-400' : 'text-amber-400'}`}>
            <div className={`w-2 h-2 rounded-full animate-pulse ${producerAlive ? 'bg-cyan-400' : 'bg-amber-400'}`}></div>
            {!backendUp ? 'BACKEND_DOWN' : producerAlive ? 'PRODUCER_ALIVE' : 'PRODUCER_OFFLINE'}
          </div>
        </div>
        <button
          onClick={handleKillProcess}
          disabled={isKillingProcess}
          className="px-3 py-1 bg-red-900/20 hover:bg-red-900/40 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 text-xs rounded border border-red-900/50 transition-all flex items-center gap-2"
        >
          <AlertCircle size={14} /> {isKillingProcess ? 'KILLING...' : 'KILL_PROCESS'}
        </button>
      </header>

      {tab === 'observe' ? (
        <main className="min-h-0 h-[calc(100vh-3.5rem)]">
          <ObservePanel />
        </main>
      ) : (
      <main className="max-w-4xl mx-auto p-6 flex flex-col gap-6">
        <div className="grid grid-cols-3 gap-3">
          <StatusCard
            label="NUC"
            value={status ? `${status.nuc_cpu_load.toFixed(0)}%` : '--'}
            subValue={status ? `${status.nuc_temp.toFixed(0)}°C` : ''}
            icon={<Cpu size={16} className="text-orange-400" />}
          />
          <StatusCard
            label="Heartbeat"
            value={status && status.heartbeat_age_ms >= 0 ? `${status.heartbeat_age_ms}ms` : '--'}
            subValue="age"
            icon={<HeartPulse size={16} className="text-rose-400" />}
          />
          <StatusCard
            label="SHM"
            value={status?.shm_valid ? 'VALID' : status?.shm_attached ? 'STALE' : 'N/A'}
            subValue="/aurora_rm_ctrl"
            icon={<Activity size={16} className="text-purple-400" />}
          />
        </div>

        {applied ? (
          <ParamPanel applied={applied} linkUp={backendUp && (status?.shm_valid ?? false)} onSync={handleSync} />
        ) : (
          <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-8 text-center text-sm text-slate-500">
            {backendUp
              ? '等待 producer 创建控制共享内存（/dev/shm/aurora_rm_ctrl）…'
              : '后端不可达，请先启动 backend（:5000）'}
          </div>
        )}

        <div className="bg-slate-900/40 border border-slate-800/50 rounded-lg p-4 flex items-start gap-3">
          <ExternalLink size={16} className="text-cyan-500 mt-0.5 shrink-0" />
          <p className="text-xs text-slate-400 leading-relaxed">
            实时曲线与画面见 <span className="text-cyan-400 font-bold">Observe</span> 页。
            深度分析 / 回放录制走 Rerun：设
            <code className="text-cyan-500 mx-1">PULSESCOPE_RERUN_CONNECT=rerun+http://&lt;host&gt;:9876/proxy</code>
            连接已运行的 viewer，或设
            <code className="text-cyan-500 mx-1">PULSESCOPE_RERUN_SAVE=xxx.rrd</code>
            录制后离线回放。
          </p>
        </div>

        <div className="h-48 bg-slate-900/80 border border-slate-800/50 rounded-lg flex flex-col overflow-hidden">
          <div className="px-3 py-1.5 border-b border-slate-800/50 text-xs font-bold text-slate-400 uppercase tracking-wider">Console</div>
          <ConsoleLog logs={logs} />
        </div>
      </main>
      )}
    </div>
  );
};

export default App;
