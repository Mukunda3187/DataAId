import React from 'react';
import {
  LayoutDashboard,
  Wrench,
  FileText,
  Database,
  X
} from 'lucide-react';

export type ActivePage = 'overview' | 'corrections' | 'report';

interface SidebarProps {
  activePage: ActivePage;
  onSelectPage: (page: ActivePage) => void;
  isOpen: boolean;
  onClose: () => void;
  unresolvedCount: number;
  width: number;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeEnd: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activePage,
  onSelectPage,
  isOpen,
  onClose,
  unresolvedCount,
  width,
  onResizeStart,
  onResizeMove,
  onResizeEnd
}) => {
  const navItems = [
    { id: 'overview' as ActivePage, label: 'Home', icon: LayoutDashboard },
    { id: 'corrections' as ActivePage, label: 'Correction Center', icon: Wrench, badge: unresolvedCount > 0 ? unresolvedCount : undefined },
    { id: 'report' as ActivePage, label: 'Report', icon: FileText }
  ];

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        style={{ width: `${width}px` }}
        className={`fixed top-0 bottom-0 left-0 z-50 bg-[#086288] text-white flex flex-col shadow-xl transition-transform duration-300 ease-in-out lg:translate-x-0 ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="p-5 border-b border-white/10 flex items-center justify-between min-w-0">
          <button
            onClick={() => { onSelectPage('overview'); onClose(); }}
            className="flex items-center gap-3 text-left cursor-pointer group min-w-0"
            title="Go to Home page"
          >
            <div className="w-10 h-10 shrink-0 rounded-xl bg-white flex items-center justify-center shadow-md group-hover:scale-105 transition-transform">
              <Database className="w-5 h-5 text-[#086288]" />
            </div>
            <span className="font-extrabold text-xl tracking-tight text-white truncate group-hover:text-[#97D7FF] transition-colors">DataAId</span>
          </button>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition cursor-pointer"
            aria-label="Close sidebar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto overflow-x-hidden">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => { onSelectPage(item.id); onClose(); }}
                title={item.label}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${isActive ? 'bg-white text-[#086288] shadow-sm font-semibold' : 'text-white/85 hover:bg-white/10 hover:text-white'}`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-[#086288]' : 'text-[#97D7FF]'}`} />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <span className={`shrink-0 text-[11px] font-bold px-2 py-0.5 rounded-full ${isActive ? 'bg-[#086288] text-white' : 'bg-[#FFEFC4] text-[#086288]'}`}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Desktop resize handle. Drag left to make the sidebar narrower. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar; drag left to make it narrower"
          title="Drag left to narrow the sidebar"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          className="hidden lg:flex absolute top-0 right-0 h-full w-2 translate-x-1/2 cursor-col-resize items-center justify-center z-[60] touch-none group"
        >
          <div className="h-full w-px bg-white/20 group-hover:bg-white/80 group-active:bg-white transition-colors" />
          <div className="absolute top-1/2 -translate-y-1/2 h-12 w-1 rounded-full bg-white/40 group-hover:bg-white shadow-sm" />
        </div>
      </aside>
    </>
  );
};
