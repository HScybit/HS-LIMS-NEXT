'use client';

import React from 'react';
import cx from 'classnames';
import RadioButton from './RadioButton.jsx';
import './CardSelector.scss';


export default function CardSelector({
  title,
  description,
  state = 'default',
  selected = false,
  className = '',
  onClick,
  disabled = false,
  ...props
}) {
  const resolvedState = selected ? 'active' : state;
  const isActive = resolvedState === 'active';
  const radioState = resolvedState === 'active' ? 'default' : resolvedState;
  const handleClick = (event) => {
    if (disabled) {
      event.preventDefault();
      return;
    }

    onClick?.(event);
  };
  const handleKeyDown = (event) => {
    if (disabled || !['Enter', ' '].includes(event.key)) {
      return;
    }

    event.preventDefault();
    onClick?.(event);
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      className={cx('smplfy-card', 'card', 'btn', isActive && 'active', className)}
      aria-pressed={isActive}
      aria-disabled={disabled || undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <div className="card-body">
        <RadioButton selected={selected} state={radioState} ariaLabel={title} tabIndex={-1} />
        <span className="card-title">{title}</span>
      </div>
      <div className="card-text">{description}</div>
    </div>
  );
}
