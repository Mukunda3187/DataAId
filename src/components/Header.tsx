import React from 'react';
import { Menu, UploadCloud } from 'lucide-react';

interface HeaderProps {
  onOpenSidebar: () => void;
  onNavigateHome: () => void;
  onUploadClick: () => void;
  hasDataset?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenSidebar,
  onNavigateHome,
  onUploadClick,
  hasDataset = false
}) => {
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200/80 px-4 sm:px-8 py-3.5 flex items-center justify-between shadow-xs">
      <div className="flex items-center gap-3">
        {hasDataset && (
          <button
            onClick={onOpenSidebar}
            className="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition cursor-pointer"
            aria-label="Open sidebar"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}

        {/* Clickable Title: Navigates back to Home page */}
        <button
          onClick={onNavigateHome}
          className="text-left cursor-pointer group transition"
          title="Go to Home page"
        >
          <h1 className="text-xl font-black text-slate-900 leading-tight tracking-tight group-hover:text-[#086288] transition-colors">
            DataAId
          </h1>
        </button>
      </div>

      {/* Right side: Show upload on header after dataset uploaded */}
      <div className="flex items-center gap-3">
        {hasDataset && (
          <button
            onClick={onUploadClick}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#086288] hover:bg-[#053b53] text-white text-xs sm:text-sm font-bold shadow-xs transition cursor-pointer"
          >
            <UploadCloud className="w-4 h-4 text-[#97D7FF]" />
            <span>Upload Dataset</span>
          </button>
        )}
      </div>
    </header>
  );
};
