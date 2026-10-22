import React from 'react';
import { 
  LayoutDashboard, 
  Wrench, 
  FileText,
  Database,
  X
} from 'lucide-react';

export type ActivePage = 
  | 'overview' 
  | 'corrections'
  | 'report';

interface SidebarProps {
  activePage: ActivePage;
  onSelectPage: (page: ActivePage) => void;
  isOpen: boolean;
  onClose: () => void;
  unresolvedCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activePage,
  onSelectPage,
  isOpen,
  onClose,
  unresolvedCount
}) => {
  const navItems = [
    { 
      id: 'overview' as ActivePage, 
      label: 'Home', 
      icon: LayoutDashboard,
      onClick: () => onSelectPage('overview')
    },
    { 
      id: 'corrections' as ActivePage, 
      label: 'Correction Center', 
      icon: Wrench,
      badge: unresolvedCount > 0 ? unresolvedCount : undefined,
      onClick: () => onSelectPage('corrections')
    },
    { 
      id: 'report' as ActivePage, 
      label: 'Report', 
      icon: FileText,
      onClick: () => onSelectPage('report')
    },
  ];

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar Container */}
      <aside 
        className={`fixed top-0 bottom-0 left-0 z-50 w-72 bg-[#086288] text-white flex flex-col shadow-xl transition-transform duration-300 ease-in-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand Header */}
        <div className="p-5 border-b border-white/10 flex items-center justify-between">
          <button 
            onClick={() => {
              onSelectPage('overview');
              onClose();
            }}
            className="flex items-center gap-3 text-left cursor-pointer group"
            title="Go to Home page"
          >
            <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center shadow-md group-hover:scale-105 transition-transform">
              <Database className="w-5 h-5 text-[#086288]" />
            </div>
            <div>
              <span className="font-extrabold text-xl tracking-tight text-white block group-hover:text-[#97D7FF] transition-colors">DataAId</span>
            </div>
          </button>
          <button 
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;

            return (
              <button
                key={item.label}
                onClick={() => {
                  item.onClick();
                  onClose();
                }}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-white text-[#086288] shadow-sm font-semibold'
                    : 'text-white/85 hover:bg-white/10 hover:text-white'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-[#086288]' : 'text-[#97D7FF]'}`} />
                  <span>{item.label}</span>
                </div>
                {item.badge !== undefined && (
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                    isActive ? 'bg-[#086288] text-white' : 'bg-[#FFEFC4] text-[#086288]'
                  }`}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </aside>
    </>
  );
};
