
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
