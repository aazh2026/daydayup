/**
 * 分页计算与切片逻辑单元测试
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePagination,
  paginateList,
  getPageNumbers,
} from '../src/utils/pagination.ts';

describe('分页计算 computePagination', () => {
  test('空数据时默认第 1 页，总页数 1', () => {
    const res = computePagination(0, 1, 10);
    assert.equal(res.currentPage, 1);
    assert.equal(res.totalPages, 1);
    assert.equal(res.startIndex, 0);
    assert.equal(res.endIndex, 0);
    assert.equal(res.totalItems, 0);
  });

  test('正常分页跨度计算', () => {
    const res = computePagination(25, 2, 10);
    assert.equal(res.currentPage, 2);
    assert.equal(res.totalPages, 3);
    assert.equal(res.startIndex, 10);
    assert.equal(res.endIndex, 20);
  });

  test('末页元素不足一整页时正确截断', () => {
    const res = computePagination(25, 3, 10);
    assert.equal(res.currentPage, 3);
    assert.equal(res.totalPages, 3);
    assert.equal(res.startIndex, 20);
    assert.equal(res.endIndex, 25);
  });

  test('请求页码超出最大页数时自动回退至末页', () => {
    const res = computePagination(15, 999, 5);
    assert.equal(res.currentPage, 3);
    assert.equal(res.totalPages, 3);
    assert.equal(res.startIndex, 10);
    assert.equal(res.endIndex, 15);
  });

  test('请求页码为 0 或负数时回退至第 1 页', () => {
    const res = computePagination(30, -5, 10);
    assert.equal(res.currentPage, 1);
    assert.equal(res.startIndex, 0);
    assert.equal(res.endIndex, 10);
  });

  test('页大小为 0 或负数时安全兜底为 1', () => {
    const res = computePagination(10, 1, 0);
    assert.equal(res.pageSize, 1);
    assert.equal(res.totalPages, 10);
  });
});

describe('列表切片 paginateList', () => {
  const items = Array.from({ length: 35 }, (_, i) => `item_${i + 1}`);

  test('第一页切片内容正确', () => {
    const { pageItems, pagination } = paginateList(items, 1, 10);
    assert.equal(pagination.currentPage, 1);
    assert.equal(pageItems.length, 10);
    assert.equal(pageItems[0], 'item_1');
    assert.equal(pageItems[9], 'item_10');
  });

  test('最后一页切片内容正确', () => {
    const { pageItems, pagination } = paginateList(items, 4, 10);
    assert.equal(pagination.currentPage, 4);
    assert.equal(pageItems.length, 5);
    assert.equal(pageItems[0], 'item_31');
    assert.equal(pageItems[4], 'item_35');
  });

  test('空数组切片返回空列表', () => {
    const { pageItems, pagination } = paginateList([], 1, 10);
    assert.equal(pageItems.length, 0);
    assert.equal(pagination.totalItems, 0);
    assert.equal(pagination.totalPages, 1);
  });
});

describe('页码序列生成 getPageNumbers', () => {
  test('总页数小于等于 maxVisiblePages 时显示全部连续页码', () => {
    const pages = getPageNumbers(2, 5);
    assert.deepEqual(pages, [1, 2, 3, 4, 5]);
  });

  test('当前页靠前时末尾出现省略号', () => {
    const pages = getPageNumbers(2, 10);
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 'ellipsis', 10]);
  });

  test('当前页靠后时开头出现省略号', () => {
    const pages = getPageNumbers(9, 10);
    assert.deepEqual(pages, [1, 'ellipsis', 6, 7, 8, 9, 10]);
  });

  test('当前页在中间时前后均出现省略号', () => {
    const pages = getPageNumbers(5, 10);
    assert.deepEqual(pages, [1, 'ellipsis', 4, 5, 6, 'ellipsis', 10]);
  });
});
