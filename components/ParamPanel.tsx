
import React, { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal, Save, RotateCcw } from 'lucide-react';
import { ControlUpdate, ParamInfo } from '../type';

interface Props {
  // backend 最近一次确认的参数表（初始加载 / sync 回读），draft 以此为基准
  params: ParamInfo[];
  linkUp: boolean;
  onSync: (updates: ControlUpdate) => Promise<boolean>;
}

// 从声明的 step 推导显示小数位，避免 0.1 + 0.2 这类浮点尾数糊在界面上
const decimalsFromStep = (step: number): number => {
  if (!Number.isFinite(step) || step <= 0) return 3;
  const text = step.toString();
  if (text.includes('e-')) return Math.min(6, Number(text.split('e-')[1]) || 3);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
};

const formatValue = (p: ParamInfo, value: number): string => {
  if (p.type === 'bool') return value !== 0 ? 'ON' : 'OFF';
  const decimals = p.type === 'int' ? 0 : decimalsFromStep(p.step);
  return value.toFixed(decimals);
};

const ParamPanel: React.FC<Props> = ({ params, linkUp, onSync }) => {
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [syncing, setSyncing] = useState(false);

  // backend 确认值变化时（初始加载、sync 后的 clamp 回读）对齐 UI
  useEffect(() => {
    setDraft(Object.fromEntries(params.map(p => [p.key, p.value])));
  }, [params]);

  const applied = useMemo(
    () => Object.fromEntries(params.map(p => [p.key, p.value])),
    [params]
  );

  const dirty = useMemo(
    () => params.some(p => draft[p.key] !== undefined && draft[p.key] !== applied[p.key]),
    [params, draft, applied]
  );

  const setValue = (key: string, value: number) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      // 只下发被改动过的参数，避免无谓覆盖其他客户端刚写入的值
      const updates: ControlUpdate = {};
      for (const p of params) {
        const v = draft[p.key];
        if (v === undefined || v === applied[p.key]) continue;
        updates[p.key] = p.type === 'bool' ? v !== 0 : v;
      }
      await onSync(updates);
    } finally {
      setSyncing(false);
    }
  };

  const handleReset = () => {
    setDraft(Object.fromEntries(params.map(p => [p.key, p.default])));
  };

  if (params.length === 0) {
    return (
      <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-8 text-center text-sm text-slate-500">
        producer 未声明任何参数
      </div>
    );
  }

  const booleans = params.filter(p => p.type === 'bool');
  const numerics = params.filter(p => p.type !== 'bool');

  return (
    <div className="bg-slate-900/60 border border-slate-800/50 rounded-xl p-6 shadow-xl">
      <div className="flex items-center justify-between mb-8">
        <h2 className="text-xl font-bold flex items-center gap-3">
          <SlidersHorizontal className="text-cyan-500" /> Dynamic Controller Tuning
          <span className="text-xs font-normal text-slate-500 font-mono">{params.length} params</span>
        </h2>
        <div className="flex items-center gap-3">
          <div className={`text-xs font-mono ${linkUp ? 'text-emerald-400' : 'text-amber-400'}`}>
            {linkUp ? 'CTRL_LINK_UP' : 'CTRL_LINK_DOWN'}
          </div>
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm rounded-lg transition-all"
            title="将草稿重置为 producer 声明的默认值"
          >
            <RotateCcw size={14} /> Defaults
          </button>
          <button
            onClick={handleSync}
            disabled={syncing || !dirty}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-bold rounded-lg transition-all shadow-lg shadow-cyan-900/20"
          >
            <Save size={16} /> {syncing ? 'Syncing...' : dirty ? 'Sync to SHM' : 'In Sync'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
        {numerics.map(p => {
          const value = draft[p.key] ?? p.value;
          const changed = value !== applied[p.key];
          return (
            <div key={p.key} className="space-y-2">
              <div className="flex justify-between items-baseline">
                <label className="text-sm font-medium text-slate-300 font-mono">
                  {p.key}
                  {p.unit && <span className="text-slate-500 ml-1">({p.unit})</span>}
                </label>
                <span className={`font-mono text-sm ${changed ? 'text-amber-400' : 'text-cyan-400'}`}>
                  {formatValue(p, value)}
                </span>
              </div>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={p.step > 0 ? p.step : 'any'}
                value={value}
                onChange={e => setValue(p.key, parseFloat(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
              <div className="flex justify-between text-[10px] text-slate-600 font-mono">
                <span>{formatValue(p, p.min)}</span>
                <span>{formatValue(p, p.max)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {booleans.length > 0 && (
        <div className="mt-8 pt-6 border-t border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-4">
          {booleans.map(p => {
            const value = draft[p.key] ?? p.value;
            const changed = value !== applied[p.key];
            return (
              <label
                key={p.key}
                className="flex items-center justify-between px-3 py-2 bg-slate-800/50 border border-slate-700/40 rounded-lg cursor-pointer"
              >
                <span className={`text-sm font-mono ${changed ? 'text-amber-400' : 'text-slate-300'}`}>
                  {p.key}
                </span>
                <input
                  type="checkbox"
                  checked={value !== 0}
                  onChange={e => setValue(p.key, e.target.checked ? 1 : 0)}
                  className="h-4 w-4 accent-cyan-500"
                />
              </label>
            );
          })}
        </div>
      )}

      <div className="mt-6 p-4 bg-slate-800/50 rounded-lg border border-slate-700/30">
        <p className="text-sm font-bold mb-2 text-slate-400">Notes</p>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          参数名、范围、步进与单位全部读自共享内存中 producer 的声明
          （<code className="text-cyan-500">Monitor::declareFloat / declareInt / declareBool</code>），
          前端与 backend 均不含硬编码。新增可调参数只需在 producer 侧加一行 declare，
          此面板自动出现对应控件。写入值由 backend 按同一份声明钳制，回读结果即生效值。
        </p>
      </div>
    </div>
  );
};

export default ParamPanel;
