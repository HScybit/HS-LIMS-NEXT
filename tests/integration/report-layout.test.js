import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { renderReportPdf } from '../../src/reports/pdf.js';
import { pdfPageText } from '../helpers/pdf-page-text.js';

const stylesheet = `body{margin:0}.template-render-canvas{width:100%}
  [data-is-header]{font:20px/24px monospace}[data-is-header] span{display:inline-block;width:380px;height:24px;vertical-align:top}
  [data-is-footer]{font:12px/18px monospace}.result{height:360px;font:16px/24px monospace;border:1px solid black;box-sizing:border-box}`;
const html = `<!doctype html><html><head><style>${stylesheet}</style></head><body><article data-coa-report-body><div class="template-render-canvas">
  <div data-is-header="true"><span>Laboratory header</span><span>Long report identification</span></div>
  ${Array.from({ length: 6 }, (_, index) => `<div class="result">Synthetic result ${index + 1}</div>`).join('')}
  <div data-is-footer="true">Laboratory footer</div>
  </div></article></body></html>`;

test('paper width and orientation determine the actual wrapped header height used by a multipage PDF', async (context) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [pageSize, isLandscape, expectedWidth, expectedTop] of [['A5', false, 557, '48px'], ['A4', false, 792, '24px'], ['A5', true, 792, '24px']]) {
      let observed;
      const instrumented = { newContext: async (options) => {
        const context = await browser.newContext(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage(); const pdf = page.pdf.bind(page);
          page.pdf = async (settings) => {
            observed = { viewport: page.viewportSize(), settings, headersLeftInBody: await page.locator('[data-is-header="true"]').count() };
            return pdf(settings);
          };
          return page;
        };
        return context;
      } };
      const bytes = await renderReportPdf({ html, stylesheet, printConfig: { pageSize, isLandscape } }, { browser: instrumented });
      assert.equal(observed.settings.margin.top, expectedTop, 'Header height must reflect wrapping at the selected paper width.');
      assert.equal(observed.viewport.width, expectedWidth);
      assert.equal(observed.settings.margin.bottom, '18px');
      assert.equal(observed.headersLeftInBody, 0);
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      assert.ok((bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length >= 2);
      const file = path.resolve(`.local/m03-layout-${pageSize}-${isLandscape ? 'landscape' : 'portrait'}.pdf`);
      await writeFile(file, bytes);
      if (process.platform === 'darwin') {
        const labels = ['Laboratory header', 'Long report identification', 'Laboratory footer', ...Array.from({ length: 6 }, (_, index) => `Synthetic result ${index + 1}`)];
        const pages = await pdfPageText(file, labels);
        const results = [];
        for (const rows of pages) {
          const header = rows.filter((row) => labels.slice(0, 2).includes(row.label));
          const footers = rows.filter((row) => row.label === 'Laboratory footer');
          const body = rows.filter((row) => row.label.startsWith('Synthetic result'));
          assert.equal(header.length, 2); assert.equal(footers.length, 1);
          for (const row of body) {
            assert.ok(Math.min(...header.map((row) => row.bottom)) >= row.top, 'Printed header must not overlap result text.');
            assert.ok(footers[0].top <= row.bottom, 'Printed footer must not overlap result text.');
          }
          results.push(...body.map((row) => row.label));
        }
        assert.deepEqual(results.sort(), labels.slice(3).sort(), 'Every result must appear exactly once across the printed pages.');
      } else context.diagnostic('PDFKit text-bound verification is available on macOS; Chrome layout and PDF generation still ran.');
    }
  } finally { await browser.close(); }
});
