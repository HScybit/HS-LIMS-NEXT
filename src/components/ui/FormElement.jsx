'use client';

import { useId } from 'react';
import cx from 'classnames';
import InputFieldText from './InputFieldText.jsx';

export default function FormElement({
  type = 'text',
  mandatory = false,
  label,
  labelActions,
  helperText,
  message,
  messageTone = 'helper',
  inputProps = {},
  className = '',
}) {
  if (type !== 'text') throw new Error('This control requires a supported input type.');
  const InputComponent = InputFieldText;
  const generatedId = useId();
  const inputId = inputProps.id ?? `field-${generatedId}`;
  const helperId = helperText ? `${inputId}-helper` : undefined;
  const messageId = message ? `${inputId}-message` : undefined;
  const isInvalid = Boolean(message && messageTone === 'error');
  const describedBy = [inputProps['aria-describedby'], helperId, messageId]
    .filter(Boolean)
    .join(' ') || undefined;
  const resolvedInputProps = {
    ...inputProps,
    id: inputId,
    required: inputProps.required ?? mandatory,
    state: inputProps.state ?? (isInvalid ? 'error' : undefined),
    'aria-invalid': inputProps['aria-invalid'] ?? (isInvalid ? 'true' : undefined),
    'aria-describedby': describedBy,
  };

  return (
    <div className={cx('smplfy-form-field', className)}>
      {label ? (
        <div className="smplfy-form-label-row">
          <label className="smplfy-form-label form-label" htmlFor={inputId}>
            {label}
          </label>
          {mandatory ? <span className="smplfy-form-required">*</span> : null}
          {labelActions ? <div className="smplfy-form-label-actions">{labelActions}</div> : null}
        </div>
      ) : null}

      <InputComponent {...resolvedInputProps} />

      {helperText ? (
        <div id={helperId} className="smplfy-form-text form-text">
          {helperText}
        </div>
      ) : null}

      {message ? (
        <div
          id={messageId}
          className={cx(
            'smplfy-form-feedback',
            messageTone === 'error' ? 'invalid-feedback' : 'form-text',
            messageTone === 'warning' && 'text-warning',
          )}
        >
          {message}
        </div>
      ) : null}
    </div>
  );
}
