'use client';

import React, { useEffect, useRef, useState } from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';
import MenuActionItem from './MenuActionItem.jsx';
import '../../styles/MoreActionButton.scss';


export default function MoreActionButton({ className = '', items, ...props }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuItems = items ?? [
    { key: 'print', label: 'Print', leftIcon: 'printer' },
    { key: 'configure', label: 'Configure', leftIcon: 'settings' },
  ];

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

  return (
    <div ref={rootRef} className={cx('smplfy-dropdown', 'dropdown', open && 'show', className)}>
      <button
        type="button"
        className={cx('smplfy-btn', 'btn', 'btn-outline-secondary', 'dropdown-toggle', open && 'show')}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        {...props}
      >
        <AppIcon name="more" size={20} />
      </button>

      {open ? (
        <div
          className="smplfy-dropdown-menu dropdown-menu show"
          role="menu"
          aria-label="More actions"
        >
          {menuItems.map((item) => (
            <MenuActionItem
              key={item.key}
              label={item.label}
              leftIcon={item.leftIcon}
              disabled={item.disabled}
              href={item.href}
              rel={item.rel}
              role="menuitem"
              state={item.state}
              target={item.target}
              to={item.to}
              onClick={(event) => {
                if (item.disabled) return;
                item.onClick?.(event);
                setOpen(false);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
