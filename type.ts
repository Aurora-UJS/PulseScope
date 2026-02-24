
export interface TelemetryPoint {
  timestamp: number;
  ekf_x: number;
  ekf_y: number;
  target_dist: number;
  fps: number;
  latency: number;
}

export interface MapData {
  grid: number[]; // ESDF distance values
  width: number;
  height: number;
}

export interface ControlParams {
  pid_p: number;
  pid_i: number;
  pid_d: number;
  exposure: number;
  fire_enabled: boolean;
}

export interface SystemStatus {
  backendConnected: boolean;
  shmActive: boolean;
  serialPort: string;
  nucCpuLoad: number;
  nucTemp: number;
}

export enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG'
}

export interface LogEntry {
  id: string;
  level: LogLevel;
  message: string;
  time: string;
}

// Dynamic Data System Types
export interface DataPoint {
  timestamp: number;
  value: number;
}

export interface WSMetadataMessage {
  type: 'metadata';
  available_series: string[];
}

export interface WSDataMessage {
  type: 'data';
  timestamp: number;
  series: Record<string, number>;
}

export interface WSMapMessage {
  type: 'map';
  timestamp: number;
  width: number;
  height: number;
  grid: number[];
}

export interface WSStatusMessage {
  type: 'status';
  timestamp: number;
  backend_connected: boolean;
  shm_active: boolean;
  serial_port: string;
  nuc_cpu_load: number;
  nuc_temp: number;
}

export type WSMessage = WSMetadataMessage | WSDataMessage | WSMapMessage | WSStatusMessage;

// Panel Layout Types
export interface PanelNode {
  id: string;
  type: 'leaf' | 'split';
  direction?: 'horizontal' | 'vertical';
  children?: PanelNode[];
  ratio?: number;
  selectedSeries?: string[];
}

export interface DataContextType {
  availableSeries: string[];
  timeSeriesData: Map<string, DataPoint[]>;
  mapData: MapData;
  systemStatus: SystemStatus;
  isConnected: boolean;
  sendControlUpdate: (payload: Partial<ControlParams>) => boolean;
  rootPanel: PanelNode;
  setRootPanel: React.Dispatch<React.SetStateAction<PanelNode>>;
}
