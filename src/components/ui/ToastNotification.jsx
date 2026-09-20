import React from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';



export default function ToastNotification({
  state = 'default',
  tone = 'success',
  message = 'Sample Created.',
  className = '',
  onClose,
  ...props
}) {
  if (state === 'gone') {
    return null;
  }

  const iconName = tone === 'error' ? 'alert-circle' : 'checks';

  return (
    <div
      className={cx(
        'smplfy-toast',
        'toast',
        'show',
        tone === 'error' && 'text-bg-danger',
        className,
      )}
      role="status"
      aria-live="polite"
      {...props}
    >
      <div className="toast-body">
        <span className="d-inline-flex align-items-center justify-content-center flex-shrink-0" aria-hidden="true">
          <AppIcon name={iconName} />
        </span>
        <span>{message}</span>
      </div>

      <button className="btn smplfy-toast-close" aria-label="Dismiss notification" onClick={onClose}>
        <AppIcon name="close" />
      </button>
    </div>
  );
}
