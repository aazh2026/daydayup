import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorRecord } from '@daydayup/contracts';

describe('错题多维筛选与聚合计算', () => {
  const mockErrors: ErrorRecord[] = [
    {
      id: 'err-1',
      examId: 'exam-midterm',
      examTitle: '期中考试',
      questionNumber: '第14题',
      subject: '数学',
      stem: '化简分式方程',
      studentAnswer: 'x = 3',
      correctAnswer: '增根舍去，原方程无解',
      scoreLost: 4,
      errorType: '计算问题',
      knowledgeId: 'cnm_165',
      knowledgeName: '分式方程与增根',
      aiAnalysis: '未检验分母为0',
      evidence: '期中第14题',
      confidence: '确定',
      verificationMethod: '完成2道分式微测',
      status: '未订正',
      createdAt: '2026-11-08T10:00:00.000Z',
    },
    {
      id: 'err-2',
      examId: 'exam-midterm',
      examTitle: '期中考试',
      questionNumber: '第16题',
      subject: '数学',
      stem: '一次函数平移',
      studentAnswer: 'y = 2x + 4',
      correctAnswer: 'y = 2x - 4',
      scoreLost: 6,
      errorType: '知识问题',
      knowledgeId: 'cnm_204',
      knowledgeName: '一次函数图象平移',
      aiAnalysis: '上加下减符号混淆',
      evidence: '期中第16题',
      confidence: '较可能',
      verificationMethod: '完成3道图像平移微测',
      status: '待复测',
      createdAt: '2026-11-08T10:05:00.000Z',
    },
    {
      id: 'err-3',
      examId: 'exam-oct',
      examTitle: '10月阶段考',
      questionNumber: '第8题',
      subject: '数学',
      stem: '分式方程求解',
      studentAnswer: 'x = 1',
      correctAnswer: '原方程无解',
      scoreLost: 3,
      errorType: '计算问题',
      knowledgeId: 'cnm_165',
      knowledgeName: '分式方程与增根',
      aiAnalysis: '同样未验增根',
      evidence: '10月阶段考第8题',
      confidence: '确定',
      verificationMethod: '分式专项测试',
      status: '已闭环',
      createdAt: '2026-10-15T10:00:00.000Z',
    },
    {
      id: 'err-4',
      examId: 'exam-midterm',
      examTitle: '期中考试',
      questionNumber: 'Part 2 Q48',
      subject: '英语',
      stem: 'It is ____ (polite) to talk loudly',
      studentAnswer: 'politely',
      correctAnswer: 'impolite',
      scoreLost: 2,
      errorType: '审题问题',
      knowledgeId: 'cne_001',
      knowledgeName: '词性转换',
      aiAnalysis: '看漏语境否定词',
      evidence: '英语期中第48题',
      confidence: '待验证',
      verificationMethod: '前缀词汇微测',
      status: '未订正',
      createdAt: '2026-11-08T11:00:00.000Z',
    },
  ];

  it('按学科精准筛选', () => {
    const mathErrors = mockErrors.filter((e) => e.subject === '数学');
    assert.equal(mathErrors.length, 3);
    const engErrors = mockErrors.filter((e) => e.subject === '英语');
    assert.equal(engErrors.length, 1);
  });

  it('按置信度等级分级筛选', () => {
    const confirmed = mockErrors.filter((e) => e.confidence === '确定');
    assert.equal(confirmed.length, 2);
    const probable = mockErrors.filter((e) => e.confidence === '较可能');
    assert.equal(probable.length, 1);
    const pending = mockErrors.filter((e) => e.confidence === '待验证');
    assert.equal(pending.length, 1);
  });

  it('按闭环状态筛选与统计', () => {
    const uncorrected = mockErrors.filter((e) => e.status === '未订正');
    const pendingRetest = mockErrors.filter((e) => e.status === '待复测');
    const closed = mockErrors.filter((e) => e.status === '已闭环');

    assert.equal(uncorrected.length, 2);
    assert.equal(pendingRetest.length, 1);
    assert.equal(closed.length, 1);
  });

  it('跨考试高频漏洞聚合识别（cnm_165 跨2次考试）', () => {
    const map: Record<string, { count: number; exams: Set<string>; lost: number }> = {};
    for (const err of mockErrors) {
      if (!map[err.knowledgeId]) {
        map[err.knowledgeId] = { count: 0, exams: new Set(), lost: 0 };
      }
      map[err.knowledgeId].count += 1;
      map[err.knowledgeId].exams.add(err.examTitle);
      map[err.knowledgeId].lost += err.scoreLost;
    }

    assert.equal(map['cnm_165'].count, 2);
    assert.equal(map['cnm_165'].exams.size, 2);
    assert.equal(map['cnm_165'].lost, 7);
  });

  it('按失分从高到低排序', () => {
    const sorted = [...mockErrors].sort((a, b) => b.scoreLost - a.scoreLost);
    assert.equal(sorted[0].id, 'err-2'); // 6分
    assert.equal(sorted[1].id, 'err-1'); // 4分
    assert.equal(sorted[2].id, 'err-3'); // 3分
    assert.equal(sorted[3].id, 'err-4'); // 2分
  });
});
