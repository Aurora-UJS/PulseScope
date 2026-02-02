
import React, { ReactNode } from 'react';

interface StatusCardProps {
  label: string;
  value: string | number;
  subValue: string;
  icon: ReactNode;
}

const StatusCard: React.FC<StatusCardProps> = ({ label, value, subValue, icon }) => {
  return (
    <div className="bg-slate-900/40 border border-slate-800/50 rounded-lg p-3 hover:border-slate-700/50 transition-all group">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-slate-800 rounded-md group-hover:scale-110 transition-transform">
          {icon}
        </div>
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-bold text-slate-100">{value}</span>
        <span className="text-[9px] text-slate-500 font-medium truncate">{subValue}</span>
      </div>
    </div>
  );
};

export default StatusCard;
