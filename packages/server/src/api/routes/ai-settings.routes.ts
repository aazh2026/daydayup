/**
 * AI 配置管理路由（老师/管理员）。
 *
 * 这是「AI 配置能力」的服务端入口：
 * - `GET  /api/v1/admin/ai-settings`          读取当前生效配置（Key 已掩码）
 * - `PUT  /api/v1/admin/ai-settings`          修改配置（立即生效，无需重启）
 * - `POST /api/v1/admin/ai-settings/test`      连通性测试（返回耗时与错误）
 * - `POST /api/v1/admin/ai-settings/reset`     清除运行时配置，回落环境变量
 *
 * 安全约束：
 * - 明文 API Key **永不出现在响应里**，只返回 `hasApiKey` + 掩码；
 * - 审计留痕（`ConfigChanged`），但 payload 里不含明文 Key；
 * - 仅 `teacher` 角色可访问（复用 `requireAdmin`）。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Container } from '../../bootstrap/container.ts';
import { ApiException } from '../middleware/error-handler.ts';
import { requireAdmin } from '../middleware/require-role.ts';
import { logger } from '../../infrastructure/logging/logger.ts';
import {
  AI_MODEL_OPTIONS,
  AI_CONFIG_LIMITS,
  validateAIConfigUpdate,
  type TestAIConnectionResult,
  type UpdateAIConfigRequest,
} from '@daydayup/contracts';

export function createAiSettingsRoutes(container: Container): Router {
  const router = Router();

  /**
   * GET /api/v1/admin/ai-settings
   * 读取当前生效配置。
   */
  router.get(
    '/admin/ai-settings',
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const config = await container.aiConfig.getPublic();
        res.json({
          config,
          models: AI_MODEL_OPTIONS,
          limits: AI_CONFIG_LIMITS,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PUT /api/v1/admin/ai-settings
   * 修改配置。保存后立即生效。
   */
  router.put(
    '/admin/ai-settings',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const errors = validateAIConfigUpdate(req.body);
        if (errors.length > 0) {
          throw new ApiException(
            'VALIDATION_FAILED',
            `AI 配置校验失败：${errors.join('；')}`,
            { errors }
          );
        }

        const patch = req.body as UpdateAIConfigRequest;
        const updated = await container.aiConfig.update(
          patch,
          req.auth?.principalId ?? null
        );

        // 让运行时立刻感知新配置（Provider 重建 / 热更新）
        await container.aiRuntime.refresh();
        // 每日配额也是运行时可配的 → 同步给配额服务
        container.quota.setLimit(updated.dailyQuota);

        await container.audit.record('ConfigChanged', {
          aggregateId: 'ai-settings',
          actor: req.auth?.principalId ?? 'anonymous',
          actorRole: req.auth?.role,
          ip: req.ip,
          requestId: req.requestId,
          payload: {
            scope: 'ai-settings',
            model: updated.model,
            temperature: updated.temperature,
            timeoutMs: updated.timeoutMs,
            maxRetries: updated.maxRetries,
            dailyQuota: updated.dailyQuota,
            enabled: updated.enabled,
            // 只记录「Key 是否被改动」，不记录明文
            apiKeyChanged: Boolean(patch.apiKey && patch.apiKey.length > 0),
          },
        });

        logger.info('ai.settings_updated', { actor: req.auth?.principalId });

        const config = await container.aiConfig.getPublic();
        res.json({ config, models: AI_MODEL_OPTIONS, limits: AI_CONFIG_LIMITS });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/admin/ai-settings/test
   * 连通性测试：用当前配置发一次最小请求，返回耗时与错误。
   */
  router.post(
    '/admin/ai-settings/test',
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      const startedAt = Date.now();
      const testedAt = new Date().toISOString();
      let model = '';

      try {
        const current = await container.aiConfig.get();
        model = current.model;

        if (!current.enabled) {
          const result: TestAIConnectionResult = {
            ok: false,
            error: 'AI 能力当前已禁用，请先启用后再测试',
            model,
            latencyMs: Date.now() - startedAt,
            testedAt,
          };
          res.json(result);
          return;
        }

        if (!current.apiKey) {
          const result: TestAIConnectionResult = {
            ok: false,
            error: '尚未配置 API Key',
            model,
            latencyMs: Date.now() - startedAt,
            testedAt,
          };
          res.json(result);
          return;
        }

        const ai = await container.aiRuntime.resolve();
        if (!ai) {
          const result: TestAIConnectionResult = {
            ok: false,
            error: 'AI Provider 不可用',
            model,
            latencyMs: Date.now() - startedAt,
            testedAt,
          };
          res.json(result);
          return;
        }

        // 最小 schema 调用：够验证 Key/模型/网络/权限
        const response = await ai.generateJson<{ ok: boolean }>({
          purpose: 'coach',
          prompt: '请返回一个 JSON 对象，其 ok 字段为 true。不要输出其他内容。',
          schema: {
            type: 'OBJECT',
            properties: { ok: { type: 'BOOLEAN', description: '固定为 true' } },
            required: ['ok'],
          },
          maxRetries: 1,
        });

        const result: TestAIConnectionResult = {
          ok: response.validated === true && response.data?.ok === true,
          error: response.validated ? null : (response.error ?? '返回结果不合法'),
          model: response.model || model,
          latencyMs: Date.now() - startedAt,
          testedAt,
        };

        res.json(result);
      } catch (err) {
        // 测试失败不是接口错误 —— 返回结构化失败结果，前端直接展示
        const result: TestAIConnectionResult = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          model,
          latencyMs: Date.now() - startedAt,
          testedAt,
        };
        logger.warn('ai.settings_test_failed', { error: result.error });
        res.json(result);
      }
    }
  );

  /**
   * POST /api/v1/admin/ai-settings/reset
   * 清除运行时配置，回落到环境变量默认值。
   */
  router.post(
    '/admin/ai-settings/reset',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const restored = await container.aiConfig.reset();
        await container.aiRuntime.refresh();
        container.quota.setLimit(restored.dailyQuota);

        await container.audit.record('ConfigChanged', {
          aggregateId: 'ai-settings',
          actor: req.auth?.principalId ?? 'anonymous',
          actorRole: req.auth?.role,
          ip: req.ip,
          requestId: req.requestId,
          payload: { scope: 'ai-settings', action: 'reset' },
        });

        const config = await container.aiConfig.getPublic();
        res.json({ config, models: AI_MODEL_OPTIONS, limits: AI_CONFIG_LIMITS });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
