
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AlertCircle, Cpu, ExternalLink, HeartPulse } from 'lucide-react';
import ParamPanel from './components/ParamPanel';
import ConsoleLog from './components/ConsoleLog';
import StatusCard from './components/StatusCard';
import {
  BackendStatus, ControlResponse, ControlUpdate,
  LogEntry, LogLevel, ParamInfo, ParamsResponse
} from './type';

// 控制面板：参数写回 + 运维（producer 状态 / kill）。
// 观测面（时序曲线 / 视频 / 地图）在 Rerun Viewer 中查看，不在本页面。
//
// 参数表完全由 producer 声明驱动：本文件不含任何参数名或范围。
const App: React.FC = () => {
  const [params, setParams] = useState<ParamInfo[] | null>(null);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [backendUp, setBackendUp] = useState(false);
  const [isKillingProcess, setIsKillingProcess] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // 已加载参数表的规模。与 status.param_count 不一致即说明 producer
  // 换了参数集（重启后增删了 declare），需要重新拉取。
  const loadedCountRef = useRef<number>(-1);

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
      const data = await resp.json() as ParamsResponse;
      setParams(data.params);
      loadedCountRef.current = data.count;
      return true;
    } catch {
      return false;
    }
  }, []);

  // 1Hz 状态轮询；参数集规模变化时重新拉取声明
  useEffect(() => {
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

        if (!st.shm_valid) {
          // 控制块不可用或版本不匹配：丢弃旧表，避免展示过期的参数声明
          setParams(null);
          loadedCountRef.current = -1;
          return;
        }
        if (st.param_count !== loadedCountRef.current) {
          await fetchParams();
        }
      } catch {
        if (!cancelled) setBackendUp(false);
      }
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [fetchParams]);

  const handleSync = useCallback(async (updates: ControlUpdate): Promise<boolean> => {
    const keys = Object.keys(updates);
    if (keys.length === 0) return true;

    try {
      const resp = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!resp.ok) {
        addLog(`param sync failed: ${await resp.text() || resp.statusText}`, LogLevel.ERROR);
        return false;
      }

      const data = await resp.json() as ControlResponse;
      setParams(data.params);
      loadedCountRef.current = data.count;

      // 回读值与请求值不同，说明被 producer 声明的区间钳制了
      const appliedByKey = new Map(data.params.map(p => [p.key, p.value]));
      const summary = keys.map(key => {
        const raw = updates[key];
        const want = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
        const got = appliedByKey.get(key);
        if (got === undefined) return `${key}=?`;
        return got !== want ? `${key}=${got}(clamped from ${want})` : `${key}=${got}`;
      }).join(' ');
      addLog(`params synced: ${summary}`, LogLevel.INFO);

      if (data.rejected && data.rejected.length > 0) {
        addLog(`rejected: ${data.rejected.join('; ')}`, LogLevel.WARN);
      }
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
            subValue={status?.shm_valid ? `${status.param_count} params` : '/aurora_rm_ctrl'}
            icon={<Activity size={16} className="text-purple-400" />}
          />
        </div>

        {params ? (
          <ParamPanel
            params={params}
            linkUp={backendUp && (status?.shm_valid ?? false)}
            onSync={handleSync}
          />
        ) : (
          <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-8 text-center text-sm text-slate-500">
            {!backendUp
              ? '后端不可达，请先启动 backend（:5000）'
              : status?.shm_attached
                ? '控制块版本不匹配（需要 v4），请确认 producer 与 backend 版本一致'
                : '等待 producer 创建控制共享内存（/dev/shm/aurora_rm_ctrl）…'}
          </div>
        )}

        <div className="bg-slate-900/40 border border-slate-800/50 rounded-lg p-4 flex items-start gap-3">
          <ExternalLink size={16} className="text-cyan-500 mt-0.5 shrink-0" />
          <p className="text-xs text-slate-400 leading-relaxed">
            时序曲线、相机画面、ESDF 地图在 <span className="text-cyan-400 font-bold">Rerun Viewer</span> 中查看。
            producer 默认自动拉起本机 viewer；远程部署时设
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
    </div>
  );
};

export default App;
