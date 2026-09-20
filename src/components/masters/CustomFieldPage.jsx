'use client';

import { useEffect, useState } from 'react';
import CustomFieldForm, { customFieldFormFields } from './CustomFieldForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function CustomFieldView({ field }) {
  const rows = customFieldFormFields.flatMap((config) => {
    const raw = field[config.name];
    if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) return [];
    let value = raw;
    if (config.type === 'boolean') value = raw ? 'Yes' : 'No';
    else if (config.type === 'select') value = config.options.find((option) => option.value === raw)?.label ?? raw;
    else if (config.type === 'role') value = config.multiple ? field.editRoles.map((role) => role.name).filter(Boolean).join(', ') || raw.join(', ')
      : field.associatedWithRoleName ?? raw;
    else if (config.type === 'options') value = <div className="border rounded overflow-auto" style={{ maxHeight: 300 }}>
      <table className="table table-bordered table-sm m-0 bg-white text-center" aria-label="Dropdown Options"><thead className="bg-light"><tr>
        {['Key', 'Label'].map((label) => <th key={label} className="px-2 py-1 fw-semibold" style={{ fontSize: 12 }}>{label}</th>)}
      </tr></thead><tbody>{raw.map((option) => <tr key={option.id}>
        <td className="px-2 py-1" style={{ fontSize: 13 }}>{formatText(option.key)}</td><td className="px-2 py-1" style={{ fontSize: 13 }}>{formatText(option.label)}</td>
      </tr>)}</tbody></table>
    </div>;
    else value = formatText(raw);
    return [[config.label, value]];
  });
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break">{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}

function formatText(value) {
  // The source details formatter localizes date-like text, including authored option labels.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value.trim()) && !Number.isNaN(new Date(value).getTime())) return new Date(value).toLocaleString();
  return String(value);
}

export default function CustomFieldPage({ fieldId, mode, canManage }) {
  const [field, setField] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!fieldId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/project-fields/${fieldId}`, { signal: controller.signal }).then((value) => { setField(value); setError(''); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [fieldId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage custom fields.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div></div>;
  if (!fieldId) return <CustomFieldForm />;
  if (!field) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Project Field...</div></div>;
  return mode === 'view' ? <CustomFieldView field={field} /> : <CustomFieldForm key={field.id} field={field} />;
}
