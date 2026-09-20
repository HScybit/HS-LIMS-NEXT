import React from 'react';
import cx from 'classnames';
import './StatusPill.scss';


const neutralClassByColor = {
  gray: 'text-secondary bg-secondary-subtle border border-secondary-subtle',
  blue: 'text-primary bg-primary-subtle border border-primary-subtle',
  red: 'text-danger bg-danger-subtle border border-danger-subtle',
  orange: 'text-warning bg-warning-subtle border border-warning',
  green: 'text-success bg-success-subtle border border-success-subtle',
  yellow: 'text-warning-emphasis bg-warning-subtle border border-warning-subtle',
};

const strongClassByColor = {
  gray: 'text-bg-secondary border border-secondary',
  blue: 'text-bg-primary border border-primary',
  red: 'text-bg-danger border border-danger',
  orange: 'text-bg-warning border border-warning',
  green: 'text-bg-success border border-success',
  yellow: 'text-bg-warning border border-warning-subtle',
};

export default function StatusPill({
  children,
  label,
  color = 'gray',
  styleType = 'neutral',
  className = '',
  ...props
}) {
  const resolvedLabel = children ?? label;
  const isStrong = styleType === 'strong' || styleType === 'solid';
  const colorKey = String(color || 'gray').toLowerCase();
  const variantClass = isStrong
    ? strongClassByColor[colorKey] ?? strongClassByColor.gray
    : neutralClassByColor[colorKey] ?? neutralClassByColor.gray;

  return (
    <span
      className={cx(
        'smplfy-status-pill',
        'smplfy-badge',
        'badge',
        variantClass,
        className,
      )}
      {...props}
    >
      {resolvedLabel}
    </span>
  );
}
