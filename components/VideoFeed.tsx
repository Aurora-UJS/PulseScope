
import React, { useEffect, useRef } from 'react';

const VideoFeed: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 自适应容器大小
    const resizeCanvas = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    let animationFrameId: number;
    let frameCount = 0;

    const render = () => {
      frameCount++;
      const w = canvas.width;
      const h = canvas.height;

      // Draw background noise/gradient to simulate camera noise
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, w, h);
      
      // Simulate "Real-time" camera artifacts
      for (let i = 0; i < 50; i++) {
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.05})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
      }

      // Draw Aiming Crosshair / Detection Box
      const centerX = w / 2 + Math.sin(frameCount / 20) * 100;
      const centerY = h / 2 + Math.cos(frameCount / 30) * 50;
      
      // Detection Box
      ctx.strokeStyle = '#22d3ee'; // cyan-400
      ctx.lineWidth = 2;
      ctx.strokeRect(centerX - 40, centerY - 25, 80, 50);
      
      // ID Label
      ctx.fillStyle = '#22d3ee';
      ctx.font = '10px monospace';
      ctx.fillText(`TARGET_ID: 1_ARMOR`, centerX - 40, centerY - 30);
      ctx.fillText(`CONF: 0.98`, centerX + 5, centerY - 30);

      // Scanning lines
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(w, centerY);
      ctx.stroke();

      // UI Overlay Grid
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.3)';
      ctx.lineWidth = 0.5;
      for(let i = 0; i < w; i += 50) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke();
      }
      for(let j = 0; j < h; j += 50) {
        ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(w, j); ctx.stroke();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resizeCanvas);
    };
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas 
        ref={canvasRef} 
        className="w-full h-full"
      />
    </div>
  );
};

export default VideoFeed;
