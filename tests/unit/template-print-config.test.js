import test from 'node:test';
import assert from 'node:assert/strict';
import { reportPrintConfig, templatePreviewPdfInput, templatePrintConfigInput } from '../../src/templates/print-config.js';
import { sanitizeTemplatePreviewHtml } from '../../src/templates/preview-pdf.js';

test('template print configuration preserves V4 defaults and chooses variant-specific margins', () => {
  const config = templatePrintConfigInput({
    pageSize: 'A5', scale: 0.75, xMargin: 12, isLandscape: true, printHeader: false,
    printFooter: true, headerAlignment: 'left', footerAlignment: 'right',
    nonNablTopMargin: 14, nonNablBottomMargin: 15, nablTopMargin: 24, nablBottomMargin: 25,
    useCustomTopNonNabl: true, useCustomBottomNonNabl: false, useCustomTopNabl: false, useCustomBottomNabl: true,
  });
  assert.deepEqual(reportPrintConfig(config, 'non_nabl'), {
    pageSize: 'A5', scale: '0.75', xMargin: '12', isLandscape: true, printHeader: false, printFooter: true,
    printWithoutSignature: false, printWithoutImage: false, useCustomTopMargin: true, topMargin: '14', useCustomBottomMargin: false, bottomMargin: '15',
  });
  assert.equal(reportPrintConfig(config, 'nabl').topMargin, '24');
  assert.equal(reportPrintConfig(config, 'nabl').useCustomBottomMargin, true);
  assert.throws(() => templatePrintConfigInput({ scale: 0 }), { code: 'invalid_print_setting' });
  assert.throws(() => templatePrintConfigInput({ headerAlignment: 'justify' }), { code: 'invalid_print_alignment' });
  assert.throws(() => templatePrintConfigInput({ extra: true }), { code: 'invalid_input' });
});

test('template PDF input is bounded and preview HTML removes executable containers and handlers', () => {
  const input = templatePreviewPdfInput({ html: '<main>Preview</main>', title: 'Example', variant: 'nabl', printConfig: {} });
  assert.equal(input.variant, 'nabl');
  assert.equal(input.printConfig.pageSize, 'A4');
  assert.throws(() => templatePreviewPdfInput({ html: '', title: 'Example', variant: 'nabl', printConfig: {} }), { code: 'invalid_preview_html' });
  assert.throws(() => templatePreviewPdfInput({ html: '<p>x</p>', title: 'Example', variant: 'other', printConfig: {} }), { code: 'invalid_preview_variant' });
  const sanitized = sanitizeTemplatePreviewHtml('<script>alert(1)</script><iframe src="https://example.test"></iframe><p onclick="run()"><a href="javascript:bad()">Safe text</a></p>');
  assert.doesNotMatch(sanitized, /script|iframe|onclick|javascript:/i);
  assert.match(sanitized, /Safe text/);
});
