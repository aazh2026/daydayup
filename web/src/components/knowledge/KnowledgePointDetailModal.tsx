/**
 * 考点全景档案弹窗。
 *
 * 从提分报告中抽出为独立组件，供「考点档案」列表与知识图谱共用，
 * 保证同一个考点在任何入口打开看到的档案内容完全一致。
 */
import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Award,
  BookOpen,
  Compass,
  FileText,
  GitBranch,
  Layers,
  Sparkles,
  Tag,
  Target,
  X,
} from 'lucide-react';
import type { ErrorRecord, KnowledgePoint, MasteryRecord } from '../../types.ts';
import { MathText } from '../MathText.tsx';

export interface KnowledgePointDetailModalProps {
  kp: KnowledgePoint;
  mastery?: MasteryRecord;
  /** 全部考点的掌握度记录（用于解析前置考点状态） */
  masteryRecords: Record<string, MasteryRecord>;
  knowledgeMap: Record<string, KnowledgePoint>;
  errorRecords: ErrorRecord[];
  onClose: () => void;
  onLaunchCoach: (knowledgeId: string) => void;
  /** 在知识图谱中定位该考点（跨页深链） */
  onLocateInGraph?: (knowledgeId: string) => void;
}

export const KnowledgePointDetailModal: React.FC<KnowledgePointDetailModalProps> = ({
  kp,
  mastery,
  masteryRecords,
  knowledgeMap,
  errorRecords,
  onClose,
  onLaunchCoach,
  onLocateInGraph,
}) => {
  const state = mastery?.state ?? '未诊断';
  const linkedErrors = errorRecords.filter((e) => e.knowledgeId === kp.id);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kp-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto"
    >
      <div className="bg-white rounded-2xl max-w-3xl w-full border border-slate-200 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col my-auto">
        {/* 弹窗头 */}
        <div className="p-6 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-slate-800 bg-white border border-slate-200 px-2.5 py-0.5 rounded">
                {kp.subject}
              </span>
              <span className="text-slate-500 font-medium">{kp.chapter}</span>
              <span className="text-slate-400">·</span>
              <span className="text-blue-700 font-semibold">{kp.domain}</span>
            </div>
            <h3 id="kp-modal-title" className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <span>{kp.name}</span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                考纲权重 {kp.examWeight}x
              </span>
              <span className="text-xs font-mono font-medium px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                攻克预估 {kp.learningCostHours} 小时
              </span>
            </h3>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="关闭详情弹窗"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 弹窗主体 */}
        <div className="p-6 space-y-6 overflow-y-auto text-xs leading-relaxed">
          {/* 掌握度快照 */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                <Award className="w-4 h-4 text-blue-600" />
                <span>当前掌握度与学情诊断</span>
              </div>
              <span className="font-semibold text-blue-700 bg-blue-50 px-2.5 py-1 rounded-md border border-blue-200">
                状态机：{state}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <div className="p-2 bg-white border border-slate-200 rounded-lg">
                <div className="text-slate-400 text-[11px]">置信度评级</div>
                <div className="font-semibold text-slate-800 mt-0.5">
                  {mastery?.confidence ?? '待评估'}
                </div>
              </div>
              <div className="p-2 bg-white border border-slate-200 rounded-lg">
                <div className="text-slate-400 text-[11px]">历史失分</div>
                <div className="font-semibold text-red-700 font-mono mt-0.5">
                  -{mastery?.lostScoreEvidence ?? 0} 分
                </div>
              </div>
              <div className="p-2 bg-white border border-slate-200 rounded-lg">
                <div className="text-slate-400 text-[11px]">变式评测</div>
                <div className="font-semibold text-slate-800">
                  {mastery?.variantPassed ? '已达标' : '待完成'}
                </div>
              </div>
              <div className="p-2 bg-white border border-slate-200 rounded-lg">
                <div className="text-slate-400 text-[11px]">延迟复测闭环</div>
                <div className="font-semibold text-slate-800">
                  {mastery?.delayedRetestPassed ? '已闭环' : '待触发'}
                </div>
              </div>
            </div>
          </div>

          {/* 上海课本落点 */}
          {kp.textbook && (
            <div className="space-y-1.5">
              <h4 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
                <BookOpen className="w-4 h-4 text-emerald-600" />
                <span>上海课本落点</span>
              </h4>
              <div className="p-3.5 rounded-xl border border-emerald-200 bg-emerald-50/60 space-y-1">
                <div className="font-semibold text-emerald-900">
                  {kp.textbook.edition} · {kp.textbook.grade}
                  {kp.textbook.term}
                </div>
                <div className="text-slate-700">
                  {kp.textbook.unit} → {kp.textbook.chapter}
                </div>
                {kp.textbook.note && (
                  <div className="text-slate-500 text-[11px]"><MathText text={kp.textbook.note} /></div>
                )}
              </div>
            </div>
          )}

          {/* 概念定义 */}
          <div className="space-y-1.5">
            <h4 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
              <Compass className="w-4 h-4 text-blue-600" />
              <span>概念核心定义与课标要求</span>
            </h4>
            <p className="text-slate-700 bg-slate-50 p-3.5 rounded-xl border border-slate-200 leading-relaxed text-xs">
              <MathText text={kp.definition} />
            </p>
          </div>

          {/* 分步子能力 */}
          {kp.subSkills && kp.subSkills.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
                <Target className="w-4 h-4 text-emerald-600" />
                <span>分步子能力考核要求（{kp.subSkills.length} 项）</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {kp.subSkills.map((sk, idx) => (
                  <div
                    key={sk}
                    className="p-2.5 bg-white border border-slate-200 rounded-lg flex items-start gap-2 text-slate-800"
                  >
                    <span className="font-mono text-emerald-700 font-bold">0{idx + 1}.</span>
                    <span><MathText text={sk} /></span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 先修依赖 */}
          {kp.prerequisites && kp.prerequisites.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-blue-600" />
                <span>先修依赖链路追踪（前置考点）</span>
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {kp.prerequisites.map((preId) => {
                  const preKp = knowledgeMap[preId];
                  const preState = masteryRecords[preId]?.state ?? '未诊断';
                  return (
                    <div
                      key={preId}
                      className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between"
                    >
                      <div>
                        <div className="font-semibold text-slate-900">
                          {preKp?.name ?? preId}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {preKp?.chapter ?? '先修基础'}
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-white border border-slate-200 text-slate-700">
                        {preState}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 考法与避坑 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
              <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                <Tag className="w-4 h-4 text-indigo-600" />
                <span>中考常见出题考法</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-slate-700">
                {(kp.commonExamForms ?? []).map((fmt) => (
                  <li key={fmt}><MathText text={fmt} /></li>
                ))}
              </ul>
            </div>

            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2 text-amber-900">
              <div className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span>高频易错避坑要点</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-amber-900">
                {(kp.commonTraps ?? []).map((trap) => (
                  <li key={trap}><MathText text={trap} /></li>
                ))}
              </ul>
            </div>
          </div>

          {/* 关联错题证据 */}
          <div className="space-y-2">
            <div className="font-semibold text-slate-900 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-red-600" />
                <span>关联历史诊断错题证据（共 {linkedErrors.length} 题）</span>
              </span>
            </div>

            {linkedErrors.length === 0 ? (
              <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg text-slate-500 text-center">
                当前暂无该考点的历史失分错题记录
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {linkedErrors.map((err) => (
                  <div
                    key={err.id}
                    className="p-3 bg-red-50/50 border border-red-100 rounded-lg space-y-1 text-slate-700"
                  >
                    <div className="flex items-center justify-between font-semibold">
                      <span className="text-slate-900">
                        {err.examTitle} · 题号 {err.questionNumber}
                      </span>
                      <span className="text-red-700 font-mono">
                        {err.errorType} · -{err.scoreLost}分
                      </span>
                    </div>
                    <p className="text-slate-600 line-clamp-2"><MathText text={err.stem} /></p>
                    <div className="text-[11px] text-slate-500">
                      学生作答：<MathText text={err.studentAnswer} /> · 归因：<MathText text={err.aiAnalysis} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 弹窗底栏 */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500 font-mono">考点唯一编号：{kp.id}</span>

          <div className="flex items-center gap-2">
            {onLocateInGraph && (
              <button
                type="button"
                onClick={() => {
                  onLocateInGraph(kp.id);
                  onClose();
                }}
                className="px-3 py-2 text-xs font-medium text-indigo-700 bg-white border border-indigo-200 hover:bg-indigo-50 rounded-lg transition-colors inline-flex items-center gap-1.5"
              >
                <GitBranch className="w-3.5 h-3.5" />
                <span>在图谱中定位</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors"
            >
              关闭
            </button>
            <button
              type="button"
              onClick={() => {
                const id = kp.id;
                onClose();
                onLaunchCoach(id);
              }}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors inline-flex items-center gap-1.5 shadow-sm"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>启动 AI 教练针对性攻克</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
