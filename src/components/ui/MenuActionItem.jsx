'use client';

import React from 'react';
import cx from 'classnames';
import Link from 'next/link';
import AppIcon from './AppIcon.jsx';
import '../../styles/MenuActionItem.scss';


export default function MenuActionItem({
  disabled = false,
  href,
  label,
  leftIcon,
  className = '',
  onClick,
  rel,
  state: _state = 'Default',
  target,
  to,
  ...props
}) {
  const resolvedClassName = cx('smplfy-dropdown-item', 'dropdown-item', disabled && 'disabled', className);
  const content = (
    <>
      {leftIcon ? (
        <span className="d-inline-flex align-items-center justify-content-center" aria-hidden="true">
          <AppIcon name={leftIcon} size={16} />
        </span>
      ) : null}
      {label ? <span>{label}</span> : null}
    </>
  );
  const handleClick = (event) => {
    if (disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    onClick?.(event);
  };

  if (to) {
    return (
      <Link
        {...props}
        className={resolvedClassName}
        href={to}
        target={target}
        rel={rel}
        aria-disabled={disabled ? 'true' : undefined}
        tabIndex={disabled ? -1 : props.tabIndex}
        onClick={handleClick}
      >
        {content}
      </Link>
    );
  }

  if (href) {
    return (
      <a
        {...props}
        className={resolvedClassName}
        href={disabled ? undefined : href}
        target={target}
        rel={rel}
        aria-disabled={disabled ? 'true' : undefined}
        tabIndex={disabled ? -1 : props.tabIndex}
        onClick={handleClick}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={resolvedClassName}
      disabled={disabled}
      onClick={handleClick}
      {...props}
    >
      {content}
    </button>
  );
}
