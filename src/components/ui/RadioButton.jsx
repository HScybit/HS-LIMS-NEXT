'use client';

import React from 'react';
import cx from 'classnames';
import './RadioButton.scss';

export default function RadioButton({
  selected,
  checked,
  state: _state = 'default',
  className = '',
  ariaLabel,
  'aria-label': ariaLabelAttribute,
  onClick,
  onChange,
  disabled = false,
  type: _type,
  as: _as,
  ...props
}) {
  const isSelected = checked ?? selected ?? false;
  const resolvedAriaLabel = ariaLabel ?? ariaLabelAttribute;

  return (
    <input
      {...props}
      type="radio"
      checked={isSelected}
      aria-label={resolvedAriaLabel}
      disabled={disabled}
      readOnly={onChange ? undefined : true}
      className={cx(
        'smplfy-form-check-input',
        'form-check-input',
        className,
      )}
      onClick={onClick}
      onChange={(event) => {
        onChange?.(event.target.checked, event);
      }}
    />
  );
}
