'use client';

import React, { useState } from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';
import '../../styles/Pagination.scss';

const PAGE_WINDOW_SIZE = 10;

function clampPage(page, totalPages) {
  return Math.min(Math.max(Number(page) || 1, 1), Math.max(totalPages, 1));
}

function getPageWindowStart(page, totalPages) {
  const safePage = clampPage(page, totalPages);
  return Math.floor((safePage - 1) / PAGE_WINDOW_SIZE) * PAGE_WINDOW_SIZE + 1;
}

function normalizePageWindowStart(windowStart, totalPages) {
  const maxWindowStart = getPageWindowStart(totalPages, totalPages);
  return Math.min(Math.max(Number(windowStart) || 1, 1), maxWindowStart);
}

function buildPageItems(totalPages, pageWindowStart) {
  if (totalPages <= PAGE_WINDOW_SIZE + 1) {
    return Array.from({ length: totalPages }, (_, index) => ({
      type: 'page',
      page: index + 1,
    }));
  }

  const safeWindowStart = normalizePageWindowStart(pageWindowStart, totalPages);
  const windowEnd = Math.min(totalPages, safeWindowStart + PAGE_WINDOW_SIZE - 1);
  const items = [];

  const addPage = (page) => {
    if (!items.some((item) => item.type === 'page' && item.page === page)) {
      items.push({ type: 'page', page });
    }
  };

  if (safeWindowStart > 1) {
    addPage(1);
    if (safeWindowStart > 2) {
      items.push({
        type: 'gap',
        key: 'previous-gap',
        label: '...',
        windowStart: Math.max(1, safeWindowStart - PAGE_WINDOW_SIZE),
        ariaLabel: 'Show previous page numbers',
      });
    }
  }

  for (let page = safeWindowStart; page <= windowEnd; page += 1) {
    addPage(page);
  }

  if (windowEnd < totalPages) {
    if (windowEnd < totalPages - 1) {
      items.push({
        type: 'gap',
        key: 'next-gap',
        label: '...',
        windowStart: Math.min(totalPages, safeWindowStart + PAGE_WINDOW_SIZE),
        ariaLabel: 'Show next page numbers',
      });
    }
    addPage(totalPages);
  }

  return items;
}

export default function Pagination({
  currentPage = 1,
  pageSize = 10,
  totalItems = 0,
  pageSizeOptions = [10, 25, 50],
  itemLabel = 'items',
  className = '',
  onPageChange,
  onPageSizeChange,
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safeCurrentPage = clampPage(currentPage, totalPages);
  const [pageWindow, setPageWindow] = useState(null);
  const pageWindowStart = pageWindow?.page === safeCurrentPage && pageWindow?.total === totalPages
    ? pageWindow.start : getPageWindowStart(safeCurrentPage, totalPages);

  const pageItems = buildPageItems(totalPages, pageWindowStart);
  const startItem = totalItems === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1;
  const endItem = Math.min(totalItems, safeCurrentPage * pageSize);

  if (totalItems <= 0) {
    return null;
  }

  const goToPage = (nextPage) => {
    const clampedPage = clampPage(nextPage, totalPages);
    if (clampedPage !== safeCurrentPage) {
      onPageChange?.(clampedPage);
    }
  };

  const showPageWindow = (nextWindowStart) => {
    setPageWindow({ page: safeCurrentPage, total: totalPages, start: normalizePageWindowStart(nextWindowStart, totalPages) });
  };

  return (
    <nav className={cx('pagination-control', className)} aria-label="Pagination">
      <div className="pagination-control__summary">
        Showing {startItem}-{endItem} of {totalItems} {itemLabel}
      </div>

      <div className="pagination-control__pages">
        <button
          type="button"
          className="btn pagination-control__button pagination-control__button--icon"
          disabled={safeCurrentPage === 1}
          aria-label="Previous page"
          onClick={() => goToPage(safeCurrentPage - 1)}
        >
          <AppIcon name="chevron-left" />
        </button>

        {pageItems.map((item) => {
          if (item.type === 'gap') {
            return (
              <button
                type="button"
                key={item.key}
                className="btn pagination-control__button pagination-control__button--gap"
                aria-label={item.ariaLabel}
                onClick={() => showPageWindow(item.windowStart)}
              >
                {item.label}
              </button>
            );
          }

          return (
            <button
              type="button"
              key={item.page}
              className={cx(
                'btn',
                'pagination-control__button',
                item.page === safeCurrentPage && 'is-active',
              )}
              aria-current={item.page === safeCurrentPage ? 'page' : undefined}
              onClick={() => goToPage(item.page)}
            >
              {item.page}
            </button>
          );
        })}

        <button
          type="button"
          className="btn pagination-control__button pagination-control__button--icon"
          disabled={safeCurrentPage === totalPages}
          aria-label="Next page"
          onClick={() => goToPage(safeCurrentPage + 1)}
        >
          <AppIcon name="chevron-right" />
        </button>
      </div>

      {onPageSizeChange ? (
        <label className="pagination-control__size">
          <span>Per page</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </nav>
  );
}
