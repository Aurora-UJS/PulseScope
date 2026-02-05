import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { DataPoint, WSMessage, DataContextType } from '../type';

const MAX_DATA_POINTS = 200;

interface DataProviderProps {
    children: React.ReactNode;
    wsUrl?: string;
}

const DataContext = createContext<DataContextType>({
    availableSeries: [],
    timeSeriesData: new Map(),
    isConnected: false,
});

export const useDataContext = () => useContext(DataContext);

export const DataProvider: React.FC<DataProviderProps> = ({
    children,
    wsUrl = 'ws://localhost:5000/ws'
}) => {
    const [availableSeries, setAvailableSeries] = useState<string[]>([]);
    const [timeSeriesData, setTimeSeriesData] = useState<Map<string, DataPoint[]>>(new Map());
    const [isConnected, setIsConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);

    // 模拟数据生成（当没有后端连接时）
    const generateMockData = useCallback(() => {
        const mockSeries = ['ekf_x', 'ekf_y', 'target_dist', 'fps', 'latency', 'pid_error', 'gimbal_yaw', 'gimbal_pitch'];
        setAvailableSeries(mockSeries);

        const interval = setInterval(() => {
            const now = Date.now();
            setTimeSeriesData(prev => {
                const newMap = new Map(prev);
                mockSeries.forEach(key => {
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
                        default:
                            newValue = Math.random() * 10;
                    }

                    const newData = [...existingData, { timestamp: now, value: newValue }];
                    newMap.set(key, newData.slice(-MAX_DATA_POINTS));
                });
                return newMap;
            });
        }, 50);

        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        // 尝试连接 WebSocket
        const connectWebSocket = () => {
            try {
                const ws = new WebSocket(wsUrl);
                wsRef.current = ws;

                ws.onopen = () => {
                    console.log('WebSocket connected');
                    setIsConnected(true);
                };

                ws.onmessage = (event) => {
                    try {
                        const message: WSMessage = JSON.parse(event.data);

                        if (message.type === 'metadata') {
                            setAvailableSeries(message.available_series);
                        } else if (message.type === 'data') {
                            setTimeSeriesData(prev => {
                                const newMap = new Map(prev);
                                Object.entries(message.series).forEach(([key, value]) => {
                                    const existingData = newMap.get(key) || [];
                                    const newData = [...existingData, { timestamp: message.timestamp, value }];
                                    newMap.set(key, newData.slice(-MAX_DATA_POINTS));
                                });
                                return newMap;
                            });

                            // 更新可用系列列表
                            const currentKeys = Object.keys(message.series);
                            setAvailableSeries(prev => {
                                const combined = new Set([...prev, ...currentKeys]);
                                return Array.from(combined).sort();
                            });
                        }
                    } catch (e) {
                        console.error('Failed to parse WS message', e);
                    }
                };

                ws.onclose = () => {
                    console.log('WebSocket disconnected, using mock data');
                    setIsConnected(false);
                    wsRef.current = null;
                };

                ws.onerror = () => {
                    console.log('WebSocket error, falling back to mock data');
                    ws.close();
                };
            } catch (e) {
                console.log('Failed to connect WebSocket, using mock data');
            }
        };

        connectWebSocket();

        // 如果1秒内未连接成功，启用模拟数据
        const mockTimeout = setTimeout(() => {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
                console.log('Using mock data mode');
                generateMockData();
            }
        }, 1000);

        return () => {
            clearTimeout(mockTimeout);
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, [wsUrl, generateMockData]);

    return (
        <DataContext.Provider value={{ availableSeries, timeSeriesData, isConnected }}>
            {children}
        </DataContext.Provider>
    );
};

export default DataContext;
