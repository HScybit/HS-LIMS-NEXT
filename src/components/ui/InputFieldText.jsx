'use client';

import React, { useRef, useState } from 'react';
import cx from 'classnames';
import '../../styles/form-controls.scss';

export default function InputFieldText({
  state = 'default',
  filled = false,
  value,
  defaultValue,
  placeholder = '',
  className = '',
  type = 'text',
  disabled = false,
  max,
  min,
  onChange,
  onClick,
  onPointerDown,
  ...props
}) {
  const isControlled = value !== undefined;
  const pointerOpenedPickerRef = useRef(false);
  const [localValue, setInputValue] = useState(() => defaultValue ?? '');
  const inputValue = isControlled ? value ?? '' : localValue;

  const isDisabled = disabled || state === 'disabled';
  const isInvalid = state === 'error';
  const isFilled = filled || Boolean(inputValue);
  const isDateInput = type === 'date';

  const openDatePicker = (input) => {
    if (!isDateInput || isDisabled || !input || typeof input.showPicker !== 'function') {
      return false;
    }

    try {
      input.focus({ preventScroll: true });
      input.showPicker();
      return true;
    } catch {
      return false;
    }
  };

  const skipNextClickPicker = () => {
    pointerOpenedPickerRef.current = true;
    window.setTimeout(() => {
      pointerOpenedPickerRef.current = false;
    }, 300);
  };

  return (
    <input
      className={cx(
        'smplfy-form-control',
        'form-control',
        isInvalid && 'is-invalid',
        !isFilled && 'smplfy-form-empty',
        state === 'hover' && 'smplfy-form-hover',
        state === 'focused' && 'smplfy-form-focused',
        className,
      )}
      type={type}
      value={inputValue}
      placeholder={placeholder}
      max={max}
      min={min}
      disabled={isDisabled}
      onChange={(event) => {
        if (!isControlled) setInputValue(event.target.value);
        onChange?.(event);
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);

        if (!event.defaultPrevented && openDatePicker(event.currentTarget)) {
          event.preventDefault();
          skipNextClickPicker();
        }
      }}
      onClick={(event) => {
        onClick?.(event);

        if (pointerOpenedPickerRef.current) {
          pointerOpenedPickerRef.current = false;
          return;
        }

        if (!event.defaultPrevented) {
          openDatePicker(event.currentTarget);
        }
      }}
      {...props}
    />
  );
}
