'use client';

import { useId, useRef, useState } from 'react';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import { sampleLineAttributes, sampleLineValue } from '../../templates/sample-line.js';

function LineAttributeSelector({ field, onCommand, disabled }) {
  const inputId = useId();
  const pending = useRef(false);
  const [draft, setDraft] = useState(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  async function save(value) {
    if (pending.current || disabled || !onCommand) return;
    pending.current = true; setSaving(true); setDraft(value); setFailed(false);
    try {
      if (await onCommand({ type: 'selectSampleLineAttribute', fieldId: field.id, sourceField: value })) setDraft(null);
      else setFailed(true);
    } catch { setFailed(true); }
    finally { pending.current = false; setSaving(false); }
  }
  return <div className="d-flex flex-column gap-2">
    <label htmlFor={inputId} className="form-label mb-0">Line Item Attribute</label>
    <SearchableSelect inputId={inputId} options={sampleLineAttributes} value={draft ?? field.sourceField ?? ''}
      disabled={disabled || saving || !onCommand} onChange={(value) => save(value || '')} placeholder="Select attribute" />
    {failed ? <div className="small text-danger" role="status">Selection not saved. <button type="button" className="btn btn-link btn-sm p-0" disabled={disabled || saving} onClick={() => save(draft)}>Retry</button></div> : null}
  </div>;
}

export default function SampleLineWidget({ field, mode, lineItem, onCommand, disabled }) {
  return mode === 'plan' ? <LineAttributeSelector key={field.id} field={field} onCommand={onCommand} disabled={disabled} />
    : <div className="text-break">{sampleLineValue(field, lineItem)}</div>;
}
