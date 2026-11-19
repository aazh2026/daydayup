/**
 * 考点档案卡片（提分报告「考点档案」列表使用）。
 *
 * 与知识图谱的分工：
 * - 图谱回答「这个考点在学科结构里的位置」；
 * - 档案回答「这个考点对我而言掌握到哪、还差多少」。
 *
 * 为避免与导图重复平铺，子技能与先修依赖默认折叠为摘要，
 * 需要时再展开（展开的先修考点可直接跳到它的档案）。
 */
import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  GitBranch,
  Layers,
  Target,
} from 'lucide-react';
import type { KnowledgePoint, MasteryRecord } from '../../types.ts';
import { MathText } from '../MathText.tsx';

export interface KnowledgePointCardProps {
  kp: KnowledgePoint;
  mastery?: MasteryRecord;
  /** 全部考点的掌握度记录（用于解析前置考点的掌握状态） */
  masteryRecords: Record<string, MasteryRecord>;
  /** id → KnowledgePoint，用于解析先修考点名称 */
  knowledgeMap: Record<string, KnowledgePoint>;
  onOpenDetail: (kp: KnowledgePoint) => void;
  onLaunchCoach: (knowledgeId: string) => void;
  /** 在知识图谱中定位该考点（跨页深链） */
  onLocateInGraph?: (knowledgeId: string) => void;
}

export const KnowledgePointCard: React.FC<KnowledgePointCardProps> = ({
  kp,
  mastery,
  masteryRecords,
  knowledgeMap,
  onOpenDetail,
  onLaunchCoach,
  onLocateInGraph,
}) => {
  const [showSubSkills, setShowSubSkills] = useState(false);
  const [showPrereqs, setShowPrereqs] = useState(false);

  const state = mastery?.state ?? '未诊断';
  const lostScore = mastery?.lostScoreEvidence ?? 0;

  const stateColorClass =
    state === '稳定掌握' || state === '掌握'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : state === '初步掌握' || state === '学习中'
        ? 'bg-blue-50 text-blue-700 border-blue-200'
        : state === '待学习'
          ? 'bg-amber-50 text-amber-700 border-amber-200'
          : 'bg-slate-50 text-slate-600 border-slate-200';

  const prereqIds = kp.prerequisites ?? [];
  const weakPrereqCount = prereqIds.filter((preId) => {
    const preState = masteryRecords[preId]?.state ?? '未诊断';
    const preLost = masteryRecords[preId]?.lostScoreEvidence ?? 0;
    return preState === '待学习' || preState === '学习中' || preLost > 0;
  }).length;

  const subSkillCount = kp.subSkills?.length ?? 0;

  return (
    <article className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4 hover:shadow-md transition-shadow">
      <div className="space-y-3.5">
        {/* 元信息行 */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-slate-500">
            <span className="font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
              {kp.subject}
            </span>
            <span aria-hidden="true">·</span>
            <span className="truncate max-w-[200px]" title={kp.chapter}>
              {kp.chapter}
            </span>
            <span aria-hidden="true">·</span>
            <span className="text-slate-600 font-medium">{kp.domain}</span>
          </div>

          <div className="flex items-center gap-1.5">
            {kp.textbook && (
              <span
                className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
                title={`上海课本落点：${kp.textbook.edition} ${kp.textbook.grade}${kp.textbook.term} ${kp.textbook.chapter}`}
              >
                课本 {kp.textbook.grade}
              </span>
            )}
            {lostScore > 0 && (
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200 font-mono">
                失分 -{lostScore}分
              </span>
            )}
            <span
              className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${stateColorClass}`}
            >
              {state}
            </span>
          </div>
        </div>

        {/* 标题与权重 */}
        <div className="space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-base font-bold text-slate-900 leading-snug">{kp.name}</h3>
            <div className="flex items-center gap-1 shrink-0 text-[11px] font-mono">
              <span
                className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium"
                title="考纲考核频率与分值权重系数"
              >
                权重 {kp.examWeight}x
              </span>
              <span
                className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-medium"
                title="系统预估攻克此考点所需学时"
              >
                ~{kp.learningCostHours}h
              </span>
            </div>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed pt-0.5"><MathText text={kp.definition} /></p>
        </div>

        {/* 分步子技能：默认折叠，避免与导图第四层重复平铺 */}
        {subSkillCount > 0 && (
          <div className="p-2.5 bg-slate-50/80 border border-slate-100 rounded-lg space-y-1.5 text-xs">
            <button
              type="button"
              onClick={() => setShowSubSkills((v) => !v)}
              className="w-full flex items-center justify-between gap-2 text-left"
            >
              <span className="text-[11px] font-semibold text-slate-700 flex items-center gap-1">
                <Target className="w-3.5 h-3.5 text-blue-600" />
                <span>核心分步子能力清单（{subSkillCount} 项）</span>
              </span>
              {showSubSkills ? (
                <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              )}
            </button>
            {showSubSkills ? (
              <div className="flex flex-wrap gap-1.5">
                {kp.subSkills.map((sk) => (
                  <span
                    key={sk}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 text-[11px]"
                  >
                    <Check className="w-3 h-3 text-emerald-600 shrink-0" />
                    <span><MathText text={sk} /></span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-slate-400 truncate">{kp.subSkills[0]} 等</div>
            )}
          </div>
        )}

        {/* 先修依赖：默认折叠摘要，展开后可直达前置考点档案 */}
        {prereqIds.length > 0 && (
          <div className="p-2.5 bg-blue-50/40 border border-blue-100 rounded-lg space-y-1.5 text-xs">
            <button
              type="button"
              onClick={() => setShowPrereqs((v) => !v)}
              className="w-full flex items-center justify-between gap-2 text-left"
            >
              <span className="text-[11px] font-semibold text-blue-900 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-blue-700" />
                <span>
                  前置考点 {prereqIds.length} 个
                  {weakPrereqCount > 0 && ` · ${weakPrereqCount} 个仍薄弱`}
                </span>
              </span>
              {showPrereqs ? (
                <ChevronUp className="w-3.5 h-3.5 text-blue-400" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-blue-400" />
              )}
            </button>
            {showPrereqs && (
              <div className="flex flex-wrap gap-1.5">
                {prereqIds.map((preId) => {
                  const preKp = knowledgeMap[preId];
                  const preState = masteryRecords[preId]?.state ?? '未诊断';
                  const preLost = masteryRecords[preId]?.lostScoreEvidence ?? 0;
                  const preHasProblem =
                    preState === '待学习' || preState === '学习中' || preLost > 0;
                  return (
                    <button
                      key={preId}
                      type="button"
                      onClick={() => {
                        if (preKp) onOpenDetail(preKp);
                      }}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] transition-colors ${
                        preHasProblem
                          ? 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                      title="点击查看前置考点档案"
                    >
                      <span>{preKp?.name ?? preId}</span>
                      <span className="font-mono text-[10px]">({preState})</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 考法与避坑：档案独有内容，图谱不展开 */}
        <div className="text-xs space-y-2 pt-2 border-t border-slate-100">
          {kp.commonExamForms && kp.commonExamForms.length > 0 && (
            <div className="flex items-start gap-1.5">
              <span className="font-semibold text-slate-700 shrink-0">常见考法：</span>
              <div className="flex flex-wrap gap-1">
                {kp.commonExamForms.map((fmt) => (
                  <span
                    key={fmt}
                    className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px]"
                  >
                    <MathText text={fmt} />
                  </span>
                ))}
              </div>
            </div>
          )}

          {kp.commonTraps && kp.commonTraps.length > 0 && (
            <div className="p-2.5 bg-amber-50/60 border border-amber-200/80 rounded-lg space-y-1">
              <div className="font-semibold text-amber-900 flex items-center gap-1 text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span>高频易错避坑要点：</span>
              </div>
              <ul className="list-disc list-inside text-amber-900 text-xs space-y-0.5">
                {kp.commonTraps.map((trap) => (
                  <li key={trap}>
                    <MathText text={trap} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-slate-500 text-[11px] flex items-center gap-1">
            <Clock className="w-3 h-3 text-slate-400" />
            <span>诊断证据：<MathText text={mastery?.evidenceLogs?.[0] ?? '暂无近期试卷失分记录'} /></span>
          </div>
        </div>
      </div>

      {/* 底部操作区 */}
      <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
        <div className="text-xs text-slate-500 font-mono tabular-nums">
          变式评测：
          <span className={mastery?.variantPassed ? 'text-emerald-600 font-semibold' : 'text-slate-400'}>
            {mastery?.variantPassed ? '已通过' : '待完成'}
          </span>
          {' · '}
          延迟复测：
          <span
            className={mastery?.delayedRetestPassed ? 'text-emerald-600 font-semibold' : 'text-slate-400'}
          >
            {mastery?.delayedRetestPassed ? '已通过' : '待完成'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenDetail(kp)}
            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors inline-flex items-center gap-1"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>全景档案</span>
          </button>

          {onLocateInGraph && (
            <button
              type="button"
              onClick={() => onLocateInGraph(kp.id)}
              title="在知识图谱中定位该考点"
              className="px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors inline-flex items-center gap-1"
            >
              <GitBranch className="w-3.5 h-3.5" />
              <span>图谱定位</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onLaunchCoach(kp.id)}
            className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors inline-flex items-center gap-1"
          >
            <span>去训练</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </article>
  );
};
