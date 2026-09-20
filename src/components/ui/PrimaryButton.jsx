import React from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';
import {
  getButtonSizeClass,
  hasBootstrapButtonSizeClass,
  hasBootstrapButtonVariantClass,
  renderButtonElement,
} from './buttonUtils.jsx';

const variantClassByStyle = {
  default: 'btn-primary',
  primary: 'btn-primary',
  positive: 'btn-success',
  success: 'btn-success',
  destructive: 'btn-danger',
  danger: 'btn-danger',
  red: 'btn-danger',
};

export default function PrimaryButton({
  children,
  label,
  href,
  leftIcon,
  onClick,
  rel,
  rightIcon,
  styleVariant = 'default',
  size = 'default',
  to,
  target,
  disabled = false,
  className = '',
  type = 'button',
  ...props
}) {
  const resolvedLabel = children ?? label;
  const hasLabel = Boolean(resolvedLabel);
  const hasClassVariant = hasBootstrapButtonVariantClass(className);
  const hasClassSize = hasBootstrapButtonSizeClass(className);
  const variantClass = hasClassVariant
    ? ''
    : variantClassByStyle[String(styleVariant || 'default').toLowerCase()] ?? 'btn-primary';
  const sizeClass = hasClassSize ? '' : getButtonSizeClass(size);
  const resolvedClassName = cx(
    'smplfy-btn',
    'btn',
    variantClass,
    sizeClass,
    disabled && 'disabled',
    className,
  );
  const content = (
    <>
      {leftIcon ? <AppIcon name={leftIcon} /> : null}
      {hasLabel ? <span>{resolvedLabel}</span> : null}
      {rightIcon ? <AppIcon name={rightIcon} /> : null}
    </>
  );

  return renderButtonElement({
    children: content,
    className: resolvedClassName,
    disabled,
    href,
    onClick,
    props,
    rel,
    target,
    to,
    type,
  });
}
