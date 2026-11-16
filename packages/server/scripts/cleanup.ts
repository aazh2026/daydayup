/**
 * 数据保留清理脚本。
 *
 * 用法：npm run cleanup --workspace=@daydayup/server
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import { FileStorage } from '../src/infrastructure/storage/file-storage.ts';
import { RetentionService } from '../src/infrastructure/retention/retention-service.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(
  process.env.DATA_DIR ?? path.resolve(__dirname, '../data')
);

async function main(): Promise<void> {
  const db = new FileDatabase(dataDir);
  const storage = new FileStorage({ dataDir });
  const retention = new RetentionService(db, storage);

  const result = await retention.cleanup();
  console.log('清理完成：');
  console.log(`  事件日志:   ${result.deleted.eventLogs}`);
  console.log(`  作答流水:   ${result.deleted.attemptLogs}`);
  console.log(`  完成任务:   ${result.deleted.jobs}`);
  console.log(`  上传文件:   ${result.deleted.uploads}`);
  console.log(`  执行时间:   ${result.ranAt}`);
}

main().catch((err) => {
  console.error('清理失败:', err);
  process.exit(1);
});
