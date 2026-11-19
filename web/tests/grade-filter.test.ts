import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGradeInfo,
  buildGradeOptions,
  filterByGrade,
} from '../src/utils/grade.ts';

describe('年级解析 resolveGradeInfo', () => {
  test('初三年级识别（九年级/初三/九全/九上/九下）', () => {
    assert.deepEqual(resolveGradeInfo('九年级上册 第二十一章 一元二次方程'), {
      stage: '初中',
      grade: '初三',
      label: '初三（九年级）',
    });
    assert.deepEqual(resolveGradeInfo('初三数学模拟考'), {
      stage: '初中',
      grade: '初三',
      label: '初三（九年级）',
    });
    assert.deepEqual(resolveGradeInfo('九全 第二十章 电与磁 20.1'), {
      stage: '初中',
      grade: '初三',
      label: '初三（九年级）',
    });
    assert.deepEqual(resolveGradeInfo('九下 第26章 反比例函数'), {
      stage: '初中',
      grade: '初三',
      label: '初三（九年级）',
    });
  });

  test('初二年级识别（八年级/初二/八全/八上/八下）', () => {
    assert.deepEqual(resolveGradeInfo('八上 第一章 三角形'), {
      stage: '初中',
      grade: '初二',
      label: '初二（八年级）',
    });
    assert.deepEqual(resolveGradeInfo('八下 第16章 二次根式'), {
      stage: '初中',
      grade: '初二',
      label: '初二（八年级）',
    });
    assert.deepEqual(resolveGradeInfo('初二物理机械运动'), {
      stage: '初中',
      grade: '初二',
      label: '初二（八年级）',
    });
  });

  test('初一年级识别（七年级/初一/七上/七下）', () => {
    assert.deepEqual(resolveGradeInfo('七上 第一章 有理数 1.1'), {
      stage: '初中',
      grade: '初一',
      label: '初一（七年级）',
    });
    assert.deepEqual(resolveGradeInfo('七下 第五章 相交线与平行线'), {
      stage: '初中',
      grade: '初一',
      label: '初一（七年级）',
    });
    assert.deepEqual(resolveGradeInfo('初一英语音标专项'), {
      stage: '初中',
      grade: '初一',
      label: '初一（七年级）',
    });
  });

  test('小学阶段识别（一至六年级）', () => {
    assert.deepEqual(resolveGradeInfo('一年级上册 第1单元 5以内数的认识和加、减法'), {
      stage: '小学',
      grade: '小学',
      label: '小学阶段',
    });
    assert.deepEqual(resolveGradeInfo('三年级下册 第2单元 除数是一位数的除法'), {
      stage: '小学',
      grade: '小学',
      label: '小学阶段',
    });
    assert.deepEqual(resolveGradeInfo('六上 第1单元 分数乘法'), {
      stage: '小学',
      grade: '小学',
      label: '小学阶段',
    });
  });

  test('高中阶段识别（必修/选必/高中）', () => {
    assert.deepEqual(resolveGradeInfo('必修第一册 第一章 集合与常用逻辑用语'), {
      stage: '高中',
      grade: '高中',
      label: '高中阶段',
    });
    assert.deepEqual(resolveGradeInfo('选择性必修第一册 空间向量与立体几何'), {
      stage: '高中',
      grade: '高中',
      label: '高中阶段',
    });
  });

  test('未明确章节兜底为初三', () => {
    assert.deepEqual(resolveGradeInfo('综合总复习'), {
      stage: '初中',
      grade: '初三',
      label: '初三（九年级）',
    });
  });
});

describe('年级筛选项 buildGradeOptions / filterByGrade', () => {
  const mockKps = [
    { id: 'kp-j3', chapter: '九年级上册 第21章 一元二次方程' },
    { id: 'kp-j3-2', chapter: '九下 第27章 相似' },
    { id: 'kp-j2', chapter: '八年级下册 第19章 一次函数' },
    { id: 'kp-j1', chapter: '七年级上册 第2章 有理数' },
    { id: 'kp-p', chapter: '六上 第1章 分数乘法' },
    { id: 'kp-s', chapter: '必修第一册 第一章 集合与常用逻辑用语' },
  ];

  test('筛选项仅产出确有考点的年级/学段，并携带计数', () => {
    const options = buildGradeOptions(mockKps);
    assert.deepEqual(options[0], { id: 'all', label: '全部年级', count: 6 });

    const byId = new Map(options.map((o) => [o.id, o]));
    assert.equal(byId.get('初三')?.count, 2);
    assert.equal(byId.get('初二')?.count, 1);
    assert.equal(byId.get('初一')?.count, 1);
    assert.equal(byId.get('junior')?.count, 4);
    assert.equal(byId.get('primary')?.count, 1);
    assert.equal(byId.get('senior')?.count, 1);
  });

  test('无某年级考点时不产出该年级筛选项', () => {
    const options = buildGradeOptions([
      { chapter: '九年级上册 第21章 一元二次方程' },
    ]);
    assert.deepEqual(
      options.map((o) => o.id),
      ['all', '初三']
    );
  });

  test('按年级筛选返回对应考点', () => {
    assert.deepEqual(
      filterByGrade(mockKps, '初三').map((k) => k.id),
      ['kp-j3', 'kp-j3-2']
    );
    assert.deepEqual(
      filterByGrade(mockKps, '初二').map((k) => k.id),
      ['kp-j2']
    );
    assert.equal(filterByGrade(mockKps, 'all').length, 6);
    assert.equal(filterByGrade(mockKps, '').length, 6);
  });

  test('按学段筛选（初中/小学/高中）', () => {
    assert.equal(filterByGrade(mockKps, 'junior').length, 4);
    assert.deepEqual(
      filterByGrade(mockKps, 'primary').map((k) => k.id),
      ['kp-p']
    );
    assert.deepEqual(
      filterByGrade(mockKps, 'senior').map((k) => k.id),
      ['kp-s']
    );
  });
});
