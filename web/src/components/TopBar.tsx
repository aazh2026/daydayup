import React from 'react';
import type { AppPage, Student } from '../types.ts';

interface TopBarProps {
  activePage: AppPage;
  onNavigate: (page: AppPage) => void;
  student: Student;
  onOpenProfile: () => void;
}

const NAV_ITEMS: { id: AppPage; label: string }[] = [
  { id: 'today', label: '今日学习' },
  { id: 'diagnosis', label: '考试诊断' },
  { id: 'planning', label: '提分规划' },
  { id: 'coach', label: 'AI教练' },
  { id: 'report', label: '提分报告' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activePage,
  onNavigate,
  student,
  onOpenProfile,
}) => {
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line Brand Title */}
        <button
          type="button"
          onClick={() => onNavigate('today')}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
        >
          智学中枢
        </button>

        {/* Zone 2: 5 concise single-line navigation links */}
        <nav
          aria-label="主导航"
          className="hidden md:flex items-center gap-7"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`relative py-5 text-sm font-medium whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                  isActive
                    ? 'text-blue-700'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-700"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={onOpenProfile}
            className="px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            {student.name} · {student.grade}档案
          </button>
        </div>
      </div>

      {/* Mobile horizontal navigation bar */}
      <nav
        aria-label="移动端导航"
        className="md:hidden border-t border-slate-100 px-3 flex items-center justify-between overflow-x-auto"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activePage === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`py-2.5 px-2 text-xs font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors ${
                isActive
                  ? 'border-blue-700 text-blue-700'
                  : 'border-transparent text-slate-600'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
};
