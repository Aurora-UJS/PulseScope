
import React from 'react';
import { 
  LayoutDashboard, 
  Navigation, 
  SlidersHorizontal, 
  Terminal, 
  HelpCircle,
  Database,
  Activity
} from 'lucide-react';
import { SystemStatus } from '../type';

interface Props {
  status: SystemStatus;
  activeTab: string;
  onTabChange: (tab: any) => void;
}

const Sidebar: React.FC<Props> = ({ status, activeTab, onTabChange }) => {
  const navItems = [
    { id: 'dashboard', icon: <LayoutDashboard size={20} />, label: 'Stats' },
    { id: 'navigation', icon: <Navigation size={20} />, label: 'Map' },
    { id: 'tuning', icon: <SlidersHorizontal size={20} />, label: 'Tune' },
  ];

  return (
    <aside className="w-16 md:w-20 bg-slate-900 flex flex-col items-center py-6 gap-8 border-r border-slate-800/50">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center shadow-lg shadow-cyan-900/20">
        <Activity size={24} className="text-white" />
      </div>

      <nav className="flex flex-col gap-4">
        {navItems.map((item) => (
          <button 
            key={item.id}
            onClick={() => onTabChange(item.id)}
            className={`p-3 rounded-xl transition-all relative group ${
              activeTab === item.id 
                ? 'bg-cyan-500/10 text-cyan-400' 
                : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
            }`}
          >
            {item.icon}
            <span className="absolute left-full ml-4 px-2 py-1 bg-slate-800 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
              {item.label}
            </span>
          </button>
        ))}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-6 pb-4">
        <div className="flex flex-col items-center gap-1">
          <div className={`w-2 h-2 rounded-full ${status.backendConnected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}`}></div>
          <span className="text-[8px] text-slate-500 font-bold tracking-tighter uppercase">Link</span>
        </div>
        <div className="flex flex-col items-center gap-1">
           <Database size={18} className={status.shmActive ? 'text-cyan-500' : 'text-slate-700'} />
           <span className="text-[8px] text-slate-500 font-bold tracking-tighter uppercase">SHM</span>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
