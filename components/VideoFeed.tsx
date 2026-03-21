import React from 'react';
import { useDataContext } from './DataContext';

const VideoFeed: React.FC = () => {
    const { isConnected, videoFrameUrl } = useDataContext();

    return (
        <div className="relative w-full h-full bg-slate-950">
            {videoFrameUrl && (
                <img
                    src={videoFrameUrl}
                    alt="Live Vision Frame"
                    className="w-full h-full object-cover"
                    draggable={false}
                />
            )}

            <div className="absolute left-2 top-2 px-2 py-1 rounded bg-slate-900/80 border border-slate-700/60 text-[10px] font-mono text-cyan-300">
                {isConnected ? (videoFrameUrl ? 'LIVE_VIDEO' : 'WAITING_FRAME') : 'BACKEND_OFFLINE'}
            </div>
        </div>
    );
};

export default VideoFeed;
