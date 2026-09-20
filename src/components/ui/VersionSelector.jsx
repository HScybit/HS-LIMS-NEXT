'use client';

import React, { useEffect, useRef, useState } from 'react';
import cx from 'classnames';
import SecondaryButton from './SecondaryButton.jsx';
import '../../styles/MenuActionItem.scss';
import './VersionSelector.scss';


export default function VersionSelector({
  value,
  options = [],
  className = '',
  disabled = false,
  onChange,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <div
      ref={rootRef}
      className={cx('smplfy-dropdown', 'dropdown', open && 'show', className)}
      style={{
        '--smplfy-dropdown-trigger-min-width': 'var(--smplfy-version-selector-trigger-min-width)',
        '--smplfy-dropdown-menu-current-min-width': 'var(--smplfy-version-selector-menu-min-width)',
        '--smplfy-dropdown-menu-inset-inline-start': 'var(--smplfy-dropdown-menu-align-start)',
        '--smplfy-dropdown-menu-inset-inline-end': 'var(--smplfy-dropdown-menu-align-auto)',
        '--smplfy-dropdown-menu-radius': 'var(--smplfy-version-selector-menu-radius)',
        '--smplfy-dropdown-menu-gap': 'var(--smplfy-version-selector-menu-gap)',
        '--smplfy-dropdown-item-min-height': 'var(--smplfy-version-selector-item-min-height)',
        '--smplfy-dropdown-item-padding-y': 'var(--smplfy-version-selector-item-padding-y)',
        '--smplfy-dropdown-item-padding-start': 'var(--smplfy-version-selector-item-padding-x)',
        '--smplfy-dropdown-item-padding-end': 'var(--smplfy-version-selector-item-padding-x)',
      }}
    >
      <SecondaryButton
        size="medium"
        rightIcon="chevron-down"
        disabled={disabled}
        className={cx('dropdown-toggle', open && 'show')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selectedOption?.label ?? ''}
      </SecondaryButton>

      {open ? (
        <div className="smplfy-dropdown-menu dropdown-menu show" role="menu" aria-label="Select version">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={cx(
                'smplfy-dropdown-item',
                'dropdown-item',
                option.value === value && 'active',
              )}
              onClick={() => {
                setOpen(false);
                if (option.value !== value) {
                  onChange?.(option.value);
                }
              }}
            >
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
