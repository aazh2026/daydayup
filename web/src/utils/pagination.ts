/**
 * 分页计算与列表切片工具函数
 */

export interface PaginationState {
  currentPage: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

/**
 * 计算规范化后的分页状态，自动处理边界溢出、负数与非法值
 */
export function computePagination(
  totalItems: number,
  page: number,
  pageSize: number
): PaginationState {
  const safeTotalItems = Math.max(0, totalItems);
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(safeTotalItems / safePageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, safeTotalItems);

  return {
    currentPage: safePage,
    pageSize: safePageSize,
    totalItems: safeTotalItems,
    totalPages,
    startIndex,
    endIndex,
  };
}

/**
 * 依据页码与页大小对数据列表进行切片
 */
export function paginateList<T>(
  items: T[],
  page: number,
  pageSize: number
): {
  pageItems: T[];
  pagination: PaginationState;
} {
  const pagination = computePagination(items.length, page, pageSize);
  const pageItems = items.slice(pagination.startIndex, pagination.endIndex);
  return { pageItems, pagination };
}

/**
 * 生成带省略号的分页按钮页码序列
 */
export function getPageNumbers(
  currentPage: number,
  totalPages: number,
  maxVisiblePages = 7
): (number | 'ellipsis')[] {
  if (totalPages <= maxVisiblePages) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | 'ellipsis')[] = [];

  if (currentPage <= 4) {
    for (let i = 1; i <= 5; i++) {
      pages.push(i);
    }
    pages.push('ellipsis');
    pages.push(totalPages);
  } else if (currentPage >= totalPages - 3) {
    pages.push(1);
    pages.push('ellipsis');
    for (let i = totalPages - 4; i <= totalPages; i++) {
      pages.push(i);
    }
  } else {
    pages.push(1);
    pages.push('ellipsis');
    pages.push(currentPage - 1);
    pages.push(currentPage);
    pages.push(currentPage + 1);
    pages.push('ellipsis');
    pages.push(totalPages);
  }

  return pages;
}
