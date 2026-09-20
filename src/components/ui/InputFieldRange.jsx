'use client';

import { useState } from 'react';
import cx from 'classnames';
import '../../styles/form-controls.scss';

export default function InputFieldRange({ state = 'default', value, defaultValue, min = 0, max = 100, step = 1,
  showValue = true, className = '', disabled = false, onChange, ...props }) {
  const [localValue, setLocalValue] = useState(() => defaultValue ?? min);
  const controlled = value !== undefined; const inputValue = controlled ? value ?? min : localValue;
  return <div className={cx('smplfy-range-field', state === 'error' && 'is-invalid', className)}>
    <input className="smplfy-form-range form-range" type="range" min={min} max={max} step={step} value={inputValue}
      disabled={disabled || state === 'disabled'} onChange={(event) => { if (!controlled) setLocalValue(event.target.value); onChange?.(event); }} {...props} />
    {showValue ? <span className="smplfy-range-value">{String(inputValue)}</span> : null}
  </div>;
}
