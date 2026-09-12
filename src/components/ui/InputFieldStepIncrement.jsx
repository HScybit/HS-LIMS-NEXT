'use client';

import { useState } from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';
import '../../styles/form-controls.scss';

export default function InputFieldStepIncrement({ state = 'default', value, defaultValue, min = 0, max = 360, step = 90,
  icon = 'refresh', unit = '°', className = '', disabled = false, onChange, required: _required, ...props }) {
  const [localValue, setLocalValue] = useState(() => Number(defaultValue ?? min));
  const controlled = value !== undefined && value !== ''; const currentValue = controlled ? Number(value) : localValue;
  const isDisabled = disabled || state === 'disabled';
  return <div className={cx('smplfy-step-increment-field input-group', state === 'error' && 'is-invalid', className)}>
    <span className="smplfy-step-increment-display form-control text-center">{currentValue}{unit}</span>
    <button type="button" className="smplfy-step-increment-btn smplfy-btn btn btn-light" disabled={isDisabled}
      title={`Rotate ${step}${unit}`} aria-label={`Rotate ${step}${unit}`} {...props} onClick={() => {
        const next = (currentValue + step) % max;
        if (!controlled) setLocalValue(next); onChange?.({ target: { value: next } });
      }}>
      <span className="d-inline-flex align-items-center justify-content-center" style={{ transform: `rotate(${currentValue}deg)`, transition: 'transform 0.3s ease' }} aria-hidden="true"><AppIcon name={icon} /></span>
    </button>
  </div>;
}
