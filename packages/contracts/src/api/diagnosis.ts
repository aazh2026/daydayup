/**
 * 诊断相关 API 契约。
 *
 * 现状：服务端 /api/diagnose-paper 直接返回裸对象，前端在 DiagnosisPage.tsx:400
 * 用 `as Record<string, unknown>` 强转 + 逐字段防御性校验。
 *
 * 分离后：请求体携带 paperId（图片已在上传时落盘），响应增加 meta 可追溯块。
 */

import type {
  Subject,
  ConfidenceLevel,
  ErrorType,
  DetectedMetadata,
} from '../domain/index.ts';

export type ExamType = '期中考试' | '月考' | '一模' | '二模' | '随堂诊断';

export const EXAM_TYPES: ExamType[] = ['期中考试', '月考', '一模', '二模', '随堂诊断'];

export type InputFormat = 'image' | 'parsed_text' | 'mixed' | 'wrong_item';

export type PaperSourceFormat = '试卷拍照' | '文本试卷' | '单题录入';

export interface DiagnosedItem {
  questionNumber: string;
  stem: string;
  studentAnswer: string;
  correctAnswer: string;
  scoreLost: number;
  knowledgeId: string;
  errorType: string;
  aiAnalysis: string;
  evidence: string;
  confidence: string;
  verificationMethod: string;
}

/** 诊断结果的可追溯信息 */
export interface DiagnosisMeta {
  promptVersion: string;
  model: string;
  curriculumVersion: string;
  requestId: string;
  computedAt: string;
}

export interface DiagnoseExamRequest {
  paperId?: string;
  subject?: Subject | '自动识别';
  examTitle?: string;
  inputFormat: InputFormat;
  rawText?: string;
  parsedTextName?: string;
  images?: Array<{ base64: string; mimeType: string }>;
  useSampleImage?: boolean;
}

export interface DiagnoseExamResponse {
  detectedMetadata: DetectedMetadata;
  paperSummary: string;
  questionsDetectedCount: number;
  totalLostScore: number;
  diagnosedItems: DiagnosedItem[];
  meta?: DiagnosisMeta;
}

/** 诊断微测 */
export interface MicroQuizTarget {
  id: string;
  subject: string;
  name: string;
  definition: string;
}

export interface MicroQuizItem {
  knowledgeId: string;
  subject: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface MicroQuizRequest {
  targets: MicroQuizTarget[];
}

export interface MicroQuizResponse {
  items: MicroQuizItem[];
}

/**
 * 运行时校验：诊断响应。
 * 失败返回 null → 前端显示「服务返回格式异常」而非白屏。
 */
export function parseDiagnoseExamResponse(raw: unknown): DiagnoseExamResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.paperSummary !== 'string') return null;
  if (typeof r.questionsDetectedCount !== 'number') return null;
  if (typeof r.totalLostScore !== 'number') return null;
  if (!Array.isArray(r.diagnosedItems)) return null;

  const meta = r.detectedMetadata;
  if (typeof meta !== 'object' || meta === null) return null;

  for (const item of r.diagnosedItems as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const it = item as Record<string, unknown>;
    if (typeof it.questionNumber !== 'string') return null;
    if (typeof it.scoreLost !== 'number') return null;
    if (typeof it.knowledgeId !== 'string') return null;
  }

  return r as unknown as DiagnoseExamResponse;
}

export function parseMicroQuizResponse(raw: unknown): MicroQuizResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return null;
    const it = item as Record<string, unknown>;
    if (typeof it.knowledgeId !== 'string') return null;
    if (typeof it.question !== 'string') return null;
    if (!Array.isArray(it.options)) return null;
    if (typeof it.correctIndex !== 'number') return null;
  }
  return { items: items as MicroQuizItem[] };
}

export type { ConfidenceLevel, ErrorType };
export type { DetectedMetadata };
