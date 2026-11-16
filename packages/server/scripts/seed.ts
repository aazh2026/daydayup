/**
 * 种子数据脚本：把演示数据播种到服务端存储。
 *
 * 运行：npm run seed --workspace=@daydayup/server
 *
 * 迁移背景：分离前所有数据在浏览器 localStorage，
 * 分离后服务端需要初始数据才能提供计划/掌握度等接口。
 *
 * 数据源：packages/server/data/seed/demo-student.json（服务端自有资产，
 * 不依赖 web/ 目录，保持前后端物理边界干净）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileDatabase } from '../src/infrastructure/persistence/file-database.ts';
import { getCurriculum } from '../src/infrastructure/knowledge/curriculum.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
const db = new FileDatabase(dataDir);

interface SeedState {
  student: { id: string };
  exams: Array<{ id: string }>;
  examResults: unknown[];
  examPapers: Array<{ id: string }>;
  errorRecords: Array<{ id: string }>;
  masteryRecords: Record<string, unknown>;
  masteryHistory: unknown[];
  learningAttempts: Array<{ timestamp: string }>;
  variantQuestions: unknown[];
}

function loadSeedState(): SeedState {
  const seedPath = path.join(dataDir, 'seed', 'demo-student.json');
  if (!fs.existsSync(seedPath)) {
    throw new Error(
      `Seed asset not found: ${seedPath}\n` +
        '请先运行: npx tsx scripts/extract-seed.mjs'
    );
  }
  return JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedState;
}

async function main(): Promise<void> {
  const seed = loadSeedState();
  const student = seed.student;

  await db.write(['db', 'students', `${student.id}.json`], seed.student);

  for (const exam of seed.exams) {
    await db.write(['db', 'exams', `${exam.id}.json`], exam);
  }

  for (const paper of seed.examPapers) {
    await db.write(['db', 'papers', `${paper.id}.json`], paper);
  }

  for (const record of seed.errorRecords) {
    await db.write(['db', 'error-records', student.id, `${record.id}.json`], record);
  }

  await db.write(['db', 'mastery', `${student.id}.json`], {
    studentId: student.id,
    records: seed.masteryRecords,
    history: seed.masteryHistory,
    lastComputedAt: new Date().toISOString(),
  });

  for (const attempt of seed.learningAttempts) {
    const dateKey = attempt.timestamp.slice(0, 10);
    await db.append(
      ['db', 'attempts', student.id, `${dateKey}.jsonl`],
      JSON.stringify(attempt)
    );
  }

  const curriculum = getCurriculum();

  console.log('Seed complete:');
  console.log(`  student:    ${student.id}`);
  console.log(`  exams:      ${seed.exams.length}`);
  console.log(`  papers:     ${seed.examPapers.length}`);
  console.log(`  errors:     ${seed.errorRecords.length}`);
  console.log(`  mastery:    ${Object.keys(seed.masteryRecords).length}`);
  console.log(`  attempts:   ${seed.learningAttempts.length}`);
  console.log(`  curriculum: ${curriculum.version} (${curriculum.knowledgePoints.length} kp)`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
