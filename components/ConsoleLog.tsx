
import React from 'react';
import { LogEntry, LogLevel } from '../type';

interface Props {
  logs: LogEntry[];
}

const ConsoleLog: React.FC<Props> = ({ logs }) => {
  const getLevelColor = (level: LogLevel) => {
    switch(level) {
      case LogLevel.ERROR: return 'text-red-400';
      case LogLevel.WARN: return 'text-amber-400';
      case LogLevel.DEBUG: return 'text-slate-500';
      default: return 'text-slate-300';
    }
  };

  return (
    <div className="flex-1 p-4 overflow-y-auto font-mono text-[11px] leading-relaxed flex flex-col-reverse">
      {logs.map((log) => (
        <div key={log.id} className="mb-1 animate-in fade-in slide-in-from-left-2 duration-300">
          <span className="text-slate-600 mr-2">[{log.time}]</span>
          <span className={`font-bold mr-2 ${getLevelColor(log.level)}`}>
            {log.level}:
          </span>
          <span className="text-slate-400">{log.message}</span>
        </div>
      ))}
    </div>
  );
};

export default ConsoleLog;
