
import React, { useRef, useEffect } from 'react';
import { SlidersHorizontal, Save, RotateCcw } from 'lucide-react';
import { ControlParams, LogLevel } from '../type';

interface Props {
  params: ControlParams;
  onUpdate: (p: ControlParams) => void;
  addLog: (msg: string, level: LogLevel) => void;
}

const ParamPanel: React.FC<Props> = ({ params, onUpdate, addLog }) => {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // 建立一个专门用于控制的连接，或者复用主连接
    wsRef.current = new WebSocket('ws://localhost:5000/ws');
    return () => wsRef.current?.close();
  }, []);

  const handleChange = (key: keyof ControlParams, val: any) => {
    onUpdate({ ...params, [key]: val });
  };

  const syncToNuc = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const payload = {
        pid_p: params.pid_p,
        pid_i: params.pid_i,
        pid_d: params.pid_d
      };
      wsRef.current.send(JSON.stringify(payload));
      addLog(`PID [${params.pid_p}, ${params.pid_i}, ${params.pid_d}] written to SHM`, LogLevel.INFO);
    } else {
      addLog("Failed to sync: WebSocket disconnected", LogLevel.ERROR);
    }
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-6 shadow-xl">
      <div className="flex items-center justify-between mb-8">
        <h2 className="text-xl font-bold flex items-center gap-3">
          <SlidersHorizontal className="text-cyan-500" /> Dynamic Controller Tuning
        </h2>
        <div className="flex gap-2">
           <button onClick={syncToNuc} className="flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-sm font-bold rounded-lg transition-all shadow-lg shadow-cyan-900/20">
             <Save size={16} /> Sync to SHM
           </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <section className="space-y-6">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest border-b border-slate-800 pb-2">Gains</h3>
          {['pid_p', 'pid_i', 'pid_d'].map((key) => (
            <div key={key} className="space-y-2">
              <div className="flex justify-between">
                <label className="text-sm font-medium text-slate-300 uppercase">{key.replace('_', ' ')}</label>
                <span className="text-cyan-400 font-mono text-sm">{(params as any)[key]}</span>
              </div>
              <input 
                type="range" min="0" max="5" step="0.01"
                value={(params as any)[key]}
                onChange={(e) => handleChange(key as any, parseFloat(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>
          ))}
        </section>

        <section className="space-y-6">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest border-b border-slate-800 pb-2">Manual Control</h3>
          <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700/30">
               <p className="text-sm font-bold mb-2 text-slate-400">Notes</p>
               <p className="text-[11px] text-slate-500 leading-relaxed">
                 Parameters are written directly to the NUC's shared memory. 
                 The vision loop will pick up these changes in the next execution cycle.
               </p>
          </div>
        </section>
      </div>
    </div>
  );
};

export default ParamPanel;
