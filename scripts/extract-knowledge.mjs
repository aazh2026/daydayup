/**
 * 一次性迁移脚本：将 src/data/shanghaiCurriculum.ts 中的知识本体与题库
 * 抽取为服务端 JSON 资产。
 *
 * 运行：node scripts/extract-knowledge.mjs
 * 迁移完成后可删除本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const srcPath = path.join(root, 'src/data/shanghaiCurriculum.ts');
const outKnowledge = path.join(root, 'packages/server/data/knowledge/shanghai-junior-2026.1.json');
const outBank = path.join(root, 'packages/server/data/questions/bank.json');

const src = fs.readFileSync(srcPath, 'utf8');

// 通过动态 import 加载 TS 模块（使用 tsx 运行本脚本时可用）
const mod = await import(path.join(root, 'src/data/shanghaiCurriculum.ts'));
const { SHANGHAI_CURRICULUM, VERIFIED_QUESTION_BANK } = mod;

const curriculum = {
  version: 'shanghai-junior-2026.1',
  publishedAt: '2026-11-17T00:00:00.000Z',
  status: 'ACTIVE',
  subjects: [...new Set(SHANGHAI_CURRICULUM.map((k) => k.subject))],
  knowledgePoints: SHANGHAI_CURRICULUM,
};

fs.mkdirSync(path.dirname(outKnowledge), { recursive: true });
fs.mkdirSync(path.dirname(outBank), { recursive: true });

fs.writeFileSync(outKnowledge, JSON.stringify(curriculum, null, 2) + '\n', 'utf8');
fs.writeFileSync(
  outBank,
  JSON.stringify({ version: 'bank-2026.1', questions: VERIFIED_QUESTION_BANK }, null, 2) + '\n',
  'utf8'
);

console.log(`knowledge points: ${curriculum.knowledgePoints.length}`);
console.log(`questions: ${VERIFIED_QUESTION_BANK.length}`);
console.log(`-> ${path.relative(root, outKnowledge)}`);
console.log(`-> ${path.relative(root, outBank)}`);
