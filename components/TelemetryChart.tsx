
import React from 'react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';
import { TelemetryPoint } from '../type';

interface Props {
  data: TelemetryPoint[];
}

const TelemetryChart: React.FC<Props> = ({ data }) => {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
        <XAxis 
          dataKey="timestamp" 
          hide 
        />
        <YAxis 
          domain={['auto', 'auto']} 
          stroke="#475569" 
          fontSize={10} 
          tickLine={false}
          axisLine={false}
        />
        <Tooltip 
          contentStyle={{ 
            backgroundColor: '#0f172a', 
            border: '1px solid #334155',
            borderRadius: '4px',
            fontSize: '10px'
          }}
          itemStyle={{ color: '#94a3b8' }}
          labelStyle={{ display: 'none' }}
        />
        <Line 
          type="monotone" 
          dataKey="ekf_x" 
          stroke="#06b6d4" 
          strokeWidth={2} 
          dot={false} 
          isAnimationActive={false}
        />
        <Line 
          type="monotone" 
          dataKey="ekf_y" 
          stroke="#10b981" 
          strokeWidth={2} 
          dot={false} 
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

export default TelemetryChart;
