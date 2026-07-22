
// 参数类型，与 C++ vision::ParamType / Go typeName() 对应
export type ParamType = 'float' | 'int' | 'bool' | 'unknown';

// 单个参数的完整描述。由 producer 在共享内存中 declare，backend 原样透传。
// 前端不硬编码任何参数名、范围或步进——全部读自这里。
export interface ParamInfo {
  key: string;
  type: ParamType;
  value: number;
  min: number;
  max: number;
  step: number;   // 0 表示连续（slider 用 step="any"）
  unit: string;
  default: number;
}

// GET /api/params 响应（字段与 backend/main.go ParamsResponse 对齐）
export interface ParamsResponse {
  version: number;
  count: number;
  params: ParamInfo[];
}

// POST /api/control 响应：回读的参数表 + 被拒条目
// （区分「值被钳制」与「key 不存在 / 类型非法」）
export interface ControlResponse extends ParamsResponse {
  rejected: string[];
}

// 待下发的参数值，key -> 新值
export type ControlUpdate = Record<string, number | boolean>;

// GET /api/status 响应（字段与 backend/main.go StatusResponse 对齐）
export interface BackendStatus {
  timestamp: number;
  shm_attached: boolean;
  shm_valid: boolean;
  producer_alive: boolean;
  heartbeat_age_ms: number; // -1 表示未知
  param_count: number;      // 变化说明 producer 换了参数集，需重拉参数表
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
