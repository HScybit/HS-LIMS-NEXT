'use client';

import { useMemo, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import { editedTextTitle, formattedTextTitle, textWidgetTitle } from '../../templates/text.js';

export default function TextWidget({ field, mode, value, occurrenceId, disabled, onBeginEdit, onChange, onCommit }) {
  const title = textWidgetTitle(field, value);
  const markup = useMemo(() => formattedTextTitle(title), [title]);
  const titleProps = markup === null ? { children: title } : { dangerouslySetInnerHTML: { __html: markup } };
  const label = field.alias || field.label || 'text';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const session = useRef(null);
  function change(nextDraft) {
    setDraft(nextDraft);
    const next = editedTextTitle(session.current.title, nextDraft);
    if (next === null) session.current.restore?.();
    else onChange?.(field.id, occurrenceId, next);
  }
  function begin() {
    if (disabled) return;
    session.current = { title, restore: onBeginEdit?.(field.id, occurrenceId) };
    setEditing(true); change(title);
  }
  function finish(save) {
    const current = session.current;
    if (!current) return;
    session.current = null;
    const next = save ? editedTextTitle(current.title, draft) : null;
    if (next === null) current.restore?.();
    else { onChange?.(field.id, occurrenceId, next); onCommit?.(field.id, occurrenceId, next); }
    setEditing(false);
  }
  if (mode !== 'edit' || !field.editable) return <div {...titleProps} />;
  if (editing) return <input className="form-control form-control-sm text-center" aria-label={`Edit ${label}`} value={draft} disabled={disabled}
    onChange={(event) => change(event.target.value)} onBlur={() => finish(true)} autoFocus
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); finish(event.key === 'Enter'); }
    }} />;
  return <span className="d-flex align-items-center w-100">
    <button type="button" className="border-0 bg-transparent p-0 text-body flex-grow-1 text-center" style={{ font: 'inherit' }} disabled={disabled} onClick={begin} {...titleProps} />
    <button type="button" className="border-0 bg-transparent p-0 text-primary d-inline-flex align-items-center flex-shrink-0" title="Edit" aria-label={`Edit ${label}`} disabled={disabled} onClick={begin}><AppIcon name="edit" size={14} /></button>
  </span>;
}
