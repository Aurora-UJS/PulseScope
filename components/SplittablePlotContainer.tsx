import React, { useCallback, useState, useRef } from 'react';
import { SplitSquareHorizontal, SplitSquareVertical, X, Trash2 } from 'lucide-react';
import DynamicChart from './DynamicChart';
import { getSeriesColor } from './DataSeriesList';
import { useDataContext } from './DataContext';
import { PanelNode } from '../type';

const generateId = () => Math.random().toString(36).substr(2, 9);

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

const SplittablePlotContainer: React.FC = () => {
    const { rootPanel, setRootPanel, activePanelId, setActivePanelId } = useDataContext();

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
    }, [setRootPanel]);

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
    }, [setRootPanel]);

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
    }, [setRootPanel]);

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
    }, [setRootPanel]);

    const moveSeriesBetweenPanels = useCallback((sourcePanelId: string, targetPanelId: string, seriesKey: string) => {
        if (sourcePanelId === targetPanelId) return;
        setRootPanel(prev => {
            const updateNode = (node: PanelNode): PanelNode => {
                if (node.id === sourcePanelId && node.type === 'leaf') {
                    return { ...node, selectedSeries: (node.selectedSeries || []).filter(k => k !== seriesKey) };
                }
                if (node.id === targetPanelId && node.type === 'leaf') {
                    const current = node.selectedSeries || [];
                    if (current.includes(seriesKey)) return node;
                    return { ...node, selectedSeries: [...current, seriesKey] };
                }
                if (node.type === 'split' && node.children) {
                    return { ...node, children: node.children.map(c => updateNode(c)) };
                }
                return node;
            };
            return updateNode(prev);
        });
    }, [setRootPanel]);

    const updateRatio = useCallback((splitId: string, ratio: number) => {
        const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
        const updateNode = (node: PanelNode): PanelNode => {
            if (node.id === splitId && node.type === 'split') {
                return { ...node, ratio: clamped };
            }
            if (node.type === 'split' && node.children) {
                return { ...node, children: node.children.map(c => updateNode(c)) };
            }
            return node;
        };
        setRootPanel(prev => updateNode(prev));
    }, [setRootPanel]);

    const countLeaves = (node: PanelNode): number => {
        if (node.type === 'leaf') return 1;
        if (node.children) {
            return node.children.reduce((acc, child) => acc + countLeaves(child), 0);
        }
        return 0;
    };

    const renderPanel = (node: PanelNode): React.ReactNode => {
        if (node.type === 'leaf') {
            return <LeafPanel
                key={node.id}
                node={node}
                isActive={activePanelId === node.id}
                canClose={countLeaves(rootPanel) > 1}
                onActivate={setActivePanelId}
                onSplit={splitPanel}
                onClose={closePanel}
                onAddSeries={addSeriesToPanel}
                onRemoveSeries={removeSeriesFromPanel}
                onMoveSeries={moveSeriesBetweenPanels}
            />;
        }

        if (node.type === 'split' && node.children && node.children.length === 2) {
            const isHorizontal = node.direction === 'horizontal';
            const ratio = node.ratio || 0.5;
            return (
                <div
                    key={node.id}
                    className={`flex ${isHorizontal ? 'flex-row' : 'flex-col'} h-full w-full`}
                >
                    <div
                        className="min-h-0 min-w-0 overflow-hidden"
                        style={{ flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 }}
                    >
                        {renderPanel(node.children[0])}
                    </div>
                    <SplitDivider
                        splitId={node.id}
                        direction={isHorizontal ? 'horizontal' : 'vertical'}
                        onResize={updateRatio}
                    />
                    <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                        {renderPanel(node.children[1])}
                    </div>
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

// ─── 可拖拽分隔条 ───────────────────────────────────────────

interface SplitDividerProps {
    splitId: string;
    direction: 'horizontal' | 'vertical';
    onResize: (splitId: string, ratio: number) => void;
}

const SplitDivider: React.FC<SplitDividerProps> = ({ splitId, direction, onResize }) => {
    const [dragging, setDragging] = useState(false);
    const dividerRef = useRef<HTMLDivElement>(null);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setDragging(true);

        const parent = dividerRef.current?.parentElement;
        if (!parent) return;

        const rect = parent.getBoundingClientRect();

        const onMouseMove = (ev: MouseEvent) => {
            let ratio: number;
            if (direction === 'horizontal') {
                ratio = (ev.clientX - rect.left) / rect.width;
            } else {
                ratio = (ev.clientY - rect.top) / rect.height;
            }
            onResize(splitId, ratio);
        };

        const onMouseUp = () => {
            setDragging(false);
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
    }, [splitId, direction, onResize]);

    const isH = direction === 'horizontal';

    return (
        <div
            ref={dividerRef}
            onMouseDown={handleMouseDown}
            className={`
                ${isH ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'}
                flex-shrink-0 relative group
                ${dragging ? 'bg-cyan-500/40' : 'bg-slate-800/50 hover:bg-cyan-500/30'}
                transition-colors
            `}
        >
            <div className={`
                absolute ${isH ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8' : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-0.5 w-8'}
                bg-slate-600 group-hover:bg-cyan-400 rounded-full transition-colors
                ${dragging ? 'bg-cyan-400' : ''}
            `} />
        </div>
    );
};

// ─── 叶子面板 ───────────────────────────────────────────────

interface LeafPanelProps {
    node: PanelNode;
    isActive: boolean;
    canClose: boolean;
    onActivate: (id: string) => void;
    onSplit: (id: string, dir: 'horizontal' | 'vertical') => void;
    onClose: (id: string) => void;
    onAddSeries: (panelId: string, seriesKey: string) => void;
    onRemoveSeries: (panelId: string, seriesKey: string) => void;
    onMoveSeries: (sourcePanelId: string, targetPanelId: string, seriesKey: string) => void;
}

const LeafPanel: React.FC<LeafPanelProps> = ({
    node, isActive, canClose,
    onActivate, onSplit, onClose, onAddSeries, onRemoveSeries, onMoveSeries
}) => {
    const [dragOver, setDragOver] = useState(false);
    const dragCounterRef = useRef(0);
    const selectedSeries = node.selectedSeries || [];

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    };

    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        dragCounterRef.current++;
        setDragOver(true);
    };

    const handleDragLeave = () => {
        dragCounterRef.current--;
        if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setDragOver(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        dragCounterRef.current = 0;
        setDragOver(false);

        // 面板间移动
        const moveData = e.dataTransfer.getData('application/panel-series-move');
        if (moveData) {
            try {
                const { sourcePanelId, seriesKey } = JSON.parse(moveData);
                onMoveSeries(sourcePanelId, node.id, seriesKey);
            } catch { /* ignore */ }
            return;
        }

        // 从列表添加
        const seriesKey = e.dataTransfer.getData('application/series-key');
        if (seriesKey) {
            onAddSeries(node.id, seriesKey);
        }
    };

    // 面板标签拖拽（面板间移动）
    const handleTagDragStart = (e: React.DragEvent, seriesKey: string) => {
        e.dataTransfer.setData('application/panel-series-move', JSON.stringify({
            sourcePanelId: node.id,
            seriesKey,
        }));
        e.dataTransfer.effectAllowed = 'move';
    };

    return (
        <div
            onClick={() => onActivate(node.id)}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`
                flex flex-col h-full w-full bg-slate-900/40 rounded-lg overflow-hidden transition-all
                ${dragOver
                    ? 'border-2 border-cyan-400/60 bg-cyan-950/20'
                    : isActive
                        ? 'border border-cyan-800/50'
                        : 'border border-slate-800/50'
                }
            `}
        >
            {/* 工具栏 */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800/50 border-b border-slate-700/50">
                <div className="flex items-center gap-2 flex-1 min-w-0 overflow-x-auto">
                    {selectedSeries.length === 0 ? (
                        <span className="text-xs text-slate-500 italic">
                            {dragOver ? '松开以添加' : '拖拽或点击添加数据系列'}
                        </span>
                    ) : (
                        selectedSeries.map(key => (
                            <div
                                key={key}
                                draggable
                                onDragStart={(e) => handleTagDragStart(e, key)}
                                className="flex items-center gap-1 px-1.5 py-0.5 bg-slate-700/50 rounded text-xs group shrink-0 cursor-grab active:cursor-grabbing"
                            >
                                <div
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: getSeriesColor(key) }}
                                />
                                <span className="text-slate-300 font-mono">{key}</span>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onRemoveSeries(node.id, key); }}
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
                        onClick={(e) => { e.stopPropagation(); onSplit(node.id, 'horizontal'); }}
                        className="p-1 hover:bg-slate-700/50 rounded text-slate-400 hover:text-cyan-400 transition-colors"
                        title="水平拆分"
                    >
                        <SplitSquareHorizontal size={14} />
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onSplit(node.id, 'vertical'); }}
                        className="p-1 hover:bg-slate-700/50 rounded text-slate-400 hover:text-cyan-400 transition-colors"
                        title="垂直拆分"
                    >
                        <SplitSquareVertical size={14} />
                    </button>
                    {canClose && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onClose(node.id); }}
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
};

export default SplittablePlotContainer;
