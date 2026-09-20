'use client';

import React, { useEffect, useId, useRef } from 'react';
import cx from 'classnames';
import { createPortal } from 'react-dom';
import AppIcon from './AppIcon.jsx';
import '../../styles/modal.scss';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let openModalCount = 0;
let previousBodyOverflow = '';

const sizeClassByName = {
  small: 'modal-sm',
  sm: 'modal-sm',
  md: '',
  default: '',
  large: 'modal-lg',
  lg: 'modal-lg',
  extralarge: 'modal-xl',
  'extra-large': 'modal-xl',
  xl: 'modal-xl',
};

function lockBodyScroll() {
  if (typeof document === 'undefined') {
    return () => {};
  }

  if (openModalCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('app-modal-open');
  }

  openModalCount += 1;

  return () => {
    openModalCount = Math.max(0, openModalCount - 1);
    if (openModalCount === 0) {
      document.body.style.overflow = previousBodyOverflow;
      document.body.classList.remove('app-modal-open');
    }
  };
}

export default function Modal({
  open,
  title,
  subtitle,
  titleId,
  titleIcon,
  titleExtra,
  onClose,
  children,
  actions,
  size = 'md',
  className = '',
  cardClassName = '',
  bodyClassName = '',
  actionsClassName = '',
  showCloseButton = true,
  closeLabel = 'Close modal',
}) {
  const generatedTitleId = useId();
  const resolvedTitleId = titleId || generatedTitleId;
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;

    const unlockBodyScroll = lockBodyScroll();
    const previouslyFocusedElement = document.activeElement;
    const dialog = dialogRef.current;

    const focusDialog = window.requestAnimationFrame(() => {
      // A user may already have focused an input before this animation frame.
      // Do not steal that focus and close a newly opened select menu.
      if (dialog?.contains(document.activeElement)) return;
      const firstFocusable = dialog?.querySelector(FOCUSABLE_SELECTOR);
      (firstFocusable || dialog)?.focus?.();
    });

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onCloseRef.current?.();
        return;
      }

      if (event.key !== 'Tab' || !dialog) return;

      const focusableElements = Array.from(
        dialog.querySelectorAll(FOCUSABLE_SELECTOR),
      ).filter((element) => element.offsetParent !== null);

      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusDialog);
      document.removeEventListener('keydown', handleKeyDown);
      unlockBodyScroll();

      if (
        previouslyFocusedElement &&
        typeof previouslyFocusedElement.focus === 'function' &&
        document.contains(previouslyFocusedElement)
      ) {
        previouslyFocusedElement.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const sizeClass = sizeClassByName[String(size || 'md').toLowerCase()] ?? '';
  const modalContent = (
    <div className="smplfy-modal modal show d-block">
      <div className="modal-backdrop show" onClick={onClose} />
      <div className={cx('smplfy-modal-dialog modal-dialog modal-dialog-centered', sizeClass, cardClassName)}>
        <div
          ref={dialogRef}
          className={cx('smplfy-modal-content modal-content', className)}
          role="dialog"
          aria-modal="true"
          aria-labelledby={resolvedTitleId}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="smplfy-modal-header modal-header">
            <div className="smplfy-modal-title-row d-flex align-items-center gap-2 flex-grow-1 min-w-0">
              {titleIcon ? <AppIcon name={titleIcon} size={24} className="smplfy-modal-title-icon flex-shrink-0" /> : null}
              <div className="smplfy-modal-title-stack d-flex flex-column min-w-0 flex-grow-1">
                <div className="smplfy-modal-title-line d-flex align-items-center gap-2 min-w-0">
                  <h2 className="smplfy-modal-title modal-title" id={resolvedTitleId}>{title}</h2>
                  {titleExtra ? <div className="smplfy-modal-title-extra ms-2">{titleExtra}</div> : null}
                </div>
                {subtitle ? <div className="smplfy-modal-subtitle">{subtitle}</div> : null}
              </div>
            </div>

            {showCloseButton ? (
              <button
                type="button"
                className="smplfy-modal-close btn-close"
                aria-label={closeLabel}
                onClick={onClose}
              >
                <AppIcon name="close" size={24} />
              </button>
            ) : null}
          </div>

          <div className={cx('smplfy-modal-body modal-body', bodyClassName)}>{children}</div>

          {actions ? <div className={cx('smplfy-modal-footer modal-footer', actionsClassName)}>{actions}</div> : null}
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
}
