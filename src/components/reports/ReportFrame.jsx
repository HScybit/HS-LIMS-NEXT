'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReportContent from './ReportContent.jsx';

export default function ReportFrame({ report, onReady, onError }) {
  const frame = useRef(null); const [target, setTarget] = useState(null);
  const source = useMemo(() => {
    if (!/^[a-f0-9]{64}$/.test(report.rendererId)) return '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
      <link id="report-base-styles" rel="stylesheet" href="/api/report-renderers/${report.rendererId}/stylesheet">
      <style>html,body{margin:0;min-height:0}.finalised-report-preview__body{position:relative;padding:16px}.nabl_mode .show_in_non_nabl,.non_nabl_mode .show_in_nabl{display:none!important}</style></head><body><div id="report-preview-root"></div></body></html>`;
  }, [report.rendererId]);
  useEffect(() => {
    if (!target) return;
    let active = true; let resize;
    const timer = window.setTimeout(() => { if (active) onError('The report preview did not finish loading. Please retry.'); }, 15_000);
    function measure() {
      if (active && frame.current) frame.current.style.height = `${Math.min(1_000_000, Math.max(1, Math.ceil(target.getBoundingClientRect().height)))}px`;
    }
    async function ready() {
      try {
        const document = target.ownerDocument;
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode()));
        if (!active) return;
        resize = new ResizeObserver(measure); resize.observe(target); measure();
        window.clearTimeout(timer); onReady(report);
      } catch { if (active) onError('A captured report image could not be loaded. Please retry.'); }
    }
    void ready();
    return () => { active = false; resize?.disconnect(); window.clearTimeout(timer); onReady(null); };
  }, [target, report, onReady, onError]);
  function loaded(event) {
    const document = event.currentTarget.contentDocument;
    try {
      // Chrome can retain an empty CSSStyleSheet after an HTTP error.
      if (!document?.getElementById('report-base-styles')?.sheet?.cssRules.length) throw new Error('Stylesheet unavailable');
    } catch { onError('The report stylesheet could not be loaded. Please retry.'); return; }
    setTarget(document.getElementById('report-preview-root'));
  }
  return <>
    <iframe ref={frame} className="finalised-report-preview__frame" title={`Report preview: ${report.report.reportNumber}`}
      sandbox="allow-same-origin" srcDoc={source} onLoad={loaded} />
    {target ? createPortal(<><style>{report.assets?.customCss?.css ?? ''}</style>
      <article className="coa-pdf-document coa-printable non_nabl_mode" aria-label={report.report.reportNumber}>
        <ReportContent report={report} className="finalised-report-preview__body" />
      </article></>, target) : null}
  </>;
}
