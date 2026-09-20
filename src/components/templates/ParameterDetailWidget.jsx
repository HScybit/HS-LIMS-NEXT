'use client';

import AppIcon from '../ui/AppIcon.jsx';
import { parameterDetailPayload } from '../../templates/parameter-detail.js';

export default function ParameterDetailWidget({ field, mode, value, captured, parameter, onRefresh, occurrenceId, disabled }) {
  if (mode === 'plan') return <div className="text-muted small">Parameter detail preview</div>;
  const details = parameter?.parameterDetailValues;
  const displayed = captured ? parameterDetailPayload(value) : details && Object.hasOwn(details, field.label) ? details[field.label] : '';
  return <div className="d-flex align-items-start gap-2">
    <div className="flex-grow-1 text-break">{displayed ?? ''}</div>
    <button type="button" className="btn btn-warning btn-sm px-2 py-1" title="Refresh detail" aria-label="Refresh detail"
      disabled={mode !== 'edit' || disabled || !onRefresh} onClick={() => onRefresh(field.id, occurrenceId)}><AppIcon name="fa-refresh" /></button>
  </div>;
}
