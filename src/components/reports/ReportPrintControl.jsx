'use client';

import { useEffect, useRef, useState } from 'react';
import SplitSecondaryButton from '../ui/SplitSecondaryButton.jsx';
import { prepareReportPrint, printReportBlob } from '../../reports/print-client.js';

export default function ReportPrintControl({ reportId, disabled, onError }) {
  const [printing, setPrinting] = useState(false);
  const active = useRef(null);
  useEffect(() => () => active.current?.abort(), []);

  async function print() {
    if (active.current || disabled) return;
    const controller = new AbortController(); active.current = controller;
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
    setPrinting(true); onError('');
    try {
      const blob = await prepareReportPrint(reportId, controller.signal);
      await printReportBlob(blob, controller.signal);
    } catch (error) {
      if (timedOut) onError('The report is still being prepared. Use Print again to check its progress.');
      else if (!controller.signal.aborted) onError(error.message);
    } finally {
      clearTimeout(deadline); active.current = null;
      if (!controller.signal.aborted || timedOut) setPrinting(false);
    }
  }

  return <SplitSecondaryButton label={printing ? 'Printing...' : 'Print'} leftIcon="file-text" disabled={disabled || printing}
    onPrimaryClick={print} menuItems={[{ key: 'print', label: 'Print PDF', icon: 'printer', onClick: print }]} />;
}
