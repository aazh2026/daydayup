import React from 'react';
import { ArrowRight, CheckCircle2, Clock, RotateCw } from 'lucide-react';
import type { AppPage, LearningPlan, LearningTask, MasteryRecord, Student } from '../types.ts';
import { computeDaysToZhongkao } from '../engine/planner.ts';

interface TodayPageProps {
  student: Student;
  plan: LearningPlan;
  masteryRecords: Record<string, MasteryRecord>;
  deferredKnowledgeIds: string[];
  onStartTask: (task: LearningTask) => void;
  onToggleCompleteTask: (taskId: string) => void;
  onDeferTask: (knowledgeId: string) => void;
  onClearDeferrals: () => void;
  onNavigate: (page: AppPage) => void;
}

export const TodayPage: React.FC<TodayPageProps> = ({
  student,
  plan,
  masteryRecords,
  deferredKnowledgeIds,
  onStartTask,
  onToggleCompleteTask,
  onDeferTask,
  onClearDeferrals,
  onNavigate,
}) => {
  const daysLeft = computeDaysToZhongkao(student.targetExamDate);
  const todaySchedule = plan.days[0];
  const todayTasks = todaySchedule?.tasks ?? [];
  const completedCount = todayTasks.filter((t) => t.status === '已完成').length;

  const allWeekTasks = plan.days.flatMap((d) => d.tasks);
  const weekCompleted = allWeekTasks.filter((t) => t.status === '已完成').length;
  const weekCompletionRate =
    allWeekTasks.length > 0 ? Math.round((weekCompleted / allWeekTasks.length) * 100) : 0;

  return (
    <div className="space-y-8">
      {/* Hero Summary Anchor */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>{student.region} · {student.grade}中考提分计划</span>
              <span aria-hidden="true">·</span>
              <span>目标：{student.targetSchool}</span>
              <span aria-hidden="true">·</span>
              <span>覆盖学科：数学 / 英语 / 物理 / 化学 / 语文</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              今天这 {todaySchedule?.totalMinutes ?? plan.effectiveDailyBudget} 分钟，只攻克最值钱的提分点
            </h1>
            <p className="text-sm text-slate-600 leading-relaxed">
              系统已根据最近试卷失分证据、知识先修依赖和今日作业负荷（{student.homeworkLoad}），从全部考点中筛选出今日边际收益最高的 {todayTasks.length} 项任务，避免无效刷题负担。
            </p>
          </div>

          <div className="grid grid-cols-3 gap-4 sm:gap-6 pt-4 lg:pt-0 border-t lg:border-t-0 lg:border-l border-slate-200 lg:pl-8 shrink-0">
            <div>
              <div className="text-xs text-slate-500">距离中考</div>
              <div className="mt-1 text-2xl sm:text-3xl font-bold font-mono tabular-nums text-slate-900">
                {daysLeft}<span className="text-sm font-normal text-slate-500 ml-1">天</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">今日学习</div>
              <div className="mt-1 text-2xl sm:text-3xl font-bold font-mono tabular-nums text-blue-700">
                {completedCount}/{todayTasks.length}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">本周完成度</div>
              <div className="mt-1 text-2xl sm:text-3xl font-bold font-mono tabular-nums text-slate-900">
                {weekCompletionRate}%
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Replan Notification Strip when tasks were deferred today */}
      {deferredKnowledgeIds.length > 0 && (
        <div className="p-4 bg-amber-50/70 border border-amber-200 rounded-xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-amber-950">
          <div>
            <span className="font-semibold">智能重排已生效：</span>
            已将 {deferredKnowledgeIds.length} 项今日推迟任务顺延至「明天」优先队列首位，同时今日空出预算已自动补位后续高性价比任务，明日总时长仍严格控制在 {plan.effectiveDailyBudget} 分钟内。
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('planning')}
              className="font-medium text-blue-700 hover:underline whitespace-nowrap"
            >
              查看明日排期
            </button>
            <button
              type="button"
              onClick={onClearDeferrals}
              className="text-slate-600 hover:text-slate-900 whitespace-nowrap"
            >
              恢复今日原排期
            </button>
          </div>
        </div>
      )}

      {/* Today's Top 3 Tasks */}
      <section aria-labelledby="today-tasks-heading" className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 id="today-tasks-heading" className="text-lg font-semibold text-slate-900">
              01. 今天最重要的三件事
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              步骤进度与 AI 教练练习双向同步；若今日来不及完成，可一键重排顺延至明日并自动置换低优任务
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500 font-mono tabular-nums">
            <span>今日预算：{plan.effectiveDailyBudget} 分钟</span>
            <span aria-hidden="true">/</span>
            <span>已完成：{completedCount} 项</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {todayTasks.map((task, idx) => {
            const mastery = masteryRecords[task.knowledgeId];
            const isDone = task.status === '已完成';
            const doneStepsCount = task.steps.filter((s) => s.done).length;

            return (
              <article
                key={task.id}
                className={`bg-white border rounded-xl p-6 flex flex-col justify-between transition-colors ${
                  isDone
                    ? 'border-emerald-200 bg-emerald-50/30'
                    : 'border-slate-200'
                }`}
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="font-medium text-slate-700">
                      {idx === 0 ? '优先任务' : `第 ${idx + 1} 项`}
                      <span aria-hidden="true"> · </span>
                      {task.subject}
                      <span aria-hidden="true"> · </span>
                      <span className="font-mono tabular-nums">{task.estimatedMinutes} 分钟</span>
                    </span>
                    <span
                      className={`font-medium ${
                        isDone ? 'text-emerald-700' : 'text-blue-700'
                      }`}
                    >
                      {isDone ? '已完成' : mastery?.state ?? '待学习'}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-base font-semibold text-slate-900 leading-snug">
                      {task.title}
                    </h3>
                    <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                      {task.objective}
                    </p>
                  </div>

                  {/* Step breakdown synced with Coach */}
                  <div className="pt-3 border-t border-slate-100 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700">学习节奏拆解</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {doneStepsCount}/{task.steps.length} 步
                      </span>
                    </div>
                    <ul className="space-y-1.5">
                      {task.steps.map((step, sIdx) => (
                        <li
                          key={sIdx}
                          className={`flex items-center justify-between text-xs ${
                            step.done ? 'text-emerald-700 line-through' : 'text-slate-600'
                          }`}
                        >
                          <span>
                            {sIdx + 1}. {step.label}
                          </span>
                          <span className="font-mono tabular-nums text-slate-400 no-underline">
                            {step.minutes} 分钟
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs text-slate-700">
                    <span className="font-medium text-slate-900">验收标准：</span>
                    {task.verifiableOutcome}
                  </div>
                </div>

                <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onStartTask(task)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <span>开始{task.subject}学习</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => onToggleCompleteTask(task.id)}
                    title={isDone ? '取消完成标记' : '标记为已完成'}
                    className={`px-3 py-2 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${
                      isDone
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-white text-slate-600 hover:text-slate-900 border-slate-200'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{isDone ? '已打卡' : '打卡'}</span>
                  </button>

                  {!isDone && (
                    <button
                      type="button"
                      onClick={() => onDeferTask(task.knowledgeId)}
                      title="今天来不及做，智能顺延至明日首位并重排"
                      className="px-2.5 py-2 text-xs text-slate-500 hover:text-slate-900 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                      <span>重排</span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Quick Entry Strip */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start sm:items-center gap-3">
          <Clock className="w-4 h-4 text-slate-500 mt-0.5 sm:mt-0 shrink-0" />
          <div className="text-xs text-slate-600 leading-relaxed">
            <span className="font-medium text-slate-900">刚刚考完新测验或拿到新试卷？</span>
            <span className="ml-1">
              上传试卷照片并经人工快速确认后，即可自动更新知识点状态机与未来7天提分优先级。
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => onNavigate('diagnosis')}
            className="px-4 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            去上传试卷诊断
          </button>
          <button
            type="button"
            onClick={() => onNavigate('planning')}
            className="px-4 py-2 text-xs font-medium text-blue-700 hover:text-blue-800 border border-blue-200 bg-blue-50/50 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            查看提分优先级模型
          </button>
        </div>
      </section>
    </div>
  );
};
