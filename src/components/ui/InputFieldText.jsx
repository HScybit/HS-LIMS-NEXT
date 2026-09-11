'use client';

import { useState } from 'react';
import cx from 'classnames';

// Source classes and input states; controlled inputs use their current prop directly.
export default function InputFieldText({ state = 'default', filled = false, value, defaultValue = '', className = '', disabled = false, onChange, ...props }) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const current = value === undefined ? internalValue : value ?? '';
  return <input {...props} value={current} disabled={disabled || state === 'disabled'}
    className={cx('smplfy-form-control', 'form-control', state === 'error' && 'is-invalid', !filled && !current && 'smplfy-form-empty', state === 'hover' && 'smplfy-form-hover', state === 'focused' && 'smplfy-form-focused', className)}
    onChange={(event) => { if (value === undefined) setInternalValue(event.target.value); onChange?.(event); }} />;
}
