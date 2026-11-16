/**
 * 服务端入口。
 */
import 'dotenv/config';
import { createContainer } from './bootstrap/container.ts';
import { createApp } from './app.ts';
import { logger } from './infrastructure/logging/logger.ts';

async function main(): Promise<void> {
  const container = createContainer();
  const app = createApp(container);

  if (!container.config.geminiApiKey) {
    logger.warn('boot.no_api_key', {
      message: 'GEMINI_API_KEY 未配置，AI 相关接口将返回错误，其余接口可用',
    });
  }

  const server = app.listen(container.config.port, container.config.host, () => {
    logger.info('boot.listening', {
      port: container.config.port,
      host: container.config.host,
      aiEnabled: Boolean(container.ai),
    });
    console.log(
      `Server listening on http://${container.config.host === '0.0.0.0' ? 'localhost' : container.config.host}:${container.config.port}`
    );
  });

  const shutdown = (signal: string) => {
    logger.info('boot.shutdown', { signal });
    server.close(() => process.exit(0));
    // 兜底：10 秒后强制退出
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('boot.failed', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
