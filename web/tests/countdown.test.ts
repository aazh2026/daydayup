/**
 * 中考倒计时计算测试。
 *
 * 这是学生每天都会看到的数字（TodayPage 的「距离中考还有 N 天」）。
 *
 * 关键在时区：`new Date('2027-06-20')` 按 **UTC 零点**解析，
 * 而「今天」按**本地零点**计算。在 UTC+8 下两者差 8 小时，
 * `ceil` 会多算一天 —— 明天会显示成「2 天后」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeDaysToZhongkao } from '../src/engine/planner.ts';

describe('中考倒计时', () => {
  test('同一天算 1 天', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2026-11-17', now), 1);
  });

  test('明天算 1 天（不是 2 天）', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2026-11-18', now), 1);
  });

  test('后天算 2 天', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2026-11-19', now), 2);
  });

  test('跨月计算正确', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2026-12-17', now), 30);
  });

  test('跨年计算正确', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2027-06-20', now), 215);
  });

  test('结果不受当天时刻影响（凌晨与深夜一致）', () => {
    const early = new Date(2026, 10, 17, 0, 5, 0);
    const late = new Date(2026, 10, 17, 23, 55, 0);
    assert.equal(
      computeDaysToZhongkao('2026-11-18', early),
      computeDaysToZhongkao('2026-11-18', late)
    );
  });

  test('过去日期下限为 1', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('2020-06-20', now), 1);
  });

  test('非法日期回退为 200', () => {
    const now = new Date(2026, 10, 17, 13, 0, 0);
    assert.equal(computeDaysToZhongkao('not-a-date', now), 200);
    assert.equal(computeDaysToZhongkao('', now), 200);
  });
});
