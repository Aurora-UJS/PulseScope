import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Chart as ChartJS,
  ChartData,
  ChartOptions,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  Plugin,
  PointElement,
  Tooltip,
} from 'chart.js';
import { Check, ChevronDown, Columns2, Maximize, Pause, Play, RotateCcw, Rows2, Search, X } from 'lucide-react';
import zoomPlugin from 'chartjs-plugin-zoom';

const crosshairPlugin: Plugin<'line'> = {
  id: 'pulsescopeCrosshair',
  afterDraw(chart) {
    const active = chart.tooltip?.getActiveElements();
    if (!active?.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.stroke();
    ctx.restore();
  },
};

ChartJS.register(LineController, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler, zoomPlugin, crosshairPlugin);

type Series = { time: number[] } & Record<string, (number | null)[]>;

const PALETTE = ['#22d3ee', '#fbbf24', '#f472b6', '#4ade80'];
const MAX_COMPARE_SIGNALS = 4;

type TimeRange = { min: number; max: number } | null;

type PaneKind = 'video' | 'plot';

type WorkspaceNode =
  | { type: 'pane'; id: number; kind: PaneKind; signals: string[] }
  | {
      type: 'split';
      id: number;
      direction: 'row' | 'column';
      ratio: number;
      first: WorkspaceNode;
      second: WorkspaceNode;
    };

const countPanes = (node: WorkspaceNode): number =>
  node.type === 'pane' ? 1 : countPanes(node.first) + countPanes(node.second);

const updatePaneNode = (
  node: WorkspaceNode,
  paneId: number,
  update: (pane: Extract<WorkspaceNode, { type: 'pane' }>) => WorkspaceNode,
): WorkspaceNode => {
  if (node.type === 'pane') return node.id === paneId ? update(node) : node;
  return {
    ...node,
    first: updatePaneNode(node.first, paneId, update),
    second: updatePaneNode(node.second, paneId, update),
  };
};

const updateSplitRatio = (node: WorkspaceNode, splitId: number, ratio: number): WorkspaceNode => {
  if (node.type === 'pane') return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    first: updateSplitRatio(node.first, splitId, ratio),
    second: updateSplitRatio(node.second, splitId, ratio),
  };
};

const removePaneNode = (node: WorkspaceNode, paneId: number): WorkspaceNode | null => {
  if (node.type === 'pane') return node.id === paneId ? null : node;
  const first = removePaneNode(node.first, paneId);
  const second = removePaneNode(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
};

function useSeries(maxPoints: number) {
  const [series, setSeries] = useState<Series | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch(`/api/series?max_points=${maxPoints}`);
        if (!response.ok) return;
        const next: Series = await response.json();
        if (!cancelled) setSeries(next);
      } catch {
        // Keep the last sample visible while the backend is offline.
      }
    };

    void tick();
    const timer = window.setInterval(tick, 400);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [maxPoints]);

  return series;
}

function latestValue(series: Series | null, key: string) {
  const values = series?.[key] ?? [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null) return values[index];
  }
  return null;
}

function buildData(series: Series | null, selected: string[]): ChartData<'line'> {
  const time = series?.time ?? [];

  return {
    datasets: selected.map((key, index) => ({
      label: key,
      data: time.map((x, pointIndex) => ({ x, y: series?.[key]?.[pointIndex] ?? null })),
      borderColor: PALETTE[index % PALETTE.length],
      backgroundColor: PALETTE[index % PALETTE.length],
      borderWidth: index === 0 ? 2 : 1.5,
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0.1,
      spanGaps: false,
    })),
  };
}

const chartOptions = (onRangeChange: (range: TimeRange) => void): ChartOptions<'line'> => ({
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  parsing: false,
  normalized: true,
  interaction: { mode: 'nearest', axis: 'x', intersect: false },
  scales: {
    x: {
      type: 'linear',
      ticks: { color: '#94a3b8', maxTicksLimit: 10, font: { size: 10 } },
      grid: { color: 'rgba(148, 163, 184, 0.1)' },
      title: { display: true, text: 'time (s)', color: '#64748b' },
    },
    y: {
      type: 'linear',
      grace: '8%',
      ticks: { color: '#94a3b8', font: { size: 10 } },
      grid: { color: 'rgba(148, 163, 184, 0.1)' },
    },
  },
  plugins: {
    legend: {
      display: true,
      align: 'start',
      labels: { color: '#cbd5e1', boxWidth: 18, boxHeight: 2, usePointStyle: false },
    },
    tooltip: {
      backgroundColor: 'rgba(15, 23, 42, 0.96)',
      borderColor: '#334155',
      borderWidth: 1,
      titleColor: '#e2e8f0',
      bodyColor: '#cbd5e1',
    },
    zoom: {
      pan: {
        enabled: true,
        mode: 'x',
        onPanComplete: ({ chart }) => onRangeChange({ min: chart.scales.x.min, max: chart.scales.x.max }),
      },
      zoom: {
        mode: 'x',
        wheel: { enabled: true, speed: 0.08 },
        pinch: { enabled: true },
        onZoomComplete: ({ chart }) => onRangeChange({ min: chart.scales.x.min, max: chart.scales.x.max }),
      },
    },
  },
});

const Plot: React.FC<{
  series: Series | null;
  selected: string[];
  timeRange: TimeRange;
  rangeVersion: number;
  onRangeChange: (range: TimeRange) => void;
}> = ({ series, selected, timeRange, rangeVersion, onRangeChange }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJS<'line'> | null>(null);
  const data = useMemo(() => buildData(series, selected), [series, selected]);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new ChartJS(canvasRef.current, {
      type: 'line',
      data,
      options: chartOptions(onRangeChange),
    });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.data = data;
    chartRef.current.update('none');
  }, [data]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (timeRange) chart.zoomScale('x', timeRange, 'none');
    else chart.resetZoom('none');
  }, [timeRange, rangeVersion]);

  return <canvas ref={canvasRef} />;
};

const SignalPicker: React.FC<{
  keys: string[];
  selected: string[];
  series: Series | null;
  onChange: (keys: string[]) => void;
}> = ({ keys, selected, series, onChange }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const filtered = keys.filter(key => key.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const toggle = (key: string) => {
    if (selected.includes(key)) {
      if (selected.length > 1) onChange(selected.filter(item => item !== key));
      return;
    }
    onChange([...selected, key].slice(-MAX_COMPARE_SIGNALS));
  };

  return (
    <div ref={containerRef} className="relative w-full sm:w-80">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="h-9 w-full border border-slate-700 bg-slate-950 px-3 text-left text-xs text-slate-200 hover:border-slate-600 flex items-center justify-between gap-3"
      >
        <span className="truncate">
          {selected.length === 1 ? selected[0] : `${selected[0]} +${selected.length - 1}`}
        </span>
        <ChevronDown size={15} className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-30 w-full border border-slate-700 bg-slate-950 shadow-2xl">
          <div className="border-b border-slate-800 p-2">
            <div className="flex items-center gap-2 bg-slate-900 px-2">
              <Search size={14} className="text-slate-500" />
              <input
                autoFocus
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索信号"
                className="h-8 min-w-0 flex-1 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {filtered.map(key => {
              const active = selected.includes(key);
              const value = latestValue(series, key);
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => toggle(key)}
                  className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-900"
                >
                  <Check size={14} className={active ? 'text-cyan-400' : 'text-transparent'} />
                  <span className={active ? 'truncate text-slate-100' : 'truncate text-slate-400'}>{key}</span>
                  <span className="font-mono tabular-nums text-slate-500">{value?.toFixed(3) ?? '--'}</span>
                </button>
              );
            })}
            {filtered.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-600">无匹配信号</div>}
          </div>
          <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-600">
            最多同时对比 {MAX_COMPARE_SIGNALS} 条曲线
          </div>
        </div>
      )}
    </div>
  );
};

const ObservePanel: React.FC = () => {
  const [maxPoints, setMaxPoints] = useState(600);
  const [paused, setPaused] = useState(false);
  const liveSeries = useSeries(maxPoints);
  const [frozenSeries, setFrozenSeries] = useState<Series | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceNode>({
    type: 'split',
    id: 1,
    direction: window.innerWidth < 900 ? 'column' : 'row',
    ratio: 46,
    first: { type: 'pane', id: 2, kind: 'video', signals: [] },
    second: { type: 'pane', id: 3, kind: 'plot', signals: [] },
  });
  const [timeRange, setTimeRange] = useState<TimeRange>(null);
  const [rangeVersion, setRangeVersion] = useState(0);
  const nextNodeId = useRef(4);
  const syncingRange = useRef(false);
  const series = paused ? frozenSeries : liveSeries;
  const keys = useMemo(() => Object.keys(series ?? {}).filter(key => key !== 'time').sort(), [series]);

  useEffect(() => {
    if (keys.length === 0) return;
    const addDefaultSignal = (node: WorkspaceNode): WorkspaceNode => {
      if (node.type === 'pane') {
        return node.kind === 'plot' && node.signals.length === 0 ? { ...node, signals: [keys[0]] } : node;
      }
      return { ...node, first: addDefaultSignal(node.first), second: addDefaultSignal(node.second) };
    };
    setWorkspace(addDefaultSignal);
  }, [keys]);

  const togglePaused = () => {
    if (!paused) setFrozenSeries(liveSeries);
    setPaused(value => !value);
  };

  const syncTimeRange = (range: TimeRange) => {
    if (syncingRange.current) return;
    syncingRange.current = true;
    setTimeRange(range);
    setRangeVersion(version => version + 1);
    window.requestAnimationFrame(() => { syncingRange.current = false; });
  };

  const resetTimeRange = () => syncTimeRange(null);

  const startResize = (event: React.PointerEvent<HTMLDivElement>, splitId: number, direction: 'row' | 'column') => {
    event.preventDefault();
    const parent = event.currentTarget.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      const raw = direction === 'column'
        ? ((moveEvent.clientY - rect.top) / rect.height) * 100
        : ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setWorkspace(current => updateSplitRatio(current, splitId, Math.min(78, Math.max(22, raw))));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const toggleFullscreen = (paneId: number) => {
    const pane = document.getElementById(`observe-pane-${paneId}`);
    if (document.fullscreenElement) void document.exitFullscreen();
    else void pane?.requestFullscreen();
  };

  const splitPane = (pane: Extract<WorkspaceNode, { type: 'pane' }>, direction: 'row' | 'column') => {
    const splitId = nextNodeId.current++;
    const newPaneId = nextNodeId.current++;
    setWorkspace(current => updatePaneNode(current, pane.id, currentPane => ({
      type: 'split',
      id: splitId,
      direction,
      ratio: 50,
      first: currentPane,
      second: { ...currentPane, id: newPaneId },
    })));
  };

  const closePane = (paneId: number) => {
    setWorkspace(current => removePaneNode(current, paneId) ?? current);
  };

  const updatePane = (paneId: number, update: (pane: Extract<WorkspaceNode, { type: 'pane' }>) => WorkspaceNode) => {
    setWorkspace(current => updatePaneNode(current, paneId, update));
  };

  const renderPane = (pane: Extract<WorkspaceNode, { type: 'pane' }>) => {
    const primary = pane.signals[0];
    const primaryValue = primary ? latestValue(series, primary) : null;
    return (
      <section id={`observe-pane-${pane.id}`} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border border-slate-800 bg-slate-900/50">
        <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900 px-2 py-1">
          <select
            value={pane.kind}
            onChange={event => {
              const kind = event.target.value as PaneKind;
              updatePane(pane.id, current => ({
                ...current,
                kind,
                signals: kind === 'plot' && current.signals.length === 0 && keys.length > 0
                  ? [keys[0]]
                  : current.signals,
              }));
            }}
            className="h-8 border border-slate-700 bg-slate-950 px-2 text-xs font-bold uppercase text-slate-300 outline-none"
            title="窗口内容"
          >
            <option value="video">Video</option>
            <option value="plot">Plot</option>
          </select>

          {pane.kind === 'plot' && keys.length > 0 && (
            <SignalPicker
              keys={keys}
              selected={pane.signals}
              series={series}
              onChange={signals => updatePane(pane.id, current => ({ ...current, signals }))}
            />
          )}

          {pane.kind === 'plot' && primaryValue !== null && (
            <span className="font-mono text-xs tabular-nums text-cyan-300">{primaryValue.toFixed(4)}</span>
          )}

          <div className="ml-auto flex items-center gap-0.5">
            {pane.kind === 'plot' && (
              <>
                <button type="button" onClick={togglePaused} className="flex h-8 w-8 items-center justify-center text-slate-500 hover:text-cyan-300" title={paused ? '继续' : '暂停'}>
                  {paused ? <Play size={15} /> : <Pause size={15} />}
                </button>
                <button type="button" onClick={resetTimeRange} className="flex h-8 w-8 items-center justify-center text-slate-500 hover:text-cyan-300" title="复位缩放">
                  <RotateCcw size={15} />
                </button>
                <select
                  value={maxPoints}
                  onChange={event => setMaxPoints(Number(event.target.value))}
                  className="h-8 border border-slate-700 bg-slate-950 px-1 text-[11px] text-slate-400 outline-none"
                  title="历史点数"
                >
                  <option value={100}>100</option>
                  <option value={300}>300</option>
                  <option value={600}>600</option>
                </select>
              </>
            )}
            <button type="button" onClick={() => splitPane(pane, 'row')} className="flex h-8 w-8 items-center justify-center text-slate-500 hover:text-cyan-300" title="左右拆分">
              <Columns2 size={15} />
            </button>
            <button type="button" onClick={() => splitPane(pane, 'column')} className="flex h-8 w-8 items-center justify-center text-slate-500 hover:text-cyan-300" title="上下拆分">
              <Rows2 size={15} />
            </button>
            <button type="button" onClick={() => toggleFullscreen(pane.id)} className="flex h-8 w-8 items-center justify-center text-slate-500 hover:text-cyan-300" title="窗口全屏">
              <Maximize size={15} />
            </button>
            <button type="button" disabled={countPanes(workspace) === 1} onClick={() => closePane(pane.id)} className="flex h-8 w-8 items-center justify-center text-slate-500 hover:text-red-400 disabled:opacity-20" title="关闭窗口">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className={`relative min-h-0 min-w-0 flex-1 ${pane.kind === 'video' ? 'bg-black' : 'p-3'}`}>
          {pane.kind === 'video' ? (
            <img src="/api/video" alt="视频流" className="block h-full w-full min-h-0 min-w-0 object-contain" />
          ) : pane.signals.length > 0 && (series?.time.length ?? 0) > 0 ? (
            <Plot series={series} selected={pane.signals} timeRange={timeRange} rangeVersion={rangeVersion} onRangeChange={syncTimeRange} />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-600">等待时序数据...</div>
          )}
        </div>

        {pane.kind === 'plot' && (
          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-slate-800 bg-slate-900 px-2 text-[10px] text-slate-600">
            <span>{series?.time.length ?? 0} samples · 滚轮缩放 · 拖动平移</span>
            <span>{paused ? 'PAUSED' : 'LIVE'}</span>
          </footer>
        )}
      </section>
    );
  };

  const renderNode = (node: WorkspaceNode): React.ReactNode => {
    if (node.type === 'pane') return renderPane(node);
    const isColumn = node.direction === 'column';
    return (
      <div className={`flex h-full min-h-0 min-w-0 flex-1 overflow-hidden ${isColumn ? 'flex-col' : 'flex-row'}`}>
        <div className="min-h-0 min-w-0" style={isColumn ? { height: `${node.ratio}%` } : { width: `${node.ratio}%` }}>
          {renderNode(node.first)}
        </div>
        <div
          role="separator"
          aria-orientation={isColumn ? 'horizontal' : 'vertical'}
          onPointerDown={event => startResize(event, node.id, node.direction)}
          onDoubleClick={() => setWorkspace(current => updateSplitRatio(current, node.id, 50))}
          className={`group shrink-0 touch-none ${isColumn ? 'h-2 cursor-row-resize' : 'w-2 cursor-col-resize'} flex items-center justify-center`}
        >
          <div className={`${isColumn ? 'h-px w-16' : 'h-16 w-px'} bg-slate-700 group-hover:bg-cyan-500`} />
        </div>
        <div className="min-h-0 min-w-0 flex-1">{renderNode(node.second)}</div>
      </div>
    );
  };

  return (
    <main className="flex h-full min-h-0 min-w-0 overflow-hidden bg-slate-950 p-2">
      {renderNode(workspace)}
    </main>
  );
};

export default ObservePanel;
