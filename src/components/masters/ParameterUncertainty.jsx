'use client';

import React, { useCallback, useRef, useState } from 'react';
import Spreadsheet from 'react-spreadsheet';
import './spreadsheet-field.scss';
import { uncertaintyLimits } from '../../masters/parameter-grid.js';

/**
 * Converts our internal format (array of arrays of strings) to react-spreadsheet format (array of arrays of {value})
 */
function toSpreadsheetData(rows = []) {
  return rows.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => ({ value: cell ?? '' })),
  );
}

/**
 * Converts react-spreadsheet format back to our internal format (array of arrays of strings)
 */
function fromSpreadsheetData(data = []) {
  return data.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => (cell?.value ?? '')),
  );
}

function buildEmptyRow(colCount, rowIndex, isOrderedSequence) {
  const row = [];
  for (let c = 0; c < colCount; c++) {
    if (isOrderedSequence && c === 0) {
      row.push({ value: String(rowIndex + 1), readOnly: true });
    } else {
      row.push({ value: '' });
    }
  }
  return row;
}

function buildSpreadsheetHeaders({ headers, colCount, isOrderedSequence }) {
  if (Array.isArray(headers)) return headers;

  const result = [];
  if (isOrderedSequence) result.push('Sr No.');

  const startCol = isOrderedSequence ? 1 : 0;
  for (let c = startCol; c < colCount; c++) {
    result.push(`Column ${c + 1}`);
  }
  return result;
}

function applyOrderedSequence(data, isOrderedSequence) {
  if (!isOrderedSequence) return data;
  return data.map((row, rowIdx) => {
    const newRow = [...row];
    if (newRow.length > 0) {
      newRow[0] = { value: String(rowIdx + 1), readOnly: true };
    }
    return newRow;
  });
}

export function SpreadsheetReadOnly({ value, cfg }) {
  const settings = cfg?.spreadsheetSettings || {};
  const isOrderedSequence = settings.isOrderedSequence ?? true;

  if (!value || !value.data || !Array.isArray(value.data) || value.data.length === 0) {
    return <div className="text-muted small">No data</div>;
  }

  const allRows = value.data;
  const headers = Array.isArray(value.headers) ? value.headers : (settings.headers || []);

  // Filter out rows that only have Sr. no. but no other content
  const rows = allRows.filter((row) => {
    if (!Array.isArray(row)) return false;
    const startIdx = isOrderedSequence ? 1 : 0;
    return row.slice(startIdx).some((cell) => String(cell ?? '').trim() !== '');
  });

  if (rows.length === 0) return <div className="text-muted small">No data</div>;

  // Determine which columns have at least one non-empty value
  const maxCols = Math.max(...rows.map((r) => r.length));
  const nonEmptyCols = [];
  for (let c = 0; c < maxCols; c++) {
    const hasVal = rows.some((row) => String(row[c] ?? '').trim() !== '');
    if (hasVal) nonEmptyCols.push(c);
  }
  if (nonEmptyCols.length === 0) return <div className="text-muted small">No data</div>;

  return (
    <div className="border rounded overflow-auto" style={{ maxHeight: 300 }}>
      <table className="table table-bordered table-sm m-0 bg-white text-center">
        {headers.length > 0 && (
          <thead className="bg-light">
            <tr>
              {nonEmptyCols.map((colIdx) => (
                <th key={colIdx} className="px-2 py-1 fw-semibold" style={{ fontSize: '12px' }}>
                  {headers[colIdx] || `Col ${colIdx + 1}`}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {nonEmptyCols.map((colIdx) => (
                <td key={colIdx} className="px-2 py-1" style={{ fontSize: '13px' }}>
                  {String(row[colIdx] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ParameterUncertainty({ readOnly, ...props }) {
  if (readOnly) return <div className="mb-4">{props.cfg?.label ? <label className="form-label fw-bold m-0 text-secondary mb-2">{props.cfg.label}</label> : null}<SpreadsheetReadOnly value={props.value} cfg={props.cfg} /></div>;
  return <SpreadsheetEditor {...props} />;
}

function SpreadsheetEditor({ name, cfg, value, error, onChange, onInvalid, disabled = false }) {
  const settings = cfg?.spreadsheetSettings || {};
  const isOrderedSequence = settings.isOrderedSequence ?? true;
  const initialRowsCount = settings.initialRows ?? 1;
  const initialColsCount = settings.initialCols ?? 2;
  const configHeaders = settings.headers;

  // Parse initial data
  const parseInitialData = () => {
    if (value && typeof value === 'object' && Array.isArray(value.data) && value.data.length > 0) {
      const converted = toSpreadsheetData(value.data);
      return applyOrderedSequence(converted, isOrderedSequence);
    }

    const colCount = configHeaders ? configHeaders.length : initialColsCount;
    const rows = [];
    for (let r = 0; r < initialRowsCount; r++) {
      rows.push(buildEmptyRow(colCount, r, isOrderedSequence));
    }
    return rows;
  };

  const [data, setData] = useState(parseInitialData);
  const [headers, setHeaders] = useState(() => {
    // Load saved headers if available, otherwise use config or generate defaults
    if (value && typeof value === 'object' && Array.isArray(value.headers)) {
      return value.headers;
    }
    return buildSpreadsheetHeaders({ headers: configHeaders, colCount: parseInitialData()[0]?.length || initialColsCount, isOrderedSequence });
  });
  const [editingHeaderIdx, setEditingHeaderIdx] = useState(null);
  const [draftHeader, setDraftHeader] = useState('');
  const activeCell = useRef(null); const mode = useRef('view');

  const colCount = data[0]?.length || initialColsCount;

  const pushUpdate = useCallback((nextData, nextHeaders = headers) => {
    if (disabled) return;
    setHeaders(nextHeaders);
    setData(nextData);
    if (typeof onChange === 'function') {
      onChange(name, { data: fromSpreadsheetData(nextData), headers: nextHeaders });
    }
  }, [name, onChange, headers, disabled]);

  const handleChange = useCallback((nextData) => {
    const sequenced = applyOrderedSequence(nextData, isOrderedSequence);
    // Source paste can expand the matrix. Every new column needs a matching header.
    const nextColumnCount = Math.max(headers.length, ...sequenced.map((row) => row.length));
    const nextHeaders = Array.from({ length: nextColumnCount }, (_, index) => headers[index] ?? `Column ${index + 1}`);
    pushUpdate(sequenced, nextHeaders);
  }, [isOrderedSequence, pushUpdate, headers]);

  function checkPaste(event) {
    if (!event.target.closest('.Spreadsheet')) return;
    let problem = '';
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (disabled) { event.preventDefault(); event.stopPropagation(); return; }
    if (new TextEncoder().encode(text).byteLength > uncertaintyLimits.bytes + uncertaintyLimits.rows * uncertaintyLimits.columns * 2) {
      problem = 'The pasted uncertainty text is too large.';
    } else if (activeCell.current && mode.current === 'view') {
      // Count using this source package's quoted-newline and tab rules before it allocates a larger matrix.
      const lines = text.replace(/"([^"]*?)"/g, (_match, content) => content.replace(/\n/g, '\\n')).split(/\r\n|\n|\r/, uncertaintyLimits.rows + 1);
      const columns = lines.reduce((maximum, line) => Math.max(maximum, line.split('\t', uncertaintyLimits.columns + 1).length), 0);
      if (activeCell.current.row + lines.length > uncertaintyLimits.rows || activeCell.current.column + columns > uncertaintyLimits.columns) {
        problem = 'The paste would exceed 500 uncertainty rows or 32 columns.';
      }
    }
    if (problem) { event.preventDefault(); event.stopPropagation(); onInvalid?.(problem); }
  }

  const handleAddRow = () => {
    if (data.length >= uncertaintyLimits.rows) return;
    const newRow = buildEmptyRow(colCount, data.length, isOrderedSequence);
    pushUpdate([...data, newRow]);
  };

  const handleRemoveRow = () => {
    if (data.length <= 1) return;
    const nextData = applyOrderedSequence(data.slice(0, -1), isOrderedSequence);
    pushUpdate(nextData);
  };

  const handleAddColumn = () => {
    if (colCount >= uncertaintyLimits.columns) return;
    const nextData = data.map((row) => [...row, { value: '' }]);
    pushUpdate(nextData, [...headers, `Column ${headers.length + 1}`]);
  };

  const handleRemoveColumn = () => {
    const minCols = isOrderedSequence ? 2 : 1;
    if (colCount <= minCols) return;
    const nextData = data.map((row) => row.slice(0, -1));
    pushUpdate(nextData, headers.slice(0, -1));
  };

  return (
    <div className="mb-4 native-sheet-container">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <label className="form-label fw-bold m-0 text-secondary">
          {cfg?.label || name}
        </label>
        <div className="d-flex gap-2">
          <div className="btn-group border rounded bg-light p-0" style={{ height: '26px' }}>
            <button type="button" className="btn btn-sm btn-link text-danger text-decoration-none px-2 py-0 border-end" style={{ fontSize: '11px', fontWeight: 'bold' }} disabled={disabled || data.length <= 1} aria-label="Remove uncertainty row" onClick={handleRemoveRow}>-</button>
            <button type="button" className="btn btn-sm btn-link text-dark text-decoration-none px-2 py-0" style={{ fontSize: '11px', fontWeight: 'bold' }}>Row</button>
            <button type="button" className="btn btn-sm btn-link text-decoration-none px-2 py-0 border-start" style={{ fontSize: '11px', fontWeight: 'bold' }} disabled={disabled || data.length >= uncertaintyLimits.rows} aria-label="Add uncertainty row" onClick={handleAddRow}>+</button>
          </div>
          <div className="btn-group border rounded bg-light p-0" style={{ height: '26px' }}>
            <button type="button" className="btn btn-sm btn-link text-danger text-decoration-none px-2 py-0 border-end" style={{ fontSize: '11px', fontWeight: 'bold' }} disabled={disabled || colCount <= 2} aria-label="Remove uncertainty column" onClick={handleRemoveColumn}>-</button>
            <button type="button" className="btn btn-sm btn-link text-dark text-decoration-none px-2 py-0" style={{ fontSize: '11px', fontWeight: 'bold' }}>Column</button>
            <button type="button" className="btn btn-sm btn-link text-decoration-none px-2 py-0 border-start" style={{ fontSize: '11px', fontWeight: 'bold' }} disabled={disabled || colCount >= uncertaintyLimits.columns} aria-label="Add uncertainty column" onClick={handleAddColumn}>+</button>
          </div>
        </div>
      </div>

      <div className="border rounded overflow-auto spreadsheet-modern" style={{ maxHeight: '400px', width: 'fit-content', maxWidth: '100%' }} onPasteCapture={checkPaste}>
        {/* Editable column headers */}
        <table className="spreadsheet-header-table">
          <thead>
            <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #cbd5e1' }}>
              {headers.map((header, idx) => (
                <th
                  key={idx}
                  style={{
                    borderRight: idx < headers.length - 1 ? '1px solid #e2e8f0' : 'none',
                  }}
                >
                  {editingHeaderIdx === idx ? (
                    <input
                      type="text"
                      className="form-control form-control-sm text-center"
                      style={{ fontSize: '11px', padding: '2px 4px', height: '22px' }}
                      value={draftHeader}
                      onChange={(e) => setDraftHeader(e.target.value)}
                      onBlur={() => {
                        if (draftHeader.trim()) {
                          const newHeaders = headers.map((h, i) => i === idx ? draftHeader.trim() : h);
                          pushUpdate(data, newHeaders);
                        }
                        setEditingHeaderIdx(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
                        if (e.key === 'Escape') { setEditingHeaderIdx(null); }
                      }}
                      autoFocus
                    />
                  ) : (
                    <span className="d-inline-flex align-items-center gap-1">
                      <span>{header}</span>
                      <span
                        role="button"
                        tabIndex={disabled ? -1 : 0}
                        aria-label={`Edit uncertainty header ${idx + 1}`}
                        style={{ cursor: 'pointer', opacity: 0.4, fontSize: '10px' }}
                        onClick={() => { if (!disabled) { setEditingHeaderIdx(idx); setDraftHeader(header); } }}
                        onKeyDown={(event) => { if (!disabled && ['Enter', ' '].includes(event.key)) { event.preventDefault(); setEditingHeaderIdx(idx); setDraftHeader(header); } }}
                        title="Edit header"
                      >
                        ✎
                      </span>
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
        </table>

        <Spreadsheet
          data={disabled ? data.map((row) => row.map((cell) => ({ ...cell, readOnly: true }))) : data}
          onChange={handleChange}
          onActivate={(point) => { activeCell.current = point; }}
          onModeChange={(value) => { mode.current = value; }}
          hideColumnIndicators
          hideRowIndicators
          onKeyDown={(e) => {
            if (e.ctrlKey && e.shiftKey) {
              if (e.key === 'ArrowDown') { e.preventDefault(); handleAddRow(); }
              if (e.key === 'ArrowUp') { e.preventDefault(); handleRemoveRow(); }
              if (e.key === 'ArrowRight') { e.preventDefault(); handleAddColumn(); }
              if (e.key === 'ArrowLeft') { e.preventDefault(); handleRemoveColumn(); }
            }
          }}
        />
      </div>

      {cfg?.helperText && <div className="form-text mt-1 text-muted small">{cfg.helperText}</div>}
      {error && <div className="text-danger mt-1 small fw-bold">{error}</div>}

      <div className="form-text mt-1 text-muted small">
        Supports formulas: =SUM(A1:A5), =AVERAGE(B1:B3), =A1*2, etc.
      </div>
    </div>
  );
}
