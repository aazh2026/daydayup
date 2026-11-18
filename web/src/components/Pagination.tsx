import React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MoreHorizontal } from 'lucide-react';
import { getPageNumbers } from '../utils/pagination.ts';

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  itemName?: string;
  className?: string;
  compact?: boolean;
}

export const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions,
  itemName = '条',
  className = '',
  compact = false,
}) => {
  if (totalItems <= 0) {
    return null;
  }

  const pages = getPageNumbers(currentPage, totalPages, compact ? 5 : 7);
  const startIdx = (currentPage - 1) * pageSize + 1;
  const endIdx = Math.min(currentPage * pageSize, totalItems);

  return (
    <nav
      role="navigation"
      aria-label="分页导航"
      className={`flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 text-xs text-slate-500 ${className}`}
    >
      {/* 计数统计与当前范围 */}
      <div className="flex items-center gap-2 font-mono tabular-nums">
        <span>
          共 <strong className="text-slate-800 font-semibold">{totalItems}</strong> {itemName}
        </span>
        <span aria-hidden="true" className="text-slate-300">|</span>
        <span>
          当前显示 {startIdx}-{endIdx}
        </span>
        {pageSizeOptions && onPageSizeChange && (
          <>
            <span aria-hidden="true" className="text-slate-300">|</span>
            <label className="inline-flex items-center gap-1">
              <span className="text-slate-500">每页</span>
              <select
                aria-label={`每页显示${itemName}数量`}
                value={pageSize}
                onChange={(e) => {
                  const newSize = Number(e.target.value);
                  onPageSizeChange(newSize);
                }}
                className="px-2 py-1 bg-white border border-slate-200 rounded text-xs text-slate-700 focus:outline-none focus:border-blue-600 cursor-pointer"
              >
                {pageSizeOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt} {itemName}/页
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      {/* 页码与翻页按钮 */}
      {totalPages > 1 && (
        <div className="inline-flex items-center gap-1 select-none">
          {/* 首页 */}
          {!compact && (
            <button
              type="button"
              onClick={() => onPageChange(1)}
              disabled={currentPage <= 1}
              aria-label="第一页"
              className={`p-1.5 rounded-md border border-slate-200 transition-colors ${
                currentPage <= 1
                  ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                  : 'text-slate-600 bg-white hover:bg-slate-50 active:bg-slate-100'
              }`}
            >
              <ChevronsLeft className="w-3.5 h-3.5" />
            </button>
          )}

          {/* 上一页 */}
          <button
            type="button"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label="上一页"
            className={`p-1.5 rounded-md border border-slate-200 transition-colors ${
              currentPage <= 1
                ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                : 'text-slate-600 bg-white hover:bg-slate-50 active:bg-slate-100'
            }`}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          {/* 页码列表 */}
          <div className="inline-flex items-center gap-1">
            {pages.map((p, idx) => {
              if (p === 'ellipsis') {
                return (
                  <span
                    key={`ellipsis-${idx}`}
                    className="w-7 h-7 flex items-center justify-center text-slate-400"
                    aria-hidden="true"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </span>
                );
              }

              const isCurrent = p === currentPage;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPageChange(p)}
                  aria-label={`第 ${p} 页`}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={`min-w-7 h-7 px-1.5 font-mono text-xs font-medium rounded-md transition-colors ${
                    isCurrent
                      ? 'bg-blue-600 text-white border border-blue-600 shadow-xs'
                      : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 active:bg-slate-100'
                  }`}
                >
                  {p}
                </button>
              );
            })}
          </div>

          {/* 下一页 */}
          <button
            type="button"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
            aria-label="下一页"
            className={`p-1.5 rounded-md border border-slate-200 transition-colors ${
              currentPage >= totalPages
                ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                : 'text-slate-600 bg-white hover:bg-slate-50 active:bg-slate-100'
            }`}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>

          {/* 末页 */}
          {!compact && (
            <button
              type="button"
              onClick={() => onPageChange(totalPages)}
              disabled={currentPage >= totalPages}
              aria-label="最后一页"
              className={`p-1.5 rounded-md border border-slate-200 transition-colors ${
                currentPage >= totalPages
                  ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                  : 'text-slate-600 bg-white hover:bg-slate-50 active:bg-slate-100'
              }`}
            >
              <ChevronsRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </nav>
  );
};
