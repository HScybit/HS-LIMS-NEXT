import { NextResponse } from 'next/server';
import { authenticated, endpoint, readInput } from '@/auth/http.js';
import { renderReportPdf } from '@/reports/pdf.js';
import { templates } from '@/db/template-schema.js';
import { database } from '@/db/pool.js';
import { and, eq } from 'drizzle-orm';
import { HttpError } from '@/auth/errors.js';
import { reportPrintConfig, templatePreviewPdfInput } from '@/templates/print-config.js';
import { sanitizeTemplatePreviewHtml } from '@/templates/preview-pdf.js';
import { uuid } from '@/templates/input.js';

export const POST = endpoint(async (request, context) => {
  const { templateId } = await context.params;
  uuid(templateId, 'Template');
  const raw = await readInput(request, { maxBytes: 1_000_000 });
  const result = await authenticated(request, async (client, identity) => {
    const input = templatePreviewPdfInput(raw);
    const rows = await database(client).select({ code: templates.code }).from(templates)
      .where(and(eq(templates.organizationId, identity.organization_id), eq(templates.id, templateId))).limit(1);
    if (!rows.length) throw new HttpError(404, 'template_not_found', 'Template was not found.');
    const bytes = await renderReportPdf({
      html: sanitizeTemplatePreviewHtml(input.html),
      printConfig: reportPrintConfig(input.printConfig, input.variant),
      stylesheet: '', isNabl: input.variant === 'nabl',
    });
    return { bytes, code: rows[0].code };
  }, { permission: 'templates.read' });
  const filename = `${result.code || 'template'}-preview.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
  return new NextResponse(result.bytes, { status: 200, headers: {
    'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="${filename}"`,
    'Content-Length': String(result.bytes.length), 'Content-Type': 'application/pdf',
  } });
});
