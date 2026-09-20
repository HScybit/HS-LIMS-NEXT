import React from 'react';
import Link from 'next/link';

const bootstrapButtonVariantClassPattern = /\bbtn-(primary|secondary|success|danger|warning|info|light|dark|link|outline-[a-z-]+)\b/;
const bootstrapButtonSizeClassPattern = /\bbtn-(sm|lg)\b/;

export function hasBootstrapButtonVariantClass(className = '') {
  return bootstrapButtonVariantClassPattern.test(className);
}

export function hasBootstrapButtonSizeClass(className = '') {
  return bootstrapButtonSizeClassPattern.test(className);
}

export function getButtonSizeClass(size) {
  const resolvedSize = String(size || 'default').toLowerCase();

  if (resolvedSize === 'small' || resolvedSize === 'medium') {
    return 'btn-sm';
  }

  if (resolvedSize === 'large') {
    return 'btn-lg';
  }

  return '';
}

export function renderButtonElement({
  children,
  className,
  disabled = false,
  href,
  onClick,
  props = {},
  rel,
  target,
  to,
  type = 'button',
}) {
  const handleLinkClick = (event) => {
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
        className={className}
        href={to}
        target={target}
        rel={rel}
        aria-disabled={disabled ? 'true' : undefined}
        tabIndex={disabled ? -1 : props.tabIndex}
        onClick={handleLinkClick}
      >
        {children}
      </Link>
    );
  }

  if (href) {
    return (
      <a
        {...props}
        className={className}
        href={disabled ? undefined : href}
        target={target}
        rel={rel}
        aria-disabled={disabled ? 'true' : undefined}
        tabIndex={disabled ? -1 : props.tabIndex}
        onClick={handleLinkClick}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      type={type}
      disabled={disabled}
      className={className}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
}
