import React, { useState, memo } from 'react';
import { Search, GripVertical, TrendingUp } from 'lucide-react';
import { useDataContext } from './DataContext';
import { DataPoint } from '../type';

interface Props {
    className?: string;
}

const SERIES_COLORS: Record<string, string> = {
    ekf_x: '#06b6d4',     // cyan
    ekf_y: '#10b981',     // emerald
    target_dist: '#f59e0b', // amber
    fps: '#8b5cf6',       // violet
    latency: '#ef4444',   // red
    pid_error: '#ec4899', // pink
    gimbal_yaw: '#3b82f6', // blue
    gimbal_pitch: '#14b8a6', // teal
};

const getSeriesColor = (key: string): string => {
    if (SERIES_COLORS[key]) return SERIES_COLORS[key];
    // Generate consistent color from key hash
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = key.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 60%)`;
};

interface SeriesItemProps {
    seriesKey: string;
    data: DataPoint[] | undefined;
}

const SeriesItem = memo<SeriesItemProps>(({ seriesKey, data }) => {
    const latestValue = data && data.length > 0 ? data[data.length - 1].value.toFixed(2) : '--';
    const color = getSeriesColor(seriesKey);

    const handleDragStart = (e: React.DragEvent) => {
        e.dataTransfer.setData('application/series-key', seriesKey);
        e.dataTransfer.effectAllowed = 'copy';
    };

    return (
        <div
            draggable
            onDragStart={handleDragStart}
            className="flex items-center gap-2 px-2 py-1.5 bg-slate-800/30 hover:bg-slate-700/50 rounded cursor-grab active:cursor-grabbing transition-colors group"
        >
            <GripVertical size={12} className="text-slate-600 group-hover:text-slate-400" />
            <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
            />
            <span className="flex-1 text-xs text-slate-300 font-mono truncate">
                {seriesKey}
            </span>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
                {latestValue}
            </span>
            <TrendingUp size={10} className="text-slate-600" />
        </div>
    );
});

const DataSeriesList: React.FC<Props> = ({ className = '' }) => {
    const { availableSeries, timeSeriesData, isConnected } = useDataContext();
    const [searchQuery, setSearchQuery] = useState('');

    const filteredSeries = availableSeries.filter(key =>
        key.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className={`flex flex-col h-full bg-slate-900/80 ${className}`}>
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-800/50">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                        Data Series
                    </span>
                    <div className={`flex items-center gap-1.5 text-xs ${isConnected ? 'text-green-400' : 'text-amber-400'}`}>
                        <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-400' : 'bg-amber-400'} animate-pulse`} />
                        {isConnected ? 'LIVE' : 'OFFLINE'}
                    </div>
                </div>
                {/* Search */}
                <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input
                        type="text"
                        placeholder="搜索..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 bg-slate-800/50 border border-slate-700/50 rounded text-xs text-slate-300 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
                    />
                </div>
            </div>

            {/* Series List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {filteredSeries.length === 0 ? (
                    <div className="text-center text-slate-500 text-xs py-4">
                        {availableSeries.length === 0 ? '等待数据...' : '无匹配结果'}
                    </div>
                ) : (
                    filteredSeries.map(key => (
                        <SeriesItem
                            key={key}
                            seriesKey={key}
                            data={timeSeriesData.get(key)}
                        />
                    ))
                )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-slate-800/50 text-xs text-slate-500">
                {availableSeries.length} 个数据系列
            </div>
        </div>
    );
};

export { getSeriesColor };
export default DataSeriesList;
