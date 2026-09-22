import { NextResponse } from 'next/server';
import { authenticated, endpoint, readInput } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { loadDatasheet } from '@/datasheets/service.js';
import { renderReportPdf } from '@/reports/pdf.js';
import { reportPrintConfig, templatePrintConfigInput } from '@/templates/print-config.js';
import { sanitizeTemplatePreviewHtml } from '@/templates/preview-pdf.js';
import { fieldsOnly } from '@/templates/input.js';

// Prints a test request's rendered datasheet the way the PERN detail page does:
// the browser posts the rendered document and the template's print settings
// decide the page. Access is the datasheet's own — anyone who may open the
// datasheet may print it.
export const POST = endpoint(async (request, context) => {
  const { datasheetId } = await context.params;
  const raw = await readInput(request, { maxBytes: 1_000_000 });
  fieldsOnly(raw, ['html', 'title', 'sampleId', 'printConfig']);
  if (typeof raw.html !== 'string' || !raw.html.trim() || raw.html.length > 950_000) throw new HttpError(400, 'invalid_preview_html', 'Print HTML is required and must not exceed 950,000 characters.');
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 250) throw new HttpError(400, 'invalid_preview_title', 'Print title is required and must not exceed 250 characters.');
  const result = await authenticated(request, async (client, identity) => {
    const runtime = await loadDatasheet(client, identity, datasheetId, { sampleId: raw.sampleId ?? null });
    const printConfig = raw.printConfig === undefined ? runtime.model.version.printConfig : templatePrintConfigInput(raw.printConfig);
    const bytes = await renderReportPdf({ html: sanitizeTemplatePreviewHtml(raw.html.trim()), printConfig: reportPrintConfig(printConfig, 'non_nabl'), stylesheet: '' });
    return { bytes, title: raw.title.trim() };
  }, { readOnly: true });
  const filename = `${result.title}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
  return new NextResponse(result.bytes, { status: 200, headers: {
    'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="${filename}"`,
    'Content-Length': String(result.bytes.length), 'Content-Type': 'application/pdf',
  } });
});
