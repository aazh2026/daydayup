/**
 * 备份脚本。
 *
 * 用法：
 *   npm run backup --workspace=@daydayup/server              # 创建备份
 *   npm run backup --workspace=@daydayup/server -- --list     # 列出备份
 *   npm run backup --workspace=@daydayup/server -- --verify   # 验证全部备份
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
      console.log(
        `  ${path.basename(b.path)}  ${b.createdAt}  ${b.fileCount} 文件  ${(b.totalBytes / 1024).toFixed(1)} KB`
      );
    }
    return;
  }

  if (args.includes('--verify')) {
    const list = await backup.list();
    if (list.length === 0) {
      console.log('暂无备份可验证');
      return;
    }
    let allValid = true;
    for (const b of list) {
      const result = await backup.verify(b.path);
      const status = result.valid ? '✓ 可恢复' : `✗ 损坏（${result.corrupted.length} 个文件）`;
      console.log(`  ${path.basename(b.path)}  ${status}`);
      if (!result.valid) allValid = false;
    }
    console.log(allValid ? '\n全部备份可恢复' : '\n存在损坏的备份');
    process.exit(allValid ? 0 : 1);
  }

  // 默认：创建备份
  const label = args.find((a) => !a.startsWith('--')) ?? 'manual';
  const { path: backupPath, manifest } = await backup.create(label);
  console.log('备份创建成功：');
  console.log(`  路径:     ${backupPath}`);
  console.log(`  文件数:   ${manifest.fileCount}`);
  console.log(`  总大小:   ${(manifest.totalBytes / 1024).toFixed(1)} KB`);
  console.log(`  校验和:   ${manifest.checksum}`);

  // 创建后立即验证
  const verify = await backup.verify(backupPath);
  console.log(`  恢复验证: ${verify.valid ? '通过' : '失败'}`);
  if (!verify.valid) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('备份操作失败:', err);
  process.exit(1);
});
