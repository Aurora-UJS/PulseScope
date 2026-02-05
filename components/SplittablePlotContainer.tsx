import React, { useState, useCallback } from 'react';
import { SplitSquareHorizontal, SplitSquareVertical, X, Trash2 } from 'lucide-react';
import DynamicChart from './DynamicChart';
import { getSeriesColor } from './DataSeriesList';

interface PanelNode {
    id: string;
    type: 'leaf' | 'split';
    direction?: 'horizontal' | 'vertical';
    children?: PanelNode[];
    ratio?: number;
    selectedSeries?: string[];
}

const generateId = () => Math.random().toString(36).substr(2, 9);

const SplittablePlotContainer: React.FC = () => {
    const [rootPanel, setRootPanel] = useState<PanelNode>({
        id: generateId(),
        type: 'leaf',
        selectedSeries: []
    });

    const splitPanel = useCallback((panelId: string, direction: 'horizontal' | 'vertical') => {
        const splitNode = (node: PanelNode): PanelNode => {
            if (node.id === panelId && node.type === 'leaf') {
                return {
                    id: generateId(),
                    type: 'split',
                    direction,
                    children: [
                        { id: node.id, type: 'leaf', selectedSeries: node.selectedSeries || [] },
                        { id: generateId(), type: 'leaf', selectedSeries: [] }
                    ],
                    ratio: 0.5
                };
            }
            if (node.type === 'split' && node.children) {
                return {
                    ...node,
                    children: node.children.map(child => splitNode(child))
                };
            }
            return node;
        };
        setRootPanel(prev => splitNode(prev));
    }, []);

    const closePanel = useCallback((panelId: string) => {
        const removeNode = (node: PanelNode): PanelNode | null => {
            if (node.type === 'split' && node.children) {
                const newChildren = node.children
                    .map(child => {
                        if (child.id === panelId && child.type === 'leaf') {
                            return null;
                        }
                        return removeNode(child);
                    })
                    .filter((c): c is PanelNode => c !== null);

                if (newChildren.length === 0) {
                    return null;
                }
                if (newChildren.length === 1) {
                    return newChildren[0];
                }
                return { ...node, children: newChildren };
            }
            return node;
        };

        setRootPanel(prev => {
            const result = removeNode(prev);
            return result || { id: generateId(), type: 'leaf', selectedSeries: [] };
        });
    }, []);

    const addSeriesToPanel = useCallback((panelId: string, seriesKey: string) => {
        const updateNode = (node: PanelNode): PanelNode => {
            if (node.id === panelId && node.type === 'leaf') {
                const current = node.selectedSeries || [];
                if (!current.includes(seriesKey)) {
                    return { ...node, selectedSeries: [...current, seriesKey] };
                }
                return node;
            }
            if (node.type === 'split' && node.children) {
                return { ...node, children: node.children.map(child => updateNode(child)) };
            }
            return node;
        };
        setRootPanel(prev => updateNode(prev));
    }, []);

    const removeSeriesFromPanel = useCallback((panelId: string, seriesKey: string) => {
        const updateNode = (node: PanelNode): PanelNode => {
            if (node.id === panelId && node.type === 'leaf') {
                return {
                    ...node,
                    selectedSeries: (node.selectedSeries || []).filter(k => k !== seriesKey)
                };
            }
            if (node.type === 'split' && node.children) {
                return { ...node, children: node.children.map(child => updateNode(child)) };
            }
            return node;
        };
        setRootPanel(prev => updateNode(prev));
    }, []);

    const countLeaves = (node: PanelNode): number => {
        if (node.type === 'leaf') return 1;
        if (node.children) {
            return node.children.reduce((acc, child) => acc + countLeaves(child), 0);
        }
        return 0;
    };

    const renderPanel = (node: PanelNode): React.ReactNode => {
        if (node.type === 'leaf') {
            const canClose = countLeaves(rootPanel) > 1;
            const selectedSeries = node.selectedSeries || [];

            const handleDragOver = (e: React.DragEvent) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            };

            const handleDrop = (e: React.DragEvent) => {
                e.preventDefault();
                const seriesKey = e.dataTransfer.getData('application/series-key');
                if (seriesKey) {
                    addSeriesToPanel(node.id, seriesKey);
                }
            };

            return (
                <div
                    key={node.id}
                    className="flex flex-col h-full w-full bg-slate-900/40 border border-slate-800/50 rounded-lg overflow-hidden"
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                >
                    {/* 工具栏 */}
                    <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800/50 border-b border-slate-700/50">
                        <div className="flex items-center gap-2 flex-1 min-w-0 overflow-x-auto">
                            {selectedSeries.length === 0 ? (
                                <span className="text-xs text-slate-500 italic">空面板</span>
                            ) : (
                                selectedSeries.map(key => (
                                    <div
                                        key={key}
                                        className="flex items-center gap-1 px-1.5 py-0.5 bg-slate-700/50 rounded text-xs group shrink-0"
                                    >
                                        <div
                                            className="w-2 h-2 rounded-full"
                                            style={{ backgroundColor: getSeriesColor(key) }}
                                        />
                                        <span className="text-slate-300 font-mono">{key}</span>
                                        <button
                                            onClick={() => removeSeriesFromPanel(node.id, key)}
                                            className="text-slate-500 hover:text-red-400 transition-colors"
                                        >
                                            <X size={10} />
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0 ml-2">
                            <button
                                onClick={() => splitPanel(node.id, 'horizontal')}
                                className="p-1 hover:bg-slate-700/50 rounded text-slate-400 hover:text-cyan-400 transition-colors"
                                title="水平拆分"
                            >
                                <SplitSquareHorizontal size={14} />
                            </button>
                            <button
                                onClick={() => splitPanel(node.id, 'vertical')}
                                className="p-1 hover:bg-slate-700/50 rounded text-slate-400 hover:text-cyan-400 transition-colors"
                                title="垂直拆分"
                            >
                                <SplitSquareVertical size={14} />
                            </button>
                            {canClose && (
                                <button
                                    onClick={() => closePanel(node.id)}
                                    className="p-1 hover:bg-red-900/50 rounded text-slate-400 hover:text-red-400 transition-colors"
                                    title="关闭面板"
                                >
                                    <Trash2 size={14} />
                                </button>
                            )}
                        </div>
                    </div>
                    {/* 图表区域 */}
                    <div className="flex-1 p-2 min-h-0">
                        <DynamicChart seriesKeys={selectedSeries} />
                    </div>
                </div>
            );
        }

        if (node.type === 'split' && node.children) {
            const isHorizontal = node.direction === 'horizontal';
            return (
                <div
                    key={node.id}
                    className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} h-full w-full gap-1`}
                >
                    {node.children.map((child) => (
                        <div
                            key={child.id}
                            className="flex-1 min-h-0 min-w-0"
                            style={{ flexBasis: `${(node.ratio || 0.5) * 100}%` }}
                        >
                            {renderPanel(child)}
                        </div>
                    ))}
                </div>
            );
        }

        return null;
    };

    return (
        <div className="h-full w-full">
            {renderPanel(rootPanel)}
        </div>
    );
};

export default SplittablePlotContainer;
