import React, { useMemo } from 'react';
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

const DynamicChart: React.FC<Props> = ({ seriesKeys }) => {
    const { timeSeriesData } = useDataContext();

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
                    domain={['auto', 'auto']}
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
    );
};

export default DynamicChart;
