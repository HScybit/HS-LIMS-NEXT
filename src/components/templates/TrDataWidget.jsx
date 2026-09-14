'use client';

import { useMemo } from 'react';
import { contextWidgetValue } from '../../templates/context-widgets.js';
import { formattedTextTitle } from '../../templates/text.js';
import { trDataText } from '../../templates/tr-data.js';

export default function TrDataWidget({ field, mode, report, parameter }) {
  const text = trDataText(contextWidgetValue(field, report, parameter));
  const markup = useMemo(() => formattedTextTitle(text), [text]);
  if (mode === 'plan') return <div className="text-muted small">TR data widget preview</div>;
  return <div className="text-break" {...(markup === null ? { children: text } : { dangerouslySetInnerHTML: { __html: markup } })} />;
}
