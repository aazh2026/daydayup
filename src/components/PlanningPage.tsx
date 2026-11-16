import React, { useState } from 'react';
import { ArrowRight, Calculator, Calendar, Lock } from 'lucide-react';
import { ALL_SUBJECTS } from '../types.ts';
import type {
  FatigueLevel,
  HomeworkLoad,
  LearningPlan,
  LearningTask,
  Student,
  Subject,
} from '../types.ts';

interface PlanningPageProps {
  student: Student;
  plan: LearningPlan;
  onUpdateStudent: (updated: Student) => void;
  onStartTask: (task: LearningTask) => void;
  onLaunchCoach: (knowledgeId: string) => void;
}

export const PlanningPage: React.FC<PlanningPageProps> = ({
  student,
  plan,
  onUpdateStudent,
  onStartTask,
  onLaunchCoach,
}) => {
  const [subjectFilter, setSubjectFilter] = useState<'全部' | Subject>('全部');
  const [selectedDayIdx, setSelectedDayIdx] = useState(0);

  const filteredPriorities =
    subjectFilter === '全部'
      ? plan.priorities
      : plan.priorities.filter((p) => p.subject === subjectFilter);

  const activeDay = plan.days[selectedDayIdx] ?? plan.days[0];

  return (
    <div className="space-y-8">
      {/* Header + Real-Time Constraint Tuning Toolbar */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-slate-900">
              02. 提分机会与7天规划引擎
            </h1>
            <p className="text-xs text-slate-500 leading-relaxed">
              不按学科分数高低死板分配时间，而是严格按照“单位时间边际提分效率”与先修依赖关系，在每日有限时间预算内排定最优学习次序。
            </p>
          </div>
          <div className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 shrink-0">
            <div className="flex items-center gap-1.5 font-medium text-slate-900">
              <Calculator className="w-3.5 h-3.5 text-blue-700" />
              <span>排序核心公式（确定性约束算法）</span>
            </div>
            <div className="mt-1 font-mono text-slate-600">
              Priority = (失分空间 × 可恢复概率 × 置信度 × 考频权重) ÷ 学习成本
            </div>
          </div>
        </div>

        {/* Interactive Realistic Constraints */}
        <div className="pt-4 border-t border-slate-100 grid grid-cols-1 md:grid-cols-3 gap-5 items-center">
          <div>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-medium text-slate-700">每日可用学习时间</span>
              <span className="font-mono tabular-nums font-semibold text-blue-700">
                基准 {student.dailyBudgetMinutes} 分钟 → 实际排期 {plan.effectiveDailyBudget} 分钟
              </span>
            </div>
            <input
              type="range"
              min={30}
              max={120}
              step={5}
              value={student.dailyBudgetMinutes}
              onChange={(e) =>
                onUpdateStudent({
                  ...student,
                  dailyBudgetMinutes: Number(e.target.value),
                })
              }
              className="w-full accent-blue-700"
            />
          </div>

          <div>
            <div className="text-xs font-medium text-slate-700 mb-1.5">学校作业负荷</div>
            <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
              {(['轻松', '适中', '较重'] as HomeworkLoad[]).map((load) => (
                <button
                  key={load}
                  type="button"
                  onClick={() => onUpdateStudent({ ...student, homeworkLoad: load })}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors ${
                    student.homeworkLoad === load
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
            <div className="text-xs font-medium text-slate-700 mb-1.5">学生当前疲劳程度</div>
            <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
              {(['低', '中', '高'] as FatigueLevel[]).map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => onUpdateStudent({ ...student, fatigueLevel: level })}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors ${
                    student.fatigueLevel === level
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
      </section>

      {/* Priority Ranking Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              全科边际提分优先级排序（共 {filteredPriorities.length} 项待提升考点）
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              低投入高回报的基础概念（如分式计算、化学用语）优先于耗时极长的压轴题；前置知识未过关时自动触发先修锁定
            </p>
          </div>
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start overflow-x-auto">
            {(['全部', ...ALL_SUBJECTS] as const).map((sub) => (
              <button
                key={sub}
                type="button"
                onClick={() => setSubjectFilter(sub)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  subjectFilter === sub
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sub}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs text-slate-500">
                <th className="py-3 pl-6 pr-3 font-medium">排序</th>
                <th className="py-3 px-3 font-medium">学科与知识点</th>
                <th className="py-3 px-3 font-medium text-right">失分空间</th>
                <th className="py-3 px-3 font-medium text-right">预计可恢复</th>
                <th className="py-3 px-3 font-medium text-right">预计耗时</th>
                <th className="py-3 px-3 font-medium text-right">置信度</th>
                <th className="py-3 px-3 font-medium text-right">优先级指数</th>
                <th className="py-3 pl-3 pr-6 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filteredPriorities.map((item, idx) => {
                const tierColor =
                  item.priorityTier === '高'
                    ? 'text-blue-700 font-semibold'
                    : item.priorityTier === '中'
                    ? 'text-slate-800 font-medium'
                    : 'text-slate-400';

                return (
                  <tr key={item.knowledgeId} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3.5 pl-6 pr-3 font-mono tabular-nums text-slate-500">
                      #{idx + 1}
                    </td>
                    <td className="py-3.5 px-3">
                      <div className="font-semibold text-slate-900">
                        {item.subject} · {item.knowledgeName}
                      </div>
                      <div className="text-slate-500 mt-0.5 flex items-center gap-1.5">
                        {item.blockedByPrerequisite && (
                          <Lock className="w-3 h-3 text-amber-600 shrink-0" />
                        )}
                        <span>{item.rationale}</span>
                      </div>
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      {item.lostScore} 分
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-emerald-700 font-medium">
                      +{item.expectedGain} 分
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      {item.learningCostHours} 小时
                    </td>
                    <td className="py-3.5 px-3 text-right text-slate-600">
                      {item.confidenceLabel}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums">
                      <span className={tierColor}>
                        {item.priorityScore.toFixed(2)}（{item.priorityTier}）
                      </span>
                    </td>
                    <td className="py-3.5 pl-3 pr-6 text-right">
                      <button
                        type="button"
                        onClick={() => onLaunchCoach(item.knowledgeId)}
                        className="px-3 py-1.5 text-xs font-medium text-blue-700 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap"
                      >
                        立即训练
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 7-Day Executable Schedule */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-700" />
            <h2 className="text-base font-semibold text-slate-900">
              未来 7 天可执行学习日程
            </h2>
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            时间预算约束满足率：100%（每日 ≤ {plan.effectiveDailyBudget} 分钟，每日最多 3 项）
          </span>
        </div>

        {/* Day Selector Tabs */}
        <div className="grid grid-cols-7 gap-1.5 p-1 bg-slate-100 rounded-lg overflow-x-auto">
          {plan.days.map((day) => {
            const isSel = day.dayIndex === selectedDayIdx;
            const doneNum = day.tasks.filter((t) => t.status === '已完成').length;
            const hasCarryOver = day.tasks.some((t) => t.carriedOverFromToday);
            return (
              <button
                key={day.dayIndex}
                type="button"
                onClick={() => setSelectedDayIdx(day.dayIndex)}
                className={`py-2 px-2 rounded-md text-center transition-colors ${
                  isSel
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <div className="text-xs font-semibold whitespace-nowrap">
                  {day.dayLabel}
                  {hasCarryOver && <span className="text-amber-700 ml-1">· 含顺延</span>}
                </div>
                <div className="text-[11px] font-mono tabular-nums text-slate-500 mt-0.5">
                  {day.totalMinutes}分 · {doneNum}/{day.tasks.length}
                </div>
              </button>
            );
          })}
        </div>

        {activeDay && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {activeDay.tasks.map((task) => (
              <div
                key={task.id}
                className={`p-4 border rounded-xl flex flex-col justify-between space-y-4 ${
                  task.carriedOverFromToday
                    ? 'border-amber-200 bg-amber-50/20'
                    : 'border-slate-200'
                }`}
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {task.subject} ·{' '}
                      <span className="font-mono tabular-nums">{task.estimatedMinutes} 分钟</span>
                    </span>
                    <span
                      className={
                        task.status === '已完成'
                          ? 'text-emerald-700 font-medium'
                          : task.carriedOverFromToday
                          ? 'text-amber-700 font-medium'
                          : 'text-slate-600'
                      }
                    >
                      {task.carriedOverFromToday ? '今日顺延优先' : task.status}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-slate-900">{task.title}</h3>
                  <p className="text-xs text-slate-600 leading-relaxed">{task.objective}</p>
                </div>

                <button
                  type="button"
                  onClick={() => onStartTask(task)}
                  className="inline-flex items-center justify-center gap-1.5 w-full py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                >
                  <span>进入 AI 教练执行任务</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
