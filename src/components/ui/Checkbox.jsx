import React from 'react';
import cx from 'classnames';


export default function Checkbox({
  checked = false,
  onChange,
  className = '',
  ariaLabel,
  'aria-label': ariaLabelAttribute,
  disabled = false,
  invalid = false,
  type: _type,
  ...props
}) {
  const resolvedAriaLabel = ariaLabel ?? ariaLabelAttribute;

  return (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      aria-label={resolvedAriaLabel}
      aria-invalid={props['aria-invalid'] ?? (invalid ? 'true' : undefined)}
      disabled={disabled}
      readOnly={onChange ? undefined : true}
      className={cx(
        'smplfy-checkbox',
        'smplfy-form-check-input',
        'form-check-input',
        invalid ? 'is-invalid' : '',
        className,
      )}
      onChange={(event) => {
        onChange?.(event.target.checked, event);
      }}
    />
  );
}
