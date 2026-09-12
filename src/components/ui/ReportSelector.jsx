'use client';

import React from 'react';
import cx from 'classnames';
import StatusPill from './StatusPill.jsx';
import './ReportSelector.scss';


export default function ReportSelector({
  label,
  state = 'default',
  hasNabl = true,
  className = '',
  onClick,
  ...props
}) {
  return (
    <button
      type="button"
      className={cx('smplfy-report-selector', `smplfy-report-selector--${state}`, className)}
      onClick={onClick}
      aria-pressed={state === 'active'}
      {...props}
    >
      <span className="smplfy-report-selector__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 3.75h7.5l4.75 4.75v11.75a1 1 0 0 1-1 1H7A2.25 2.25 0 0 1 4.75 19V6A2.25 2.25 0 0 1 7 3.75Z" />
          <path d="M14.5 3.75V8.5h4.75" />
          <path d="M8.5 12.25h7" />
          <path d="M8.5 16.25h7" />
        </svg>
      </span>
      <span className="smplfy-report-selector__label">{label}</span>
      {hasNabl ? (
        <StatusPill color="green" styleType="neutral" className="smplfy-report-selector__pill">
          NABL
        </StatusPill>
      ) : null}
    </button>
  );
}
