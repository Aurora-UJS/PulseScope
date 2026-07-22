
export interface ControlParams {
  pid_p: number;
  pid_i: number;
  pid_d: number;
  exposure: number;
  fire_enabled: boolean;
}

// GET /api/status 响应（字段与 backend/main.go StatusResponse 对齐）
export interface BackendStatus {
  timestamp: number;
  shm_attached: boolean;
  shm_valid: boolean;
  producer_alive: boolean;
  heartbeat_age_ms: number; // -1 表示未知
  nuc_cpu_load: number;
  nuc_temp: number;
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
