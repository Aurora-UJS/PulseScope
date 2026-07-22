
import React, { useEffect, useState } from 'react';
import { SlidersHorizontal, Save } from 'lucide-react';
import { ControlParams } from '../type';

interface Props {
  // 后端最近一次确认的参数（初始加载 / sync 响应），draft 以此为基准
  applied: ControlParams;
  linkUp: boolean;
  onSync: (p: ControlParams) => Promise<boolean>;
}

const ParamPanel: React.FC<Props> = ({ applied, linkUp, onSync }) => {
  const [draft, setDraft] = useState<ControlParams>(applied);
  const [syncing, setSyncing] = useState(false);

  // 后端确认值变化时（初始加载、sync 后的 clamp 回读）对齐 UI
  useEffect(() => {
    setDraft(applied);
  }, [applied]);

  const handleChange = (key: keyof ControlParams, val: number | boolean) => {
    setDraft(prev => ({ ...prev, [key]: val }));
  };

  const syncToNuc = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await onSync(draft);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-6 shadow-xl">
      <div className="flex items-center justify-between mb-8">
        <h2 className="text-xl font-bold flex items-center gap-3">
          <SlidersHorizontal className="text-cyan-500" /> Dynamic Controller Tuning
        </h2>
        <div className="flex items-center gap-3">
          <div className={`text-xs font-mono ${linkUp ? 'text-emerald-400' : 'text-amber-400'}`}>
            {linkUp ? 'CTRL_LINK_UP' : 'CTRL_LINK_DOWN'}
          </div>
          <button
            onClick={syncToNuc}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-bold rounded-lg transition-all shadow-lg shadow-cyan-900/20"
          >
            <Save size={16} /> {syncing ? 'Syncing...' : 'Sync to SHM'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <section className="space-y-6">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest border-b border-slate-800 pb-2">Gains</h3>
          {[
            { key: 'pid_p', min: 0, max: 10, step: 0.01 },
            { key: 'pid_i', min: 0, max: 1, step: 0.001 },
            { key: 'pid_d', min: 0, max: 1, step: 0.001 },
          ].map((item) => (
            <div key={item.key} className="space-y-2">
              <div className="flex justify-between">
                <label className="text-sm font-medium text-slate-300 uppercase">{item.key.replace('_', ' ')}</label>
                <span className="text-cyan-400 font-mono text-sm">{(draft as any)[item.key]}</span>
              </div>
              <input
                type="range"
                min={item.min}
                max={item.max}
                step={item.step}
                value={(draft as any)[item.key]}
                onChange={(e) => handleChange(item.key as keyof ControlParams, parseFloat(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>
          ))}
        </section>

        <section className="space-y-6">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest border-b border-slate-800 pb-2">Manual Control</h3>
          <div className="space-y-2">
            <div className="flex justify-between">
              <label className="text-sm font-medium text-slate-300 uppercase">Exposure</label>
              <span className="text-cyan-400 font-mono text-sm">{draft.exposure}</span>
            </div>
            <input
              type="range"
              min={100}
              max={50000}
              step={100}
              value={draft.exposure}
              onChange={(e) => handleChange('exposure', parseInt(e.target.value, 10))}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
            />
          </div>

          <label className="flex items-center justify-between px-3 py-2 bg-slate-800/50 border border-slate-700/40 rounded-lg cursor-pointer">
            <span className="text-sm text-slate-300">Fire Enabled</span>
            <input
              type="checkbox"
              checked={draft.fire_enabled}
              onChange={(e) => handleChange('fire_enabled', e.target.checked)}
              className="h-4 w-4 accent-cyan-500"
            />
          </label>

          <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700/30">
            <p className="text-sm font-bold mb-2 text-slate-400">Notes</p>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Sync 通过 <code className="text-cyan-500">POST /api/control</code> 写入共享内存控制块，
              C++ 侧在下一帧 <code className="text-cyan-500">syncParams</code> 读取。
              返回值为 clamp 后的生效参数，UI 会自动对齐。
            </p>
          </div>
        </section>
      </div>
    </div>
  );
};

export default ParamPanel;
