'use client';

import FormElement from '../ui/FormElement.jsx';

export function SampleTextField({ label, value, onChange, textarea = false, ...props }) {
  return <FormElement label={label} mandatory={Boolean(props.required)} type={textarea ? 'textarea' : 'text'}
    inputProps={{ ...props, value, onChange: (event) => onChange(event.target.value) }} />;
}

export function SampleSelectField({ label, value, onChange, options, ...props }) {
  return <FormElement label={label} mandatory={Boolean(props.required)} type="searchable-select" inputProps={{ ...props, value, onChange, options }} />;
}

export function SampleFormSection({ id, title, children }) {
  return <section className="smplfy-card card overflow-hidden" aria-labelledby={`${id}-title`}>
    <header className="card-header bg-white px-4 py-3 d-flex align-items-center justify-content-between gap-3 flex-wrap">
      <h2 className="h5 fw-semibold text-body mb-0" id={`${id}-title`}>{title}</h2>
    </header><div className="card-body p-0">{children}</div>
  </section>;
}

export const optionList = (items) => items.map((item) => ({ value: item.id, label: item.name }));
