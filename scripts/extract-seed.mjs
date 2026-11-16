/**
 * 一次性迁移脚本：把前端 initialStore.ts 的演示数据导出为服务端 JSON 资产。
 *
 * 目的：让服务端的 seed 脚本不再依赖 web/ 目录，消除最后一条反向依赖。
 * 运行：npx tsx scripts/extract-seed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const mod = await import(path.join(root, 'web/src/data/initialStore.ts'));
const s = mod.INITIAL_APP_STATE;

const out = {
  student: s.student,
  exams: s.exams,
  examResults: s.examResults,
  examPapers: s.examPapers,
  errorRecords: s.errorRecords,
  masteryRecords: s.masteryRecords,
  masteryHistory: s.masteryHistory,
  learningAttempts: s.learningAttempts,
  variantQuestions: s.variantQuestions,
};

const target = path.join(root, 'packages/server/data/seed/demo-student.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(`-> ${path.relative(root, target)}`);
console.log(`student: ${out.student.id}, mastery: ${Object.keys(out.masteryRecords).length}`);
