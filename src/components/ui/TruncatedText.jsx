'use client';

import React from 'react';

export const LISTING_TEXT_MAX_LENGTH = 20;

export function getTruncatedTextValue(value, fallback = '-') {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (value instanceof Date) {
    return value.toLocaleString();
  }

  if (Array.isArray(value)) {
    const joinedValue = value
      .map((item) => getTruncatedTextValue(item, ''))
      .filter(Boolean)
      .join(', ');

    return joinedValue || fallback;
  }

  if (typeof value === 'object') {
    const displayValue = value.label ?? value.name ?? value.title ?? value.value ?? value.id ?? value._id;

    if (displayValue !== null && displayValue !== undefined && displayValue !== '') {
      return getTruncatedTextValue(displayValue, fallback);
    }

    try {
      const jsonValue = JSON.stringify(value);
      return jsonValue && jsonValue !== '{}' ? jsonValue : fallback;
    } catch {
      return fallback;
    }
  }

  return String(value);
}

export function truncateText(value, maxLength = LISTING_TEXT_MAX_LENGTH, fallback = '-') {
  const textValue = getTruncatedTextValue(value, fallback);

  if (textValue.length <= maxLength) {
    return textValue;
  }

  return `${textValue.slice(0, maxLength)}...`;
}

export function isTruncatedText(value, maxLength = LISTING_TEXT_MAX_LENGTH, fallback = '-') {
  return getTruncatedTextValue(value, fallback).length > maxLength;
}

export default function TruncatedText({
  as: Component = 'span',
  value,
  children,
  maxLength = LISTING_TEXT_MAX_LENGTH,
  fallback = '-',
  className = '',
  title,
  ...props
}) {
  const sourceValue = children ?? value;
  const fullText = getTruncatedTextValue(sourceValue, fallback);
  const displayText = truncateText(sourceValue, maxLength, fallback);
  const resolvedTitle = title ?? (fullText.length > maxLength ? fullText : undefined);

  return (
    <Component
      {...props}
      className={className || undefined}
      title={resolvedTitle}
    >
      {displayText}
    </Component>
  );
}
