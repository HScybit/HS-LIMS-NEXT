'use client';

import "../../styles/datatable.scss";
import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import cx from "classnames";
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import AppIcon from "./AppIcon.jsx";
import Pagination from "./Pagination.jsx";
import { Skeleton } from "./Skeleton.jsx";
import TruncatedText, { LISTING_TEXT_MAX_LENGTH } from "./TruncatedText.jsx";

const EMPTY_ARRAY = [];

function isActionColumn(column) {
  return column.key === "actions" || String(column.header || "").toLowerCase() === "actions" || column.render;
}

function isBooleanColumn(column) {
  return column.type === "boolean" || /^is(_|[A-Z])/.test(column.key || "");
}

function getFilterType(column) {
  if (column.filterType) return column.filterType;
  if (column.filterOptions) return "select";
  if (column.type === "date") return "date";
  if (isBooleanColumn(column)) return "boolean";
  return "text";
}

function isFilterActive(filter) {
  if (!filter) return false;
  if (filter.type === "date") return Boolean(filter.from || filter.to);
  if (filter.type === "relation") return Array.isArray(filter.value) && filter.value.length > 0;

  return Boolean(String(filter.value ?? "").trim());
}

function countActiveFilters(filters) {
  return Object.values(filters).filter(isFilterActive).length;
}

function sanitizeFilters(filters, filterColumns) {
  const allowedKeys = new Set(filterColumns.map((column) => column.key));

  return Object.fromEntries(
    Object.entries(filters)
      .filter(([key, filter]) => allowedKeys.has(key) && isFilterActive(filter)),
  );
}

function formatFilterValue(filter) {
  if (filter.type === "date") {
    if (filter.from && filter.to) return `${filter.from} to ${filter.to}`;
    return filter.from ? `from ${filter.from}` : `until ${filter.to}`;
  }

  if (filter.type === "boolean") {
    return filter.value === "true" ? "Yes" : "No";
  }

  if (filter.type === "relation") {
    return Array.isArray(filter.value) ? `${filter.value.length} selected` : filter.value;
  }
  return filter.value;
}

function normalizeOption(option) {
  if (typeof option === "object" && option !== null) {
    return {
      label: option.label ?? option.name ?? option.value,
      value: option.value ?? option.label ?? option.name,
    };
  }

  return { label: option, value: option };
}

function sanitizeValue(value) {
  return String(value || ' ')
    .replace(/[_/-]/g, ' ')
    .replace(/\s/g, ' ')
    .trim();
}

function getValueByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

function getServerColumn(column) {
  return Object.fromEntries(
    Object.entries(column).filter(([, value]) => typeof value !== "function"),
  );
}

function containsReactElement(value) {
  if (React.isValidElement(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(containsReactElement);
  }

  return false;
}

function useUrlTableState(defaults = {}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const setSearchParams = useCallback((update) => {
    const params = update(new URLSearchParams(searchParams.toString()));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const state = useMemo(() => {
    const page = parseInt(searchParams.get("page")) || defaults.page || 1;
    const pageSize = parseInt(searchParams.get("pageSize")) || defaults.pageSize || 10;
    const search = searchParams.get("search") || defaults.search || "";
    const sortKey = searchParams.get("sortKey") || defaults.sortKey || "";
    const sortDir = searchParams.get("sortDir") || defaults.sortDir || "";

    let appliedFilters = {};
    try {
      const filterParam = searchParams.get("filters");
      if (filterParam) appliedFilters = JSON.parse(decodeURIComponent(filterParam));
    } catch (e) {
      console.error("Failed to parse URL filters", e);
    }

    return { page, pageSize, search, appliedFilters, sortKey, sortDir };
  }, [searchParams, defaults.page, defaults.pageSize, defaults.search, defaults.sortDir, defaults.sortKey]);

  const update = useCallback((patch) => {
    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams);
      const newState = { ...state, ...patch };

      nextParams.set("page", newState.page);
      nextParams.set("pageSize", newState.pageSize);

      if (newState.search.trim()) {
        nextParams.set("search", newState.search);
      } else {
        nextParams.delete("search");
      }

      if (newState.sortKey) {
        nextParams.set("sortKey", newState.sortKey);
        nextParams.set("sortDir", newState.sortDir || "asc");
      } else {
        nextParams.delete("sortKey");
        nextParams.delete("sortDir");
      }

      if (Object.keys(newState.appliedFilters).length > 0) {
        nextParams.set("filters", encodeURIComponent(JSON.stringify(newState.appliedFilters)));
      } else {
        nextParams.delete("filters");
      }
      return nextParams;
    });
  }, [state, setSearchParams]);

  return [state, update];
}

export function MultiSelectFilterField({ column, filter, onUpdate }) {
  const [search, setSearch] = useState('');
  const options = column.filterOptions || [];
  const [open, setOpen] = useState(false);

  const selected = Array.isArray(filter?.value) ? filter.value : [];


  const filtered = options.filter(o =>
    o.label.toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (value) => {
    const nextSelected = selected.includes(value)
      ? selected.filter(v => v !== value)
      : [...selected, value];

    const labelsMap = nextSelected.reduce((acc, val) => {
      const match = options.find(o => o.value === val);
      acc[val] = match ? match.label : val;
      return acc;
    }, {});

    onUpdate(column.key, {
      type: 'relation',
      value: nextSelected,
      labels: labelsMap
    });
  };

  const selectedLabels = selected
    .map(v => options.find(o => o.value === v)?.label || v)
    .join(', ');

  return (
    <div className="dt-filter-field">
      <label>{column.header || column.key}</label>

      <input
        type="text"
        readOnly
        value={selected.length ? selectedLabels : ''}
        placeholder={`Filter ${column.header || column.key}`}
        style={{ cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}
      />

      {open && (
        <div className="dt-multiselect-dropdown">
          <div className="dt-multiselect-search">
            <input
              type="text"
              value={search}
              placeholder="Search..."
              autoFocus
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <div className="dt-multiselect-list">
            {filtered.length === 0 ? (
              <div className="dt-multiselect-empty">
                No options found
              </div>
            ) : (
              filtered.map(opt => {
                const isChecked = selected.includes(opt.value);
                return (
                  <div
                    key={opt.value}
                    onClick={() => toggle(opt.value)}
                    className={cx('dt-multiselect-option', isChecked && 'is-selected')}
                  >
                    <div className="dt-multiselect-checkbox" />
                    <span>{opt.label}</span>
                  </div>
                );
              })
            )}
          </div>

          {selected.length > 0 && (
            <div className="dt-multiselect-footer">
              <span>{selected.length} selected</span>
              <button
                type="button"
                onClick={() => onUpdate(column.key, { type: 'relation', value: [], labels: {} })}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {open && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 999 }}
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  );
}



function renderTextCell(value, column = {}) {
  const fallback = column.fallback ?? "-";

  if (column.truncate === false || containsReactElement(value)) {
    return value ?? fallback;
  }

  return (
    <TruncatedText
      value={value ?? fallback}
      fallback={fallback}
      maxLength={column.maxLength ?? column.truncateLength ?? LISTING_TEXT_MAX_LENGTH}
    />
  );
}

export default function DataTable({
  children,
  className = "",
  responsive = true,
  stickyActionColumn = false,
  columns = EMPTY_ARRAY,
  fields = EMPTY_ARRAY,
  model,
  collname,
  tableLayout = "fixed",
  loadRows,
  ...tableProps
}) {
  const responsiveRef = useRef(null);
  const [isScrollAtEnd, setIsScrollAtEnd] = useState(true);

  useEffect(() => {
    if (!children || !responsive || !stickyActionColumn || !responsiveRef.current) {
      return undefined;
    }

    const wrapper = responsiveRef.current;
    const updateScrollState = () => {
      const maxScrollLeft = wrapper.scrollWidth - wrapper.clientWidth;
      setIsScrollAtEnd(maxScrollLeft <= 1 || wrapper.scrollLeft >= maxScrollLeft - 1);
    };

    updateScrollState();
    wrapper.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);

    return () => {
      wrapper.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [children, responsive, stickyActionColumn]);

  if (children) {
    const table = (
      <table
        className={cx(
          "smplfy-table",
          "table",
          "table-hover",
          "align-middle",
          "mb-0",
          stickyActionColumn && "smplfy-table-sticky-action",
          className,
        )}
        {...tableProps}
      >
        {children}
      </table>
    );

    return responsive ? (
      <div
        ref={responsiveRef}
        className={cx(
          "table-responsive",
          stickyActionColumn && "smplfy-table-responsive-sticky-action",
          stickyActionColumn && isScrollAtEnd && "is-scroll-at-end",
        )}
      >
        {table}
      </div>
    ) : table;
  }

  return <RemoteDataTable columns={columns} fields={fields} model={model} collname={collname} loadRows={loadRows} />;
}

function RemoteDataTable({ columns, fields, model, collname, loadRows }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const navigate = useCallback((path) => router.push(path), [router]);
  const [persistedState, updatePersistedState] = useUrlTableState({
    page: 1,
    pageSize: 10,
    search: '',
    appliedFilters: {},
  });
  const page = persistedState.page;
  const pageSize = persistedState.pageSize;
  const search = persistedState.search;
  const appliedFilters = persistedState.appliedFilters;
  const sortKey = persistedState.sortKey;
  const sortDir = persistedState.sortDir;
  const [debouncedSearch, setDebouncedSearch] = useState(persistedState.search);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  const visibleColumns = useMemo(
    () => columns.filter((column) => !column.hidden),
    [columns],
  );
  const tableStyle = useMemo(() => ({
    tableLayout: visibleColumns.some(c => c.width) ? "fixed" : "auto",
    width: "100%",
    borderCollapse: "separate"
  }), [visibleColumns]);

  const filterColumns = useMemo(
    () => columns.filter((column) => (
      column.key &&
      column.filterable !== false &&
      !isActionColumn(column) &&
      (column.searchable || column.foreign || column.type === "date" || isBooleanColumn(column) || column.filterOptions || column.filterType === 'relation')
    )),
    [columns],
  );
  const activeFilterCount = countActiveFilters(appliedFilters);
  const hasActiveQuery = Boolean(search.trim()) || activeFilterCount > 0;

  const renderCell = useCallback(
    (row, col) => {
      const value = getValueByPath(row, col.key);

      if (col.component) {
        const Component = col.component;
        return <Component row={row} value={value} col={col} />;
      }

      if (col.render) {
        return renderTextCell(col.render(row, value), col);
      }

      if (col.html && typeof value === "string") {
        return <span>{value}</span>;
      }

      if (col.format) {
        return renderTextCell(col.format(value, row), col);
      }

      if (col.method && typeof row[col.method] === "function") {
        return renderTextCell(row[col.method](), col);
      }

      if (col.type === "date" && value) {
        let date;
        if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
          const [day, month, year] = value.split('/');
          date = new Date(`${year}-${month}-${day}`);
        } else {
          date = new Date(value);
        }
        if (isNaN(date.getTime())) return renderTextCell('-', col);
        return renderTextCell(date.toLocaleDateString('en-GB'), col);
      }

      if (col.link && value) {
        const hyperLink = typeof col.link === 'function' ?
          col.link(row) :
          col.link;

        const displayText = typeof value === 'string' ? sanitizeValue(value) : value;

        return (
          <a
            href={hyperLink}
            className='smplfy-table-link'
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              navigate(hyperLink);
            }}
          >
            {displayText}
          </a>
        );
      }

      if (typeof value === "string") {
        return value;
      }

      return renderTextCell(value, col);
    },
    [navigate],
  );

  const fetchData = useCallback(async ({ ignoreResult } = {}) => {
    setLoading(true);

    try {
      const res = await loadRows({
        collection_name: collname,
        baseQuery: {},
        page,
        pageSize,
        search: debouncedSearch || null,
        filters: sanitizeFilters(appliedFilters, filterColumns),
        columns: columns.map(getServerColumn),
        fields,
        sort: sortKey ? { key: sortKey, dir: sortDir } : null,
      });

      const formatted =
        model && res.rows
          ? res.rows.map((d) => (d instanceof model ? d : new model(d)))
          : res.rows;

      if (ignoreResult?.()) return;
      setError('');
      setRows(formatted || []);
      setTotal(res.totalCount || 0);
    } catch (err) {
      if (ignoreResult?.()) return;
      setError(err.message || 'Unable to load this list.');
    } finally {
      if (ignoreResult?.()) return;
      setLoading(false);
    }
  }, [page, pageSize, debouncedSearch, appliedFilters, filterColumns, collname, columns, model, fields, sortKey, sortDir, loadRows]);

  useEffect(() => {
    let ignore = false;
    // A changed server query starts the source loading state while retaining the current rows.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData({ ignoreResult: () => ignore });

    return () => {
      ignore = true;
    };
  }, [fetchData]);

  const updateDraftFilter = (key, patch) => {
    setDraftFilters((current) => ({
      ...current,
      [key]: {
        ...(current[key] || {}),
        ...patch,
      },
    }));
  };

  const applyFilters = () => {
    updatePersistedState({
      appliedFilters: sanitizeFilters(draftFilters, filterColumns),
      page: 1,
    });
    setFiltersOpen(false);
  };

  const clearAll = () => {
    setDebouncedSearch('');
    updatePersistedState({ search: '', appliedFilters: {}, page: 1 });
    setDraftFilters({});
    setFiltersOpen(false);
  };

  const clearFilters = () => {
    setDraftFilters({});
    updatePersistedState({ appliedFilters: {}, page: 1 });
  };

  const removeFilter = (key) => {
    setDraftFilters((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    const nextFilters = { ...persistedState.appliedFilters };
    delete nextFilters[key];
    updatePersistedState({ appliedFilters: nextFilters, page: 1 });
  };

  const handleSort = (columnKey) => {
    if (sortKey === columnKey) {
      if (sortDir === 'asc') {
        updatePersistedState({ sortKey: columnKey, sortDir: 'desc', page: 1 });
      } else if (sortDir === 'desc') {
        updatePersistedState({ sortKey: '', sortDir: '', page: 1 });
      }
    } else {
      updatePersistedState({ sortKey: columnKey, sortDir: 'asc', page: 1 });
    }
  };

  const getSortIconName = (columnKey) => {
    if (sortKey === columnKey) {
      if (sortDir === 'asc') return 'sort-asc';
      if (sortDir === 'desc') return 'sort-desc';
    }

    return 'arrows-exchange';
  };

  const renderFilterControl = (column) => {
    const type = getFilterType(column);
    const filter = draftFilters[column.key] || { type };
    const label = column.header || column.key;

    if (type === "date") {
      return (
        <div className="dt-filter-field" key={column.key}>
          <label>{label}</label>
          <div className="dt-filter-field__range">
            <input
              type="date"
              value={filter.from || ""}
              onChange={(event) => updateDraftFilter(column.key, { type, from: event.target.value })}
            />
            <input
              type="date"
              value={filter.to || ""}
              onChange={(event) => updateDraftFilter(column.key, { type, to: event.target.value })}
            />
          </div>
        </div>
      );
    }

    if (type === "boolean") {
      return (
        <div className="dt-filter-field" key={column.key}>
          <label>{label}</label>
          <select
            value={filter.value || ""}
            onChange={(event) => updateDraftFilter(column.key, { type, value: event.target.value })}
          >
            <option value="">Any</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
      );
    }

    if (type === "select") {
      return (
        <div className="dt-filter-field" key={column.key}>
          <label>{label}</label>
          <select
            value={filter.value || ""}
            onChange={(event) => updateDraftFilter(column.key, { type, value: event.target.value })}
          >
            <option value="">Any</option>
            {(column.filterOptions || []).map((option) => {
              const normalizedOption = normalizeOption(option);
              return (
                <option key={normalizedOption.value} value={normalizedOption.value}>
                  {normalizedOption.label}
                </option>
              );
            })}
          </select>
        </div>
      );
    }

    if (type === 'relation') {
      return (
        <MultiSelectFilterField
          key={column.key}
          column={column}
          filter={filter}
          onUpdate={updateDraftFilter}
        />
      );
    }

    return (
      <div className="dt-filter-field" key={column.key}>
        <label>{label}</label>
        <input
          type="text"
          value={filter.value || ""}
          placeholder={`Filter ${label}`}
          onChange={(event) => updateDraftFilter(column.key, { type, value: event.target.value })}
        />
      </div>
    );
  };

  return (
    <section className="dt-page">
      {error ? <div className="alert alert-warning" role="alert">{error}<button className="btn btn-link" type="button" onClick={() => fetchData()}>Retry</button></div> : null}
      <section className="dt-toolbar">
        <div className="dt-search-shell">
          <AppIcon name="search" />
          <input
            className="dt-search"
            placeholder="Search..."
            value={search}
            onChange={(e) => updatePersistedState({ search: e.target.value })}
          />
        </div>

        <button
          type="button"
          className={cx("btn", "dt-filter-toggle", filtersOpen && "is-active")}
          onClick={() => {
            setDraftFilters(appliedFilters);
            setFiltersOpen((current) => !current);
          }}
        >
          <AppIcon name="filter" />
          <span>Filters</span>
          {activeFilterCount ? <span className="dt-filter-count">{activeFilterCount}</span> : null}
        </button>

        {hasActiveQuery ? (
          <button type="button" className="btn dt-clear-button" onClick={clearAll}>
            Clear
          </button>
        ) : null}
      </section>

      {filtersOpen ? (
        <form
          className="dt-filter-panel"
          onSubmit={(e) => { e.preventDefault(); applyFilters(); }}
        >
          <div className="dt-filter-grid">
            {filterColumns.length ? filterColumns.map(renderFilterControl) : (
              <div className="dt-filter-empty">No filters available for this listing.</div>
            )}
          </div>
          <div className="dt-filter-actions">
            <button type="button" className="btn dt-filter-reset" onClick={clearFilters}>
              Reset
            </button>
            <button type="submit" className="btn dt-filter-apply">
              Apply Filters
            </button>
          </div>
        </form>
      ) : null}

      {activeFilterCount ? (
        <div className="dt-active-filters">
          {Object.entries(appliedFilters).map(([key, filter]) => {
            const column = filterColumns.find((item) => item.key === key);
            if (!column) return null;
            if (filter.type === 'relation' && Array.isArray(filter.value)) {
              return filter.value.map((singleValue) => {
                const displayLabel = filter.labels?.[singleValue] || singleValue;

                return (
                  <button
                    type="button"
                    className="btn dt-filter-pill"
                    key={`${key}-${singleValue}`}
                    onClick={() => {
                      const nextValues = filter.value.filter((value) => value !== singleValue);
                      const nextLabels = { ...filter.labels };
                      delete nextLabels[singleValue];

                      if (nextValues.length > 0) {
                        updateDraftFilter(key, { type: 'relation', value: nextValues, labels: nextLabels });
                        updatePersistedState({
                          appliedFilters: {
                            ...persistedState.appliedFilters,
                            [key]: { ...filter, value: nextValues, labels: nextLabels }
                          },
                          page: 1
                        });
                      } else {
                        removeFilter(key);
                      }
                    }}
                  >
                    <span>{displayLabel}</span>
                    <AppIcon name="close" />
                  </button>
                );
              });
            }
            return (
              <button
                type="button"
                className="btn dt-filter-pill"
                key={key}
                onClick={() => removeFilter(key)}
              >
                <span>{column.header}: {formatFilterValue(filter)}</span>
                <AppIcon name="close" />
              </button>
            );
          })}
        </div>
      ) : null}

      <section className="dt-table-card">
        <div className="dt-table-wrap">
          <div className="dt-table-wrapper">
            <table className="dt-table" style={tableStyle}>
              <thead>
                <tr>
                  {visibleColumns.map((c) => {
                    const inlineWidth = c.width || c.minWidth || undefined;
                    const isSortable = !isActionColumn(c) && c.sortable !== false;
                    const isActive = sortKey === c.key;
                    return (
                      <th
                        key={c.key}
                        style={{
                          width: inlineWidth,
                          minWidth: c.minWidth || "120px",
                          whiteSpace: "normal",
                          cursor: isSortable ? 'pointer' : 'default',
                          userSelect: 'none',
                        }}
                        onClick={() => isSortable && handleSort(c.key)}
                      >
                        <div className="dt-th-content">
                          <span>{c.header}</span>
                          {isSortable && (
                            <span className={cx('dt-sort-icon', isActive && 'is-active')}>
                              <AppIcon name={getSortIconName(c.key)} size={14} />
                            </span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  Array.from({ length: 8 }, (_, i) => (
                    <tr key={i} className="dt-skeleton-row">
                      {visibleColumns.map((c) => (
                        <td
                          key={c.key}
                          style={{ width: c.width || c.minWidth || undefined, minWidth: c.minWidth }}
                        >
                          <Skeleton width="75%" height={14} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : rows.length ? (
                  rows.map((row) => (
                    <tr key={row._id}>
                      {visibleColumns.map((c) => (
                        <td
                          key={c.key}
                          style={{
                            width: c.width || c.minWidth || undefined,
                            minWidth: c.minWidth,
                            whiteSpace: "normal"
                          }}
                        >
                          {renderCell(row, c)}
                        </td>
                      ))}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={Math.max(visibleColumns.length, 1)} className="dt-empty">
                      No data found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <Pagination
            currentPage={page}
            pageSize={pageSize}
            totalItems={total}
            itemLabel="rows"
            onPageChange={(nextPage) => updatePersistedState({ page: nextPage })}
            onPageSizeChange={(nextPageSize) => updatePersistedState({ pageSize: nextPageSize, page: 1 })}
          />
        </div>
      </section>
    </section>
  );
}
