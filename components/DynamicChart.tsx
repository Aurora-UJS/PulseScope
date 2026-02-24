import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend
} from 'recharts';
import { useDataContext } from './DataContext';
import { getSeriesColor } from './DataSeriesList';

interface Props {
    seriesKeys: string[];
}

const MAX_RENDER_POINTS = 120;
const DEFAULT_MANUAL_MIN = -10;
const DEFAULT_MANUAL_MAX = 10;
const AUTO_DOMAIN: ['auto', 'auto'] = ['auto', 'auto'];

type AxisMode = 'auto' | 'lock' | 'manual';
type NumericDomain = [number, number];

const DynamicChart: React.FC<Props> = ({ seriesKeys }) => {
    const { timeSeriesData } = useDataContext();
    const [axisMode, setAxisMode] = useState<AxisMode>('auto');
    const [lockedDomain, setLockedDomain] = useState<NumericDomain | null>(null);
    const [manualMinInput, setManualMinInput] = useState<string>(String(DEFAULT_MANUAL_MIN));
    const [manualMaxInput, setManualMaxInput] = useState<string>(String(DEFAULT_MANUAL_MAX));

    // 合并多个系列到同一时间轴，避免逐点 nearest 搜索带来的 O(n^2) 开销。
    const chartData = useMemo(() => {
        if (seriesKeys.length === 0) return [];

        const timeline = new Map<number, Record<string, number>>();
        seriesKeys.forEach((key) => {
            const data = timeSeriesData.get(key);
            if (!data || data.length === 0) {
                return;
            }

            const tail = data.slice(-MAX_RENDER_POINTS);
            tail.forEach((point) => {
                const existing = timeline.get(point.timestamp);
                if (existing) {
                    existing[key] = point.value;
                } else {
                    timeline.set(point.timestamp, { timestamp: point.timestamp, [key]: point.value });
                }
            });
        });

        return Array
            .from(timeline.values())
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-MAX_RENDER_POINTS);
    }, [seriesKeys, timeSeriesData]);

    const dataDomain = useMemo<NumericDomain | null>(() => {
        if (seriesKeys.length === 0 || chartData.length === 0) {
            return null;
        }

        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        chartData.forEach((point) => {
            seriesKeys.forEach((key) => {
                const value = point[key];
                if (typeof value === 'number' && Number.isFinite(value)) {
                    if (value < min) min = value;
                    if (value > max) max = value;
                }
            });
        });

        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            return null;
        }

        if (min === max) {
            const pad = Math.max(Math.abs(min) * 0.1, 1);
            return [min - pad, max + pad];
        }

        const span = max - min;
        const pad = Math.max(span * 0.08, 0.1);
        return [min - pad, max + pad];
    }, [chartData, seriesKeys]);

    useEffect(() => {
        if (axisMode === 'lock' && !lockedDomain && dataDomain) {
            setLockedDomain(dataDomain);
        }
    }, [axisMode, dataDomain, lockedDomain]);

    const manualMin = Number(manualMinInput);
    const manualMax = Number(manualMaxInput);
    const isManualDomainValid = Number.isFinite(manualMin) && Number.isFinite(manualMax) && manualMin < manualMax;
    const manualDomain: NumericDomain = isManualDomainValid
        ? [manualMin, manualMax]
        : [DEFAULT_MANUAL_MIN, DEFAULT_MANUAL_MAX];

    const yDomain = useMemo<NumericDomain | ['auto', 'auto']>(() => {
        if (axisMode === 'auto') {
            return AUTO_DOMAIN;
        }
        if (axisMode === 'lock') {
            if (lockedDomain) {
                return lockedDomain;
            }
            return dataDomain || AUTO_DOMAIN;
        }
        if (isManualDomainValid) {
            return manualDomain;
        }
        return dataDomain || AUTO_DOMAIN;
    }, [axisMode, dataDomain, isManualDomainValid, lockedDomain, manualDomain]);

    const applyAxisMode = useCallback((mode: AxisMode) => {
        setAxisMode(mode);
        if (mode === 'lock') {
            setLockedDomain((prev) => prev || dataDomain);
        }
        if (mode === 'auto') {
            setLockedDomain(null);
        }
    }, [dataDomain]);

    const lockCurrentDomain = useCallback(() => {
        if (dataDomain) {
            setLockedDomain(dataDomain);
        }
    }, [dataDomain]);

    const fillManualFromData = useCallback(() => {
        if (!dataDomain) {
            return;
        }
        setManualMinInput(dataDomain[0].toFixed(3));
        setManualMaxInput(dataDomain[1].toFixed(3));
    }, [dataDomain]);

    if (seriesKeys.length === 0) {
        return (
            <div className="w-full h-full flex items-center justify-center text-slate-500">
                <div className="text-center">
                    <div className="text-2xl mb-2">📊</div>
                    <div className="text-xs">拖拽数据系列到此处</div>
                </div>
            </div>
        );
    }

    const formatTimestamp = (timestamp: number) => {
        const date = new Date(timestamp);
        return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
    };

    return (
        <div className="w-full h-full relative">
            <div className="absolute top-2 right-2 z-10 flex items-center gap-2 rounded border border-slate-700/60 bg-slate-900/80 px-2 py-1">
                <span className="text-[10px] text-slate-400">Y轴</span>
                <select
                    value={axisMode}
                    onChange={(e) => applyAxisMode(e.target.value as AxisMode)}
                    className="bg-slate-800/80 text-slate-200 text-[10px] border border-slate-700 rounded px-1.5 py-0.5 focus:outline-none"
                >
                    <option value="auto">自动</option>
                    <option value="lock">锁定当前</option>
                    <option value="manual">手动</option>
                </select>
                {axisMode === 'lock' && (
                    <button
                        onClick={lockCurrentDomain}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-300 hover:border-cyan-500/50"
                    >
                        重新锁定
                    </button>
                )}
            </div>

            {axisMode === 'manual' && (
                <div className="absolute top-10 right-2 z-10 flex items-center gap-1 rounded border border-slate-700/60 bg-slate-900/80 px-2 py-1">
                    <input
                        type="number"
                        value={manualMinInput}
                        onChange={(e) => setManualMinInput(e.target.value)}
                        className="w-16 bg-slate-800/80 text-slate-200 text-[10px] border border-slate-700 rounded px-1 py-0.5 focus:outline-none"
                        aria-label="manual y min"
                    />
                    <span className="text-[10px] text-slate-500">~</span>
                    <input
                        type="number"
                        value={manualMaxInput}
                        onChange={(e) => setManualMaxInput(e.target.value)}
                        className="w-16 bg-slate-800/80 text-slate-200 text-[10px] border border-slate-700 rounded px-1 py-0.5 focus:outline-none"
                        aria-label="manual y max"
                    />
                    <button
                        onClick={fillManualFromData}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-300 hover:border-cyan-500/50"
                    >
                        用当前
                    </button>
                    {!isManualDomainValid && (
                        <span className="text-[10px] text-amber-400">范围无效</span>
                    )}
                </div>
            )}

            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis
                        dataKey="timestamp"
                        tickFormatter={formatTimestamp}
                        stroke="#475569"
                        fontSize={9}
                        tickLine={false}
                        axisLine={{ stroke: '#334155' }}
                        interval="preserveStartEnd"
                        minTickGap={60}
                    />
                    <YAxis
                        domain={yDomain}
                        stroke="#475569"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        width={40}
                    />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: '#0f172a',
                            border: '1px solid #334155',
                            borderRadius: '4px',
                            fontSize: '10px'
                        }}
                        itemStyle={{ color: '#94a3b8' }}
                        labelFormatter={(timestamp) => formatTimestamp(timestamp as number)}
                    />
                    <Legend
                        wrapperStyle={{ fontSize: '10px' }}
                        iconType="line"
                        iconSize={8}
                    />
                    {seriesKeys.map(key => (
                        <Line
                            key={key}
                            type="monotone"
                            dataKey={key}
                            stroke={getSeriesColor(key)}
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                            name={key}
                        />
                    ))}
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
};

export default DynamicChart;
