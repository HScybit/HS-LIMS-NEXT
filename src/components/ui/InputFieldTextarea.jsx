'use client';

import React, { useState } from 'react';
import cx from 'classnames';
import '../../styles/form-controls.scss';

export default function InputFieldTextarea({
  state = 'default',
  filled = false,
  value,
  defaultValue,
  placeholder = '',
  rows = 3,
  className = '',
  disabled = false,
  onChange,
  ...props
}) {
  const isControlled = value !== undefined;
  const [localValue, setInputValue] = useState(() => defaultValue ?? '');
  const inputValue = isControlled ? value ?? '' : localValue;

  const isDisabled = disabled || state === 'disabled';
  const isInvalid = state === 'error';
  const isFilled = filled || Boolean(inputValue);

  return (
    <textarea
      className={cx(
        'smplfy-form-control',
        'smplfy-form-textarea',
        'form-control',
        isInvalid && 'is-invalid',
        !isFilled && 'smplfy-form-empty',
        state === 'hover' && 'smplfy-form-hover',
        state === 'focused' && 'smplfy-form-focused',
        className,
      )}
      value={inputValue}
      placeholder={placeholder}
      rows={rows}
      disabled={isDisabled}
      onChange={(event) => {
        if (!isControlled) setInputValue(event.target.value);
        onChange?.(event);
      }}
      {...props}
    />
  );
}
