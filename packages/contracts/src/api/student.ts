/**
 * 学生档案与考试相关 API 契约。
 */

import type { Subject, HomeworkLoad, FatigueLevel, Student, Exam, ExamResult } from '../domain/index.ts';
import type { ExamType } from './diagnosis.ts';

export interface StudentProfileUpdate {
  name?: string;
  targetExamDate?: string;
  targetSchool?: string;
  dailyBudgetMinutes?: number;
  homeworkLoad?: HomeworkLoad;
  fatigueLevel?: FatigueLevel;
}

export interface EffectiveBudget {
  studentId: string;
  effectiveDailyBudget: number;
  baseMinutes: number;
  factor: number;
}

export function parseStudent(raw: unknown): Student | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  if (typeof r.name !== 'string') return null;
  if (typeof r.dailyBudgetMinutes !== 'number') return null;
  return r as unknown as Student;
}

export function parseEffectiveBudget(raw: unknown): EffectiveBudget | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.effectiveDailyBudget !== 'number') return null;
  return r as unknown as EffectiveBudget;
}

export type { Subject, HomeworkLoad, FatigueLevel, ExamType };
export type { Student, Exam, ExamResult } from '../domain/index.ts';
