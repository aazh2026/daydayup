import React from 'react';
import type { AppPage, Student } from '../types.ts';

interface TopBarProps {
  activePage: AppPage;
  onNavigate: (page: AppPage) => void;
  student: Student;
  onOpenProfile: () => void;
  /** 当前角色 —— teacher 时显示工作台入口 */
  role?: 'student' | 'parent' | 'teacher';
  /** 当前登录者显示名 */
  displayName?: string;
  /** 退出登录 */
  onLogout?: () => void;
}

const NAV_ITEMS: { id: AppPage; label: string }[] = [
  { id: 'today', label: '今日学习' },
  { id: 'diagnosis', label: '考试诊断' },
  { id: 'errors', label: '错题档案' },
  { id: 'knowledge', label: '知识图谱' },
  { id: 'planning', label: '提分规划' },
  { id: 'sprint', label: '30天冲刺' },
  { id: 'coach', label: 'AI教练' },
  { id: 'report', label: '提分报告' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activePage,
  onNavigate,
  student,
  onOpenProfile,
  role = 'student',
  displayName,
  onLogout,
}) => {
  const isTeacher = role === 'teacher';

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

        {/* Zone 2: navigation links */}
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
                  <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-600 rounded-full" />
                )}
              </button>
            );
          })}

          {/* 教师角色：工作台入口 */}
          {isTeacher && (
            <button
              type="button"
              onClick={() => onNavigate('teacher')}
              className={`relative py-5 text-sm font-medium whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                activePage === 'teacher'
                  ? 'text-blue-700'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              教师工作台
              {activePage === 'teacher' && (
                <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-600 rounded-full" />
              )}
            </button>
          )}

          {/* 教师角色：AI 配置入口 */}
          {isTeacher && (
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className={`relative py-5 text-sm font-medium whitespace-nowrap shrink-0 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                activePage === 'settings'
                  ? 'text-blue-700'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              AI配置
              {activePage === 'settings' && (
                <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-600 rounded-full" />
              )}
            </button>
          )}
        </nav>

        {/* Zone 3: user badge */}
        <div className="flex items-center gap-3 shrink-0">
          {isTeacher && (
            <span className="hidden lg:inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-100">
              教师
            </span>
          )}
          <button
            type="button"
            onClick={onOpenProfile}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap"
          >
            <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center">
              {(displayName ?? student.name ?? '学').slice(0, 1)}
            </span>
            {displayName ?? student.name} · 初三档案
          </button>
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="text-xs text-slate-400 hover:text-slate-700 transition-colors whitespace-nowrap"
            >
              退出
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
