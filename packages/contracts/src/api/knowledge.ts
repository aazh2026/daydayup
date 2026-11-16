/**
 * 知识体系 API 契约。
 *
 * 分离后知识体系成为服务端资产：前端不再硬编码 589 行本体，
 * 改为通过 API 拉取并缓存（staleTime 24h）。
 */

import type { Subject, KnowledgePoint } from '../domain/index.ts';

export interface CurriculumVersion {
  version: string;
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  subjects: Subject[];
  knowledgePoints: KnowledgePoint[];
}

export interface KnowledgeListResponse {
  version: string;
  knowledgePoints: KnowledgePoint[];
}

export function parseKnowledgeList(raw: unknown): KnowledgeListResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'string') return null;
  if (!Array.isArray(r.knowledgePoints)) return null;
  for (const kp of r.knowledgePoints as unknown[]) {
    if (typeof kp !== 'object' || kp === null) return null;
    const k = kp as Record<string, unknown>;
    if (typeof k.id !== 'string') return null;
    if (typeof k.name !== 'string') return null;
    if (!Array.isArray(k.prerequisites)) return null;
  }
  return r as unknown as KnowledgeListResponse;
}

export type { Subject };
export type { KnowledgePoint } from '../domain/index.ts';
