import React from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';
import {
  getButtonSizeClass,
  hasBootstrapButtonSizeClass,
  hasBootstrapButtonVariantClass,
  renderButtonElement,
} from './buttonUtils.jsx';
import './SecondaryButton.scss';


const toneClassByName = {
  default: 'btn-outline-secondary',
  primary: 'btn-outline-primary',
  secondary: 'btn-outline-secondary',
  neutral: 'btn-outline-secondary',
  info: 'btn-outline-info',
  success: 'btn-outline-success',
  positive: 'btn-outline-success',
  danger: 'btn-outline-danger',
  destructive: 'btn-outline-danger',
  red: 'btn-outline-danger',
};

export default function SecondaryButton({
  children,
  label,
  href,
  leftIcon,
  leftSlot,
  onClick,
  rel,
  rightIcon,
  rightSlot,
  size = 'large',
  tone = 'neutral',
  to,
  target,
  disabled = false,
  className = '',
  type = 'button',
  ...props
}) {
  const resolvedLabel = children ?? label;
  const hasLabel = Boolean(resolvedLabel);
  const shouldWrapLabel = Boolean(leftIcon || leftSlot || rightIcon || rightSlot || label);
  const hasClassVariant = hasBootstrapButtonVariantClass(className);
  const hasClassSize = hasBootstrapButtonSizeClass(className);
  const sizeClass = hasClassSize ? '' : getButtonSizeClass(size);
  const toneClass = hasClassVariant
    ? ''
    : toneClassByName[String(tone || 'neutral').toLowerCase()] ?? 'btn-outline-secondary';
  const resolvedClassName = cx(
    'smplfy-btn',
    'btn',
    toneClass,
    sizeClass,
    disabled && 'disabled',
    className,
  );
  const content = (
    <>
      {leftSlot ?? (leftIcon ? <AppIcon name={leftIcon} /> : null)}
      {hasLabel ? shouldWrapLabel ? <span>{resolvedLabel}</span> : resolvedLabel : null}
      {rightSlot ?? (rightIcon ? <AppIcon name={rightIcon} /> : null)}
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
