
import React, { useEffect, useRef } from 'react';
import { MapData } from '../type';

interface Props {
  data: MapData;
}

const MapView: React.FC<Props> = ({ data }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scale = Math.min(canvas.width / data.width, canvas.height / data.height);
    
    // Clear canvas
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Render ESDF Grid
    data.grid.forEach((dist, i) => {
      const x = i % data.width;
      const y = Math.floor(i / data.width);
      
      // Map distance to color: 0 (black/obstacle) -> high (blue/free)
      const hue = Math.min(200, dist * 100);
      const alpha = Math.max(0.1, 1 - dist);
      
      if (dist < 0.2) {
        ctx.fillStyle = `rgba(239, 68, 68, ${1 - dist})`; // Red for obstacles
      } else {
        ctx.fillStyle = `hsla(${hue}, 70%, 50%, 0.4)`;
      }

      ctx.fillRect(x * scale, y * scale, scale, scale);
    });

    // Draw Robot Marker
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(50 * scale, 50 * scale, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2;
    ctx.stroke();

  }, [data]);

  return (
    <div className="w-full h-full flex items-center justify-center bg-slate-950 p-4">
      <div className="relative border border-slate-800 rounded-lg shadow-2xl shadow-cyan-950/20 overflow-hidden">
        <canvas ref={canvasRef} width={600} height={600} className="w-full aspect-square max-h-[70vh]" />
        <div className="absolute top-4 left-4 flex flex-col gap-2">
           <div className="flex items-center gap-2 text-[10px] text-slate-400">
             <div className="w-3 h-3 bg-red-500 rounded-sm"></div> Obstacle
           </div>
           <div className="flex items-center gap-2 text-[10px] text-slate-400">
             <div className="w-3 h-3 bg-cyan-500 rounded-sm"></div> Safe Zone
           </div>
        </div>
      </div>
    </div>
  );
};

export default MapView;
