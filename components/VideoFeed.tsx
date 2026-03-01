import React, { useEffect, useMemo, useState } from 'react';
import { useDataContext } from './DataContext';

const REFRESH_INTERVAL_MS = 120;

const VideoFeed: React.FC = () => {
  const { isConnected } = useDataContext();
  const [nonce, setNonce] = useState<number>(() => Date.now());
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    if (!isConnected) {
      setFrameReady(false);
      return;
    }

    const timer = window.setInterval(() => {
      setNonce(Date.now());
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isConnected]);

  const frameSrc = useMemo(() => `/api/video/latest?ts=${nonce}`, [nonce]);

  return (
    <div className="relative w-full h-full bg-slate-950">
      {isConnected && (
        <img
          src={frameSrc}
          alt="Live Vision Frame"
          className="w-full h-full object-cover"
          onLoad={() => setFrameReady(true)}
          onError={() => setFrameReady(false)}
          draggable={false}
        />
      )}

      <div className="absolute left-2 top-2 px-2 py-1 rounded bg-slate-900/80 border border-slate-700/60 text-[10px] font-mono text-cyan-300">
        {isConnected ? (frameReady ? 'LIVE_VIDEO' : 'WAITING_FRAME') : 'BACKEND_OFFLINE'}
      </div>
    </div>
  );
};

export default VideoFeed;
