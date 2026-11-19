/**
 * 题庄（tizhuang）外部真题路由。
 *
 * 用途：项目自有题库（`data/questions/`）按**知识点**组织，覆盖面有限；
 * 题庄提供**真实中考真题**（含年份、卷别、来源），按知识点树组织。
 * 本路由把两者桥接起来：
 *
 *   原生知识点 id → 知识点名 → 题庄知识点节点 → 题庄题目 → contracts Question
 *
 * ── 降级语义（重要）──────────────────────────────────────────────────────
 *
 * 前端 `CoachPage` 的既有约定是「题库未命中 → found:false → 转 AI 生成」。
 * 因此：
 * - **未命中 / 无映射** → HTTP 200 + `{found:false, questions:[], reason}`；
 * - **配额耗尽 / 网络不可用** → HTTP 200 + `{found:false, questions:[], reason}`
 *   （这两类是"外部服务临时不可用"，前端应继续走 AI 生成，不该报错）；
 * - **鉴权失败** → HTTP 503 + 同样的 body 形状 + `reason:'TIZHUANG_AUTH_FAILED'`。
 *   理由：鉴权失败不是"没有题"，而是**服务配置错误**（缺 license / 令牌失效），
 *   继续返回 200 会让监控与用户都以为"只是没查到题"，问题会被长期掩盖；
 *   503 让告警生效，同时 body 里仍然带 `found:false`，前端无需特判也能优雅降级。
 *
 * 两种失败都带 `reason`（机器可读码），前端可据此区分「无题」与「服务异常」。
 *
 * ── 配额纪律 ──────────────────────────────────────────────────────────────
 *
 * 匿名试用每天仅 50 题（已注册 150 题）。因此本路由**默认缓存优先**：
 * 缓存里已有足够题目时不再发在线请求；只有 `forceOnline=1` 才强制联网。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { getCurriculum, getKnowledgeMap } from '../../infrastructure/knowledge/curriculum.ts';
import { resolveKnowledgeIds } from '../../infrastructure/knowledge/id-aliases.ts';
import {
  fetchTizhuangKnowledgePoints,
  fetchTizhuangQuestions,
  TizhuangError,
  TIZHUANG_SUBJECT_IDS,
  type TizhuangConfig,
  type TizhuangKnowledgePoint,
  type TizhuangQuestion,
} from '../../infrastructure/question-bank/tizhuang.ts';
import {
  matchTizhuangKnowledgeNodes,
  mapTizhuangKnowledgeNames,
  type KnowledgePointLite,
} from '../../infrastructure/question-bank/knowledge-mapping.ts';
import {
  selectCachedByKnowledge,
  upsertQuestions,
  type CachedTizhuangQuestion,
} from '../../infrastructure/question-bank/tizhuang-cache.ts';
import { toContractQuestion } from '../../infrastructure/question-bank/tizhuang-adapter.ts';

/** 外部真题路由的响应体 */
export interface ExternalQuestionsResponse {
  found: boolean;
  source: 'tizhuang';
  questions: unknown[];
  /** 今日剩余配额（服务端未给则 null） */
  quotaRemaining: number | null;
  /** 解析后的原生知识点 id */
  resolvedKnowledgeId?: string;
  /** 降级原因（机器可读码）：NO_KNOWLEDGE_MAPPING / NO_QUESTIONS / TIZHUANG_* */
  reason?: string;
  /** 人类可读说明 */
  message?: string;
}

/** 便于测试注入：路由的外部依赖 */
export interface TizhuangRouteDeps {
  /** 覆盖题庄客户端配置（测试注入假 fetch） */
  tizhuangConfig?: TizhuangConfig;
}

function resolveSubjectId(subject: string): number | undefined {
  return TIZHUANG_SUBJECT_IDS[subject];
}

function toLitePoints(): KnowledgePointLite[] {
  const points = getCurriculum().knowledgePoints;
  return points.map((p) => ({
    id: p.id,
    name: p.name,
    domain: p.domain,
    chapter: p.chapter,
    subject: p.subject,
  }));
}

/** 缓存里的题 → contracts Question */
function cachedToContract(
  items: CachedTizhuangQuestion[],
  points: KnowledgePointLite[],
  fallbackKnowledgeIds: string[]
) {
  return items.map((item) =>
    toContractQuestion(item, points, fallbackKnowledgeIds)
  );
}

/**
 * 创建题庄外部真题路由。
 *
 * @param container 应用容器（保留给后续按用户配额/配置扩展）
 * @param deps      可选依赖注入（测试用）
 */
export function createTizhuangRoutes(
  container: Container,
  deps?: TizhuangRouteDeps
): Router {
  const router = Router();
  void container;

  /**
   * GET /api/v1/practice/external?knowledgeId=xxx&limit=10&questionType=&forceOnline=1
   *
   * - `knowledgeId`  必填，可以是原生 id，也可以是外部 id（内部 resolveKnowledgeIds 解析）
   * - `limit`        最多返回多少道题，默认 10，上限 50
   * - `questionType` 可选，题庄题型名（如 '选择题'）
   * - `forceOnline`  为 1 时跳过缓存，强制走在线拉取（会消耗题庄配额）
   */
  router.get(
    '/practice/external',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawKnowledgeId = String(req.query.knowledgeId ?? '').trim();
        if (!rawKnowledgeId) {
          res.status(400).json({
            error: { code: 'VALIDATION_FAILED', message: '缺少 knowledgeId' },
            requestId: req.requestId,
          });
          return;
        }

        const limitRaw = Number(req.query.limit ?? 10);
        const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));
        const questionType = req.query.questionType
          ? String(req.query.questionType).trim()
          : undefined;
        const forceOnline =
          String(req.query.forceOnline ?? '') === '1' ||
          String(req.query.forceOnline ?? '').toLowerCase() === 'true';

        // ① 外部 id → 原生 id
        const resolved = resolveKnowledgeIds([rawKnowledgeId]);
        if (resolved.resolved.length === 0) {
          res.json({
            found: false,
            source: 'tizhuang',
            questions: [],
            quotaRemaining: null,
            reason: 'NO_KNOWLEDGE_MAPPING',
            message: `未找到对应知识点：${rawKnowledgeId}`,
          } satisfies ExternalQuestionsResponse);
          return;
        }
        const nativeId = resolved.resolved[0];
        const point = getKnowledgeMap()[nativeId];
        if (!point) {
          res.json({
            found: false,
            source: 'tizhuang',
            questions: [],
            quotaRemaining: null,
            resolvedKnowledgeId: nativeId,
            reason: 'NO_KNOWLEDGE_MAPPING',
            message: `知识点不在当前课程资产中：${nativeId}`,
          } satisfies ExternalQuestionsResponse);
          return;
        }

        const subjectId = resolveSubjectId(point.subject);
        if (!subjectId) {
          res.json({
            found: false,
            source: 'tizhuang',
            questions: [],
            quotaRemaining: null,
            resolvedKnowledgeId: nativeId,
            reason: 'UNSUPPORTED_SUBJECT',
            message: `题庄暂未覆盖学科：${point.subject}`,
          } satisfies ExternalQuestionsResponse);
          return;
        }

        const points = toLitePoints();

        // ② 缓存优先：够用就不联网（配额紧张，这是默认路径）
        if (!forceOnline) {
          const cached = selectCachedByKnowledge(point.subject, nativeId, 0).filter(
            (item) => !questionType || item.questionType === questionType
          );
          if (cached.length >= limit) {
            res.json({
              found: true,
              source: 'tizhuang',
              questions: cachedToContract(cached.slice(0, limit), points, [nativeId]),
              quotaRemaining: null,
              resolvedKnowledgeId: nativeId,
            } satisfies ExternalQuestionsResponse);
            return;
          }
        }

        // ③ 反查题庄知识点节点
        let nodes: TizhuangKnowledgePoint[];
        try {
          nodes = await fetchTizhuangKnowledgePoints(subjectId, {
            ...deps?.tizhuangConfig,
            limit: 1000,
          });
        } catch (err) {
          const handled = handleTizhuangError(err, res, nativeId);
          if (handled) return;
          throw err;
        }

        const nodeMatches = matchTizhuangKnowledgeNodes(point.name, nodes, points);
        if (nodeMatches.length === 0) {
          res.json({
            found: false,
            source: 'tizhuang',
            questions: [],
            quotaRemaining: null,
            resolvedKnowledgeId: nativeId,
            reason: 'NO_KNOWLEDGE_MAPPING',
            message: `题庄未收录该知识点：${point.name}`,
          } satisfies ExternalQuestionsResponse);
          return;
        }

        // ④ 在线取题（消耗配额）：优先精确 knowledge_id，再退回上层节点
        const wanted = Math.min(limit * 2, 100);
        let fetched: { items: TizhuangQuestion[]; quotaRemaining: number | null } | null =
          null;
        let quotaRemaining: number | null = null;
        const candidates = nodeMatches.slice(0, 3);
        for (const candidate of candidates) {
          try {
            const result = await fetchTizhuangQuestions(
              {
                subjectId,
                knowledgeId: candidate.node.knowledgeId,
                limit: wanted,
              },
              deps?.tizhuangConfig
            );
            quotaRemaining = result.quotaRemaining;
            if (result.items.length > 0) {
              fetched = { items: result.items, quotaRemaining: result.quotaRemaining };
              break;
            }
            if (!fetched) {
              fetched = { items: [], quotaRemaining: result.quotaRemaining };
            }
          } catch (err) {
            const handled = handleTizhuangError(err, res, nativeId);
            if (handled) return;
            throw err;
          }
        }

        const onlineItems = fetched?.items ?? [];

        // ⑤ 知识点名 → 项目原生 id，并落缓存
        const mapped: CachedTizhuangQuestion[] = onlineItems.map((item) => {
          const matches = mapTizhuangKnowledgeNames(item.knowledgeNames, points);
          const knowledgeIds: string[] = [];
          for (const m of matches) {
            if (m.id && !knowledgeIds.includes(m.id)) knowledgeIds.push(m.id);
          }
          if (!knowledgeIds.includes(nativeId)) knowledgeIds.unshift(nativeId);
          return {
            ...item,
            knowledgeIds,
            fetchedAt: new Date().toISOString(),
          };
        });

        if (mapped.length > 0) {
          upsertQuestions(point.subject, mapped);
        }

        const finalItems = (
          questionType
            ? mapped.filter((m) => m.questionType === questionType)
            : mapped
        ).slice(0, limit);

        res.json({
          found: finalItems.length > 0,
          source: 'tizhuang',
          questions: cachedToContract(finalItems, points, [nativeId]),
          quotaRemaining,
          resolvedKnowledgeId: nativeId,
          ...(finalItems.length === 0
            ? {
                reason: 'NO_QUESTIONS',
                message: `题庄未返回该知识点的题目：${point.name}`,
              }
            : {}),
        } satisfies ExternalQuestionsResponse);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

/**
 * 题庄错误的降级处理。
 *
 * @returns true 表示已写响应（调用方应直接 return），false 表示应继续向上抛
 */
function handleTizhuangError(
  err: unknown,
  res: Response,
  nativeId: string
): boolean {
  if (!(err instanceof TizhuangError)) return false;

  const base = {
    found: false,
    source: 'tizhuang' as const,
    questions: [] as unknown[],
    quotaRemaining: err.quotaRemaining,
    resolvedKnowledgeId: nativeId,
    reason: err.code,
    message: err.message,
  };

  if (err.code === 'TIZHUANG_AUTH_FAILED') {
    // 服务配置问题 → 503（见文件头降级语义说明）
    res.status(503).json(base);
    return true;
  }

  // 配额 / 网络 / 响应异常 → 200 + found:false，前端继续走 AI 生成
  res.json(base);
  return true;
}
