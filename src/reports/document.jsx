import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReportContent from '../components/reports/ReportContent.jsx';
import { assertReportSize } from './render-model.js';

// The worker renders the same frozen model and DOM as the browser preview.
// This HTML exists only in memory; the PDF is the retained output artifact.
export function renderReportDocument(input, stylesheet) {
  const data = JSON.parse(JSON.stringify(input));
  assertReportSize(data.model, data.results, data.finalCaptures, data.datasheetModels);
  // This standalone worker document is rendered outside Next's page runtime.
  // eslint-disable-next-line @next/next/no-head-element
  return '<!doctype html>' + renderToStaticMarkup(<html lang="en"><head><meta charSet="utf-8" /><title>{data.report.reportNumber}</title><style>{stylesheet}</style>
    <style>{data.assets?.customCss?.css ?? ''}</style></head>
    <body><article className="coa-pdf-document coa-printable non_nabl_mode" aria-label={data.report.reportNumber}>
      <ReportContent report={data} />
    </article></body></html>);
}
