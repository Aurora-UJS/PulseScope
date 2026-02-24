import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { ControlParams, DataPoint, MapData, SystemStatus, WSMessage, DataContextType, PanelNode } from '../type';

const MAX_DATA_POINTS = 240;
const RECONNECT_MAX_DELAY_MS = 6000;
const MAP_WIDTH = 100;
const MAP_HEIGHT = 100;

interface DataProviderProps {
    children: React.ReactNode;
    wsUrl?: string;
}

const generateId = () => Math.random().toString(36).substr(2, 9);

const defaultRootPanel: PanelNode = {
    id: generateId(),
    type: 'leaf',
    selectedSeries: []
};

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

const DataContext = createContext<DataContextType>({
    availableSeries: [],
    timeSeriesData: new Map(),
    mapData: defaultMapData,
    systemStatus: defaultSystemStatus,
    isConnected: false,
    sendControlUpdate: () => false,
    rootPanel: defaultRootPanel,
    setRootPanel: () => { },
});

export const useDataContext = () => useContext(DataContext);

export const DataProvider: React.FC<DataProviderProps> = ({
    children,
    wsUrl = 'ws://localhost:5000/ws'
}) => {
    const [availableSeries, setAvailableSeries] = useState<string[]>([]);
    const [timeSeriesData, setTimeSeriesData] = useState<Map<string, DataPoint[]>>(new Map());
    const [mapData, setMapData] = useState<MapData>(defaultMapData);
    const [systemStatus, setSystemStatus] = useState<SystemStatus>(defaultSystemStatus);
    const [isConnected, setIsConnected] = useState(false);
    const [rootPanel, setRootPanel] = useState<PanelNode>(defaultRootPanel);

    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<number | null>(null);
    const reconnectAttemptRef = useRef(0);
    const mockDataTimerRef = useRef<number | null>(null);
    const mockMapTimerRef = useRef<number | null>(null);
    const isDisposedRef = useRef(false);
    const knownSeriesRef = useRef<Set<string>>(new Set());

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

    const stopMockMode = useCallback(() => {
        if (mockDataTimerRef.current !== null) {
            window.clearInterval(mockDataTimerRef.current);
            mockDataTimerRef.current = null;
        }
        if (mockMapTimerRef.current !== null) {
            window.clearInterval(mockMapTimerRef.current);
            mockMapTimerRef.current = null;
        }
    }, []);

    // 后端不可达时使用本地模拟，确保 UI 在高负载工况下也可验证。
    const startMockMode = useCallback(() => {
        if (mockDataTimerRef.current !== null) return;

        const mockSeries = [
            'ekf_x', 'ekf_y', 'target_dist', 'fps', 'latency', 'pid_error',
            'gimbal_yaw', 'gimbal_pitch', 'pid_p', 'pid_i', 'pid_d', 'exposure', 'fire_enabled'
        ];
        for (let i = 0; i < 16; i++) {
            mockSeries.push(`stress_${i}`);
        }
        mergeSeriesCatalog(mockSeries);

        mockDataTimerRef.current = window.setInterval(() => {
            const now = Date.now();
            setTimeSeriesData(prev => {
                const newMap = new Map(prev);
                mockSeries.forEach((key, idx) => {
                    const existingData = newMap.get(key) || [];
                    let newValue: number;

                    switch (key) {
                        case 'ekf_x':
                            newValue = Math.sin(now / 500) * 10 + 20 + Math.random();
                            break;
                        case 'ekf_y':
                            newValue = Math.cos(now / 700) * 15 + 30 + Math.random();
                            break;
                        case 'target_dist':
                            newValue = 2.5 + Math.random() * 0.5;
                            break;
                        case 'fps':
                            newValue = 180 + Math.floor(Math.random() * 40);
                            break;
                        case 'latency':
                            newValue = 0.5 + Math.random() * 0.2;
                            break;
                        case 'pid_error':
                            newValue = Math.sin(now / 300) * 5 + Math.random() * 2;
                            break;
                        case 'gimbal_yaw':
                            newValue = Math.sin(now / 1000) * 30;
                            break;
                        case 'gimbal_pitch':
                            newValue = Math.cos(now / 800) * 15;
                            break;
                        case 'pid_p':
                            newValue = 1.2 + Math.sin(now / 3000) * 0.2;
                            break;
                        case 'pid_i':
                            newValue = 0.05 + Math.cos(now / 5000) * 0.02;
                            break;
                        case 'pid_d':
                            newValue = 0.1 + Math.sin(now / 4200) * 0.03;
                            break;
                        case 'exposure':
                            newValue = 4500 + Math.abs(Math.sin(now / 2000)) * 3000;
                            break;
                        case 'fire_enabled':
                            newValue = Math.sin(now / 2400) > 0 ? 1 : 0;
                            break;
                        default:
                            newValue = Math.sin(now / (120 + idx * 15) + idx) * (1 + (idx % 5));
                    }

                    const nextSeries = existingData.length >= MAX_DATA_POINTS
                        ? existingData.slice(existingData.length - (MAX_DATA_POINTS - 1))
                        : existingData.slice();
                    nextSeries.push({ timestamp: now, value: newValue });
                    newMap.set(key, nextSeries);
                });
                return newMap;
            });
        }, 50);

        mockMapTimerRef.current = window.setInterval(() => {
            const now = Date.now();
            const grid = new Array(MAP_WIDTH * MAP_HEIGHT);
            for (let idx = 0; idx < grid.length; idx++) {
                const x = idx % MAP_WIDTH;
                const y = Math.floor(idx / MAP_WIDTH);
                const cx = 50 + Math.sin(now / 900) * 18;
                const cy = 45 + Math.cos(now / 700) * 14;
                const d = Math.hypot(x - cx, y - cy) / 18;
                const wave = 0.35 + 0.2 * Math.sin(now / 600 + x * 0.08) + 0.12 * Math.cos(now / 800 + y * 0.07);
                grid[idx] = Math.max(0, Math.min(4, d + wave));
            }
            setMapData({
                width: MAP_WIDTH,
                height: MAP_HEIGHT,
                grid
            });
        }, 120);

        setSystemStatus(prev => ({
            ...prev,
            backendConnected: false,
            shmActive: false
        }));
    }, [mergeSeriesCatalog]);

    const sendControlUpdate = useCallback((payload: Partial<ControlParams>): boolean => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        ws.send(JSON.stringify(payload));
        return true;
    }, []);

    useEffect(() => {
        isDisposedRef.current = false;

        const connectWebSocket = () => {
            if (isDisposedRef.current) return;

            try {
                const ws = new WebSocket(wsUrl);
                wsRef.current = ws;

                ws.onopen = () => {
                    reconnectAttemptRef.current = 0;
                    setIsConnected(true);
                    setSystemStatus(prev => ({ ...prev, backendConnected: true }));
                    stopMockMode();
                };

                ws.onmessage = (event) => {
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

                        mergeSeriesCatalog(entries.map(([key]) => key));
                        setTimeSeriesData(prev => {
                            const next = new Map(prev);
                            entries.forEach(([key, value]) => {
                                const existingData = next.get(key) || [];
                                const nextSeries = existingData.length >= MAX_DATA_POINTS
                                    ? existingData.slice(existingData.length - (MAX_DATA_POINTS - 1))
                                    : existingData.slice();
                                nextSeries.push({ timestamp: message.timestamp, value });
                                next.set(key, nextSeries);
                            });
                            return next;
                        });
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
                    startMockMode();

                    if (isDisposedRef.current) return;
                    reconnectAttemptRef.current += 1;
                    const delay = Math.min(
                        RECONNECT_MAX_DELAY_MS,
                        500 * Math.pow(2, Math.min(reconnectAttemptRef.current, 4))
                    );
                    if (reconnectTimerRef.current !== null) {
                        window.clearTimeout(reconnectTimerRef.current);
                    }
                    reconnectTimerRef.current = window.setTimeout(connectWebSocket, delay);
                };

                ws.onerror = () => {
                    ws.close();
                };
            } catch {
                startMockMode();
            }
        };

        connectWebSocket();

        return () => {
            isDisposedRef.current = true;
            if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            stopMockMode();
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [mergeSeriesCatalog, startMockMode, stopMockMode, wsUrl]);

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
                setRootPanel
            }}
        >
            {children}
        </DataContext.Provider>
    );
};

export default DataContext;
