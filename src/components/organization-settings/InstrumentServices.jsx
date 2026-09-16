'use client';

import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { instrumentServiceLimits } from '../../organization-settings/instrument-services.js';

export function blankInstrumentService() {
  return { id: crypto.randomUUID(), serviceCode: '', displayLabel: '', isActive: true };
}

export default function InstrumentServices({ rows, disabled, onChange }) {
  const keys = rows.map(row => row.serviceCode.trim().toLowerCase());
  function update(id, changes) { onChange(rows.map(row => row.id === id ? { ...row, ...changes } : row)); }
  function remove(id) {
    const remaining = rows.filter(row => row.id !== id); onChange(remaining.length ? remaining : [blankInstrumentService()]);
  }
  return <section className="settings-section">
    <h6 className="settings-section__title">Instrument Management</h6>
    <div className="mb-3"><label className="smplfy-form-element__label d-block mb-2">Instrument Services</label>
      <div className="d-flex flex-column gap-3">
        {rows.map((row, index) => {
          const duplicate = keys[index] && keys.indexOf(keys[index]) !== keys.lastIndexOf(keys[index]);
          return <div className="row g-2 align-items-start" key={row.id}>
            <div className="col-4"><label className="form-label small text-muted mb-1" htmlFor={`service-${row.id}-key`}>Key</label>
              <input id={`service-${row.id}-key`} aria-label={`Instrument service ${index + 1} key`} className={`form-control${duplicate ? ' is-invalid' : ''}`}
                aria-invalid={duplicate ? true : undefined} value={row.serviceCode} disabled={disabled} maxLength={instrumentServiceLimits.code}
                autoComplete="off" placeholder="e.g: calibration" onChange={event => update(row.id, { serviceCode: event.target.value.replace(/[^A-Za-z0-9._/-]/g, '') })} />
              {duplicate ? <div className="invalid-feedback d-block">Key must be unique.</div> : null}
            </div>
            <div className="col-4"><label className="form-label small text-muted mb-1" htmlFor={`service-${row.id}-value`}>Value</label>
              <input id={`service-${row.id}-value`} aria-label={`Instrument service ${index + 1} name`} className="form-control" value={row.displayLabel}
                disabled={disabled} maxLength={instrumentServiceLimits.label} placeholder="e.g: Calibration Schedule"
                onChange={event => update(row.id, { displayLabel: event.target.value })} />
            </div>
            <div className="col-md-2 pt-md-4"><div className="smplfy-checkbox-field">
              <Checkbox id={`service-${row.id}-active`} ariaLabel={`Instrument service ${index + 1} Active`} checked={row.isActive} disabled={disabled}
                onChange={isActive => update(row.id, { isActive })} />
              <label className="smplfy-checkbox-field__label" htmlFor={`service-${row.id}-active`}>Active</label>
            </div></div>
            {!disabled ? <div className="col-md-auto pt-md-4"><SecondaryButton type="button" tone="danger" size="large" leftIcon="trash"
              aria-label={`Remove instrument service ${index + 1}`} onClick={() => remove(row.id)} /></div> : null}
          </div>;
        })}
        <div className="form-text">Keys can contain letters, numbers, dots, slashes, underscores or hyphens. Values are shown in navigation.</div>
        {!disabled ? <PrimaryButton type="button" size="small" leftIcon="plus" disabled={rows.length >= instrumentServiceLimits.rows}
          onClick={() => onChange([...rows, blankInstrumentService()])}>Add Service</PrimaryButton> : null}
      </div>
    </div>
  </section>;
}
