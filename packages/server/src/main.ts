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

  // ---- 启动 Job Engine（会恢复上次崩溃遗留的任务）----
  await container.jobEngine.start();

  const shutdown = async (signal: string) => {
    logger.info('boot.shutdown', { signal });
    // 优雅退出：等待进行中的任务完成
    await container.jobEngine.stop();
    server.close(() => process.exit(0));
    // 兜底：10 秒后强制退出
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('boot.failed', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
