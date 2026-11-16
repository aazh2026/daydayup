import React, { useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import type { FatigueLevel, HomeworkLoad, Student } from '../types.ts';
import { getEffectiveDailyBudgetFallback } from '../engine/plan-fallback.ts';

interface StudentProfileModalProps {
  student: Student;
  onSave: (updated: Student) => void;
  onResetDemo: () => void;
  onClose: () => void;
}

export const StudentProfileModal: React.FC<StudentProfileModalProps> = ({
  student,
  onSave,
  onResetDemo,
  onClose,
}) => {
  const [form, setForm] = useState<Student>(student);
  /**
   * 预算预览用本地估算（保存后由服务端返回权威值）。
   * 权威预算以服务端 GET /students/:id/effective-budget 为准。
   */
  const effectiveMinutes = getEffectiveDailyBudgetFallback(form);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(form);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="student-profile-title"
    >
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 id="student-profile-title" className="text-base font-semibold text-slate-900">
              学生档案与时间约束设置
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              修改每日预算、作业负荷或目标日期后，7天提分计划将立即重排
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg transition-colors"
            aria-label="关闭档案设置"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                学生姓名
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                考区与学段
              </label>
              <input
                type="text"
                value={`${form.region} · ${form.grade}中考`}
                disabled
                className="w-full px-3 py-2 text-sm bg-slate-50 text-slate-500 border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                阶段目标学校
              </label>
              <input
                type="text"
                value={form.targetSchool}
                onChange={(e) => setForm({ ...form, targetSchool: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                正式中考日期
              </label>
              <input
                type="date"
                value={form.targetExamDate}
                onChange={(e) => setForm({ ...form, targetExamDate: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-700">
                每日基准可用时间
              </label>
              <span className="text-xs font-mono tabular-nums text-blue-700 font-semibold">
                {form.dailyBudgetMinutes} 分钟（受负荷调节后：{effectiveMinutes} 分钟）
              </span>
            </div>
            <input
              type="range"
              min={30}
              max={120}
              step={5}
              value={form.dailyBudgetMinutes}
              onChange={(e) =>
                setForm({ ...form, dailyBudgetMinutes: Number(e.target.value) })
              }
              className="w-full accent-blue-700"
            />
            <div className="flex justify-between text-xs text-slate-400 font-mono tabular-nums mt-1">
              <span>30分钟</span>
              <span>60分钟</span>
              <span>90分钟</span>
              <span>120分钟</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                学校今日作业量
              </label>
              <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
                {(['轻松', '适中', '较重'] as HomeworkLoad[]).map((load) => (
                  <button
                    key={load}
                    type="button"
                    onClick={() => setForm({ ...form, homeworkLoad: load })}
                    className={`py-1.5 text-xs font-medium rounded-md transition-colors ${
                      form.homeworkLoad === load
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {load}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                当前疲劳度评估
              </label>
              <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
                {(['低', '中', '高'] as FatigueLevel[]).map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setForm({ ...form, fatigueLevel: level })}
                    className={`py-1.5 text-xs font-medium rounded-md transition-colors ${
                      form.fatigueLevel === level
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                onResetDemo();
                onClose();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              重置初始示例数据
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-lg whitespace-nowrap shrink-0"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                保存并重排计划
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
