import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfOptions } from '../../src/reports/pdf.js';
import { reportPdfFailure } from '../../src/reports/worker.js';

test('PDF margins retain source CSS-pixel units, measured headers, custom margins and explicit zero/false choices', () => {
  const chrome = { header: { html: '<div>Header</div>', height: 20 }, footer: { html: '<div>Footer</div>', height: 10 } };
  const options = pdfOptions({ pageSize: 'A5', xMargin: 0, scale: '0.75', isLandscape: true, useCustomTopMargin: true, topMargin: 5, printFooter: false }, chrome, 'body{color:black}');
  assert.deepEqual(options.margin, { top: '25px', right: '0px', bottom: '0px', left: '0px' });
  assert.equal(options.format, 'A5'); assert.equal(options.landscape, true); assert.equal(options.scale, 0.75);
  assert.equal(options.displayHeaderFooter, true); assert.equal(options.footerTemplate, '<div></div>');
  assert.match(options.headerTemplate, /Header/); assert.match(options.headerTemplate, /padding-left:0px/);
  const hidden = pdfOptions({ printHeader: false, printFooter: false, topMargin: 50, bottomMargin: 50 }, chrome);
  assert.deepEqual(hidden.margin, { top: '0px', right: '1px', bottom: '0px', left: '1px' });
  assert.equal(hidden.displayHeaderFooter, undefined);
  assert.throws(() => pdfOptions({ scale: 0 }), { code: 'invalid_print_setting' });
});

test('worker failures classify retryable rendering errors without exposing database or browser diagnostics', () => {
  assert.equal(reportPdfFailure({ code: 'report_pdf_timeout', message: 'Render timeout.' }).retry, true);
  assert.equal(reportPdfFailure({ code: 'report_external_resource', message: 'Uncaptured resource.' }).retry, false);
  assert.equal(reportPdfFailure({ code: '42501', message: 'Private database details.' }).code, 'report_print_permission_revoked');
  assert.equal(reportPdfFailure({ code: 'report_history_unavailable' }).retry, false);
  assert.deepEqual(reportPdfFailure(new Error('Private browser arguments and connection strings.')), {
    code: 'report_pdf_failed', message: 'The report could not be rendered. Please try again later.', retry: true,
  });
});
