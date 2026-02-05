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

const DynamicChart: React.FC<Props> = ({ seriesKeys }) => {
    const { timeSeriesData } = useDataContext();

    // 合并多个系列的数据到同一时间轴
    const chartData = useMemo(() => {
        if (seriesKeys.length === 0) return [];

        // 收集所有时间戳
        const allTimestamps = new Set<number>();
        seriesKeys.forEach(key => {
            const data = timeSeriesData.get(key);
            if (data) {
                data.forEach(point => allTimestamps.add(point.timestamp));
            }
        });

        // 按时间戳排序
        const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

        // 构建图表数据
        return sortedTimestamps.map(timestamp => {
            const point: Record<string, number> = { timestamp };
            seriesKeys.forEach(key => {
                const data = timeSeriesData.get(key);
                if (data) {
                    // 找到最接近的数据点
                    const closest = data.reduce((prev, curr) =>
                        Math.abs(curr.timestamp - timestamp) < Math.abs(prev.timestamp - timestamp) ? curr : prev
                    );
                    if (Math.abs(closest.timestamp - timestamp) < 200) { // 200ms 容差
                        point[key] = closest.value;
                    }
                }
            });
            return point;
        }).slice(-100); // 只显示最近100个点
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

    return (
        <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis
                    dataKey="timestamp"
                    hide
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
                    labelFormatter={() => ''}
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
