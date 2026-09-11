'use client';

import React, { useState } from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';
import { normalizeSelectOptions } from './selectUtils.js';
import '../../styles/form-controls.scss';

export default function InputFieldDropdown({
  state = 'default',
  value,
  defaultValue,
  placeholder = '',
  options = [],
  className = '',
  disabled = false,
  onChange,
  ...props
}) {
  const isControlled = value !== undefined;
  const [localValue, setSelectedValue] = useState(() => defaultValue ?? '');
  const selectedValue = isControlled ? value ?? '' : localValue;

  const isDisabled = disabled || state === 'disabled';
  const isInvalid = state === 'error';
  const isFilled = state === 'filled' || state === 'active-multiselect' || Boolean(selectedValue);
  const resolvedOptions = normalizeSelectOptions(options);

  return (
    <div
      className={cx(
        'smplfy-select-field',
        !isFilled && 'smplfy-form-empty',
        state === 'hover' && 'smplfy-form-hover',
        state === 'focused' && 'smplfy-form-focused',
        className,
      )}
    >
      <select
        className={cx(
          'smplfy-form-select',
          'form-select',
          isInvalid && 'is-invalid',
        )}
        value={selectedValue}
        disabled={isDisabled}
        onChange={(event) => {
          if (!isControlled) setSelectedValue(event.target.value);
          onChange?.(event);
        }}
        {...props}
      >
        <option value="">{placeholder}</option>
        {resolvedOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="smplfy-select-icon" aria-hidden="true">
        <AppIcon name="chevron-down" />
      </span>
    </div>
  );
}
