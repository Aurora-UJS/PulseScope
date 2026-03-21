import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { ControlParams, DataPoint, MapData, SystemStatus, WSMessage, DataContextType, PanelNode } from '../type';

const MAX_DATA_POINTS = 240;
const RECONNECT_MAX_DELAY_MS = 6000;
const MAP_WIDTH = 100;
const MAP_HEIGHT = 100;
const VIDEO_FRAME_MAGIC = 0x56494400; // "VID\0"

const LAYOUT_STORAGE_KEY = 'pulsescope_panel_layout';

interface DataProviderProps {
    children: React.ReactNode;
    wsUrl?: string;
}

const generateId = () => Math.random().toString(36).substr(2, 9);

function loadSavedLayout(): PanelNode {
    try {
        const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as PanelNode;
            if (parsed && parsed.id && parsed.type) return parsed;
        }
    } catch { /* ignore */ }
    return { id: generateId(), type: 'leaf', selectedSeries: [] };
}

function findFirstLeafId(node: PanelNode): string | null {
    if (node.type === 'leaf') return node.id;
    if (node.children) {
        for (const child of node.children) {
            const id = findFirstLeafId(child);
            if (id) return id;
        }
    }
    return null;
}

function addSeriesToNode(root: PanelNode, panelId: string, seriesKey: string): PanelNode {
    if (root.id === panelId && root.type === 'leaf') {
        const current = root.selectedSeries || [];
        if (current.includes(seriesKey)) return root;
        return { ...root, selectedSeries: [...current, seriesKey] };
    }
    if (root.type === 'split' && root.children) {
        return { ...root, children: root.children.map(c => addSeriesToNode(c, panelId, seriesKey)) };
    }
    return root;
}

const defaultMapData: MapData = {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    grid: Array(MAP_WIDTH * MAP_HEIGHT).fill(0)
};

const defaultSystemStatus: SystemStatus = {
    backendConnected: false,
    shmActive: false,
    serialPort: '/dev/ttyACM0',
    nucCpuLoad: 0,
    nucTemp: 0
};

function getDefaultWsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
}

const DataContext = createContext<DataContextType>({
    availableSeries: [],
    timeSeriesData: new Map(),
    mapData: defaultMapData,
    systemStatus: defaultSystemStatus,
    isConnected: false,
    sendControlUpdate: () => false,
    rootPanel: { id: '', type: 'leaf', selectedSeries: [] },
    setRootPanel: () => { },
    videoFrameUrl: null,
    videoFps: 0,
    activePanelId: null,
    setActivePanelId: () => { },
    addSeriesToActivePanel: () => { },
});

export const useDataContext = () => useContext(DataContext);

export const DataProvider: React.FC<DataProviderProps> = ({
    children,
    wsUrl
}) => {
    const [availableSeries, setAvailableSeries] = useState<string[]>([]);
    const [timeSeriesData, setTimeSeriesData] = useState<Map<string, DataPoint[]>>(new Map());
    const [mapData, setMapData] = useState<MapData>(defaultMapData);
    const [systemStatus, setSystemStatus] = useState<SystemStatus>(defaultSystemStatus);
    const [isConnected, setIsConnected] = useState(false);
    const [rootPanel, setRootPanel] = useState<PanelNode>(loadSavedLayout);
    const [videoFrameUrl, setVideoFrameUrl] = useState<string | null>(null);
    const [videoFps, setVideoFps] = useState(0);
    const [activePanelId, setActivePanelIdState] = useState<string | null>(() => findFirstLeafId(loadSavedLayout()));

    // 面板布局持久化到 localStorage
    useEffect(() => {
        try {
            localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(rootPanel));
        } catch { /* quota exceeded etc. */ }
    }, [rootPanel]);

    const setActivePanelId = useCallback((id: string) => {
        setActivePanelIdState(id);
    }, []);

    const addSeriesToActivePanel = useCallback((seriesKey: string) => {
        setRootPanel(prev => {
            const targetId = activePanelId || findFirstLeafId(prev);
            if (!targetId) return prev;
            return addSeriesToNode(prev, targetId, seriesKey);
        });
    }, [activePanelId]);

    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<number | null>(null);
    const reconnectAttemptRef = useRef(0);
    const isDisposedRef = useRef(false);
    const knownSeriesRef = useRef<Set<string>>(new Set());
    const prevVideoUrlRef = useRef<string | null>(null);

    // 视频帧率计数
    const videoFrameCountRef = useRef(0);
    const videoFpsTimerRef = useRef<number>(0);

    // rAF 批量更新缓冲
    const pendingDataRef = useRef<{ timestamp: number; series: Record<string, number> }[]>([]);
    const pendingSeriesKeysRef = useRef<string[]>([]);
    const rafRef = useRef<number>(0);

    const mergeSeriesCatalog = useCallback((keys: string[]) => {
        let dirty = false;
        const known = knownSeriesRef.current;
        keys.forEach(key => {
            if (!known.has(key)) {
                known.add(key);
                dirty = true;
            }
        });
        if (dirty) {
            setAvailableSeries(Array.from(known).sort());
        }
    }, []);

    const flushBatch = useCallback(() => {
        rafRef.current = 0;
        const batch = pendingDataRef.current;
        const newKeys = pendingSeriesKeysRef.current;
        pendingDataRef.current = [];
        pendingSeriesKeysRef.current = [];
        if (batch.length === 0) return;

        if (newKeys.length > 0) {
            mergeSeriesCatalog(newKeys);
        }

        setTimeSeriesData(prev => {
            const next = new Map(prev);
            for (const msg of batch) {
                for (const [key, value] of Object.entries(msg.series)) {
                    if (!Number.isFinite(value)) continue;
                    const arr = next.get(key);
                    if (arr) {
                        arr.push({ timestamp: msg.timestamp, value });
                        while (arr.length > MAX_DATA_POINTS) arr.shift();
                    } else {
                        next.set(key, [{ timestamp: msg.timestamp, value }]);
                    }
                }
            }
            return next;
        });
    }, [mergeSeriesCatalog]);

    const scheduleFlush = useCallback(() => {
        if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(flushBatch);
        }
    }, [flushBatch]);

    const handleVideoFrame = useCallback((buffer: ArrayBuffer) => {
        if (buffer.byteLength < 16) return;
        const view = new DataView(buffer);
        const magic = view.getUint32(0, true);
        if (magic !== VIDEO_FRAME_MAGIC) return;

        videoFrameCountRef.current++;

        const jpegData = buffer.slice(16);
        const blob = new Blob([jpegData], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);

        if (prevVideoUrlRef.current) {
            URL.revokeObjectURL(prevVideoUrlRef.current);
        }
        prevVideoUrlRef.current = url;
        setVideoFrameUrl(url);
    }, []);

    const sendControlUpdate = useCallback((payload: Partial<ControlParams>): boolean => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return false;
        }

        try {
            ws.send(JSON.stringify(payload));
            return true;
        } catch {
            return false;
        }
    }, []);

    useEffect(() => {
        isDisposedRef.current = false;
        const resolvedWsUrl = wsUrl || getDefaultWsUrl();

        // 每秒统计实际接收视频帧率
        videoFrameCountRef.current = 0;
        videoFpsTimerRef.current = window.setInterval(() => {
            setVideoFps(videoFrameCountRef.current);
            videoFrameCountRef.current = 0;
        }, 1000);

        const scheduleReconnect = (connectFn: () => void) => {
            if (isDisposedRef.current) return;

            reconnectAttemptRef.current += 1;
            const delay = Math.min(
                RECONNECT_MAX_DELAY_MS,
                500 * Math.pow(2, Math.min(reconnectAttemptRef.current, 4))
            );

            if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
            }
            reconnectTimerRef.current = window.setTimeout(connectFn, delay);
        };

        const connectWebSocket = () => {
            if (isDisposedRef.current) return;

            try {
                const ws = new WebSocket(resolvedWsUrl);
                ws.binaryType = 'arraybuffer';
                wsRef.current = ws;

                ws.onopen = () => {
                    reconnectAttemptRef.current = 0;
                    setIsConnected(true);
                    setSystemStatus(prev => ({ ...prev, backendConnected: true }));
                };

                ws.onmessage = (event) => {
                    // 二进制消息 → 视频帧
                    if (event.data instanceof ArrayBuffer) {
                        handleVideoFrame(event.data);
                        return;
                    }

                    let message: WSMessage;
                    try {
                        message = JSON.parse(event.data) as WSMessage;
                    } catch {
                        return;
                    }

                    if (message.type === 'metadata') {
                        mergeSeriesCatalog(message.available_series);
                        return;
                    }

                    if (message.type === 'data') {
                        const entries = Object.entries(message.series).filter(([, value]) => Number.isFinite(value));
                        if (entries.length === 0) return;

                        // 收集新 series key
                        const known = knownSeriesRef.current;
                        for (const [key] of entries) {
                            if (!known.has(key)) {
                                pendingSeriesKeysRef.current.push(key);
                            }
                        }

                        pendingDataRef.current.push({ timestamp: message.timestamp, series: message.series });
                        scheduleFlush();
                        return;
                    }

                    if (message.type === 'map') {
                        if (message.grid.length === message.width * message.height) {
                            setMapData({
                                width: message.width,
                                height: message.height,
                                grid: message.grid
                            });
                        }
                        return;
                    }

                    if (message.type === 'status') {
                        setSystemStatus({
                            backendConnected: message.backend_connected,
                            shmActive: message.shm_active,
                            serialPort: message.serial_port || '/dev/ttyACM0',
                            nucCpuLoad: message.nuc_cpu_load,
                            nucTemp: message.nuc_temp
                        });
                    }
                };

                ws.onclose = () => {
                    if (wsRef.current === ws) {
                        wsRef.current = null;
                    }
                    setIsConnected(false);
                    setSystemStatus(prev => ({ ...prev, backendConnected: false, shmActive: false }));
                    scheduleReconnect(connectWebSocket);
                };

                ws.onerror = () => {
                    ws.close();
                };
            } catch {
                setIsConnected(false);
                setSystemStatus(prev => ({ ...prev, backendConnected: false, shmActive: false }));
                scheduleReconnect(connectWebSocket);
            }
        };

        connectWebSocket();

        return () => {
            isDisposedRef.current = true;
            if (videoFpsTimerRef.current) {
                window.clearInterval(videoFpsTimerRef.current);
                videoFpsTimerRef.current = 0;
            }
            if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = 0;
            }
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            if (prevVideoUrlRef.current) {
                URL.revokeObjectURL(prevVideoUrlRef.current);
                prevVideoUrlRef.current = null;
            }
        };
    }, [mergeSeriesCatalog, wsUrl, handleVideoFrame, scheduleFlush]);

    return (
        <DataContext.Provider
            value={{
                availableSeries,
                timeSeriesData,
                mapData,
                systemStatus,
                isConnected,
                sendControlUpdate,
                rootPanel,
                setRootPanel,
                videoFrameUrl,
                videoFps,
                activePanelId,
                setActivePanelId,
                addSeriesToActivePanel,
            }}
        >
            {children}
        </DataContext.Provider>
    );
};

export default DataContext;
