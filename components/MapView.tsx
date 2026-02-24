
import React, { useEffect, useRef } from 'react';
import { MapData } from '../type';

interface Props {
  data: MapData;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
};

const MapView: React.FC<Props> = ({ data }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const gridWidth = Math.max(1, data.width);
    const gridHeight = Math.max(1, data.height);
    const expectedCells = gridWidth * gridHeight;
    if (data.grid.length !== expectedCells) return;

    const scale = Math.min(canvas.width / gridWidth, canvas.height / gridHeight);
    const drawWidth = gridWidth * scale;
    const drawHeight = gridHeight * scale;
    const offsetX = (canvas.width - drawWidth) / 2;
    const offsetY = (canvas.height - drawHeight) / 2;

    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const offscreen = document.createElement('canvas');
    offscreen.width = gridWidth;
    offscreen.height = gridHeight;
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return;

    const imageData = offCtx.createImageData(gridWidth, gridHeight);
    const pixels = imageData.data;

    for (let i = 0; i < data.grid.length; i++) {
      const dist = data.grid[i];
      const offset = i * 4;

      if (dist < 0.2) {
        pixels[offset] = 239;
        pixels[offset + 1] = 68;
        pixels[offset + 2] = 68;
        pixels[offset + 3] = Math.round(clamp01(1 - dist) * 255);
      } else {
        const normalized = clamp01(dist / 4);
        const hue = 200 - normalized * 140;
        const lightness = 0.56 - normalized * 0.18;
        const [r, g, b] = hslToRgb(hue, 0.72, lightness);
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = 190;
      }
    }
    offCtx.putImageData(imageData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offscreen, 0, 0, gridWidth, gridHeight, offsetX, offsetY, drawWidth, drawHeight);

    const robotX = offsetX + (gridWidth / 2) * scale;
    const robotY = offsetY + (gridHeight / 2) * scale;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(robotX, robotY, 8, 0, Math.PI * 2);
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
