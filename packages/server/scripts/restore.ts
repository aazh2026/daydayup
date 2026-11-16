/**
 * 恢复脚本。
 *
 * 用法：
 *   npm run restore --workspace=@daydayup/server -- --list                    # 列出备份
 *   npm run restore --workspace=@daydayup/server -- --name <备份名> --dry-run # 仅校验
 *   npm run restore --workspace=@daydayup/server -- --name <备份名>           # 实际恢复
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupService } from '../src/infrastructure/backup/backup-service.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(
  process.env.DATA_DIR ?? path.resolve(__dirname, '../data')
);
const backupDir = path.resolve(
  process.env.BACKUP_DIR ?? path.resolve(dataDir, '..', 'backups')
);

async function main(): Promise<void> {
  const backup = new BackupService(dataDir, backupDir);
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const list = await backup.list();
    if (list.length === 0) {
      console.log('暂无备份');
      return;
    }
    console.log(`可用备份（${list.length} 个）：`);
    for (const b of list) {
      console.log(`  ${path.basename(b.path)}  ${b.createdAt}`);
    }
    return;
  }

  const nameIndex = args.indexOf('--name');
  if (nameIndex === -1 || !args[nameIndex + 1]) {
    console.error('用法: npm run restore -- --name <备份名> [--dry-run]');
    process.exit(1);
  }

  const name = args[nameIndex + 1];
  const dryRun = args.includes('--dry-run');

  const list = await backup.list();
  const target = list.find((b) => b.path.endsWith(name));
  if (!target) {
    console.error(`备份不存在: ${name}`);
    console.error('可用备份:');
    for (const b of list) console.error(`  ${path.basename(b.path)}`);
    process.exit(1);
  }

  console.log(`目标备份: ${target.path}`);
  console.log(`创建时间: ${target.createdAt}`);
  console.log(`文件数:   ${target.fileCount}`);
  console.log('');

  if (dryRun) {
    console.log('=== 试运行（不写入）===');
    const result = await backup.restore(target.path, { dryRun: true });
    console.log(`可恢复: ${result.restored}`);
    console.log(`损坏:   ${result.mismatched.length}`);
    console.log(`缺失:   ${result.skipped.length}`);
    return;
  }

  console.log('=== 执行恢复 ===');
  const result = await backup.restore(target.path);
  console.log(`已恢复: ${result.restored}`);
  console.log(`损坏:   ${result.mismatched.length}`);
  console.log(`缺失:   ${result.skipped.length}`);

  if (result.mismatched.length > 0) {
    console.log('\n损坏文件:');
    for (const m of result.mismatched) console.log(`  ${m}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('恢复失败:', err);
  process.exit(1);
});
