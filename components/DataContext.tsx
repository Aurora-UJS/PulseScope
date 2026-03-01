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
                const ws = new WebSocket(wsUrl);
                wsRef.current = ws;

                ws.onopen = () => {
                    reconnectAttemptRef.current = 0;
                    setIsConnected(true);
                    setSystemStatus(prev => ({ ...prev, backendConnected: true }));
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
            if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [mergeSeriesCatalog, wsUrl]);

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
