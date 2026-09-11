'use client';

import React from 'react';

/**
 * Single skeleton block. Renders a shimmer placeholder.
 *
 * Props:
 *   width   — CSS width string or number (px). Defaults to '100%'.
 *   height  — CSS height string or number (px). Defaults to 16.
 *   variant — 'text' | 'title' | 'circle' | 'pill' | 'card' | undefined
 *   className, style — passthrough
 */
function toCss(val) {
  return typeof val === 'number' ? `${val}px` : val;
}

export function Skeleton({ width = '100%', height = 16, variant, className = '', style = {} }) {
  return (
    <span
      className={['skeleton', variant ? `skeleton--${variant}` : '', className].filter(Boolean).join(' ')}
      style={{ width: toCss(width), height: toCss(height), display: 'block', ...style }}
      aria-hidden="true"
    />
  );
}

/**
 * One or more lines of skeleton text with the last line shorter.
 */
export function SkeletonText({ lines = 1, lastLineWidth = '55%', gap = 8 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          variant="text"
          width={i === lines - 1 && lines > 1 ? lastLineWidth : '100%'}
        />
      ))}
    </div>
  );
}

/**
 * Horizontal row of skeleton chips — useful for tag/parameter rows.
 */
export function SkeletonChips({ count = 5, size = 24 }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} variant="circle" width={size} height={size} />
      ))}
    </div>
  );
}
