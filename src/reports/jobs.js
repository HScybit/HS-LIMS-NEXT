import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { requireWorkflowAction } from '../workflows/access.js';
import { currentRendererId } from './renderer.js';

async function printableReport(client, identity, reportId) {
  reportId = uuid(reportId, 'Report').toLowerCase();
  if (!identity.permission_codes.some((permission) => ['samples.read', 'samples.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view sample reports.');
  const report = (await client.query('SELECT id, sample_id, report_number, revision FROM sample_reports WHERE organization_id=$1 AND id=$2', [identity.organization_id, reportId])).rows[0];
  if (!report) throw new HttpError(404, 'report_not_found', 'Report was not found.');
  await requireWorkflowAction(client, identity, { type: 'sample', id: report.sample_id }, 'printCoa');
  return report;
}

async function reportJob(client, identity, reportId) {
  const job = (await client.query(`SELECT id, report_id AS "reportId", renderer_id AS "rendererId", status, attempts, requested_at AS "requestedAt",
    started_at AS "startedAt", completed_at AS "completedAt", last_error_code AS "errorCode", last_error_message AS "errorMessage"
    FROM report_pdf_jobs WHERE organization_id=$1 AND report_id=$2`, [identity.organization_id, reportId])).rows[0];
  if (!job) return { job: null, history: [] };
  const history = (await client.query(`SELECT attempt_number AS "attemptNumber", status, started_at AS "startedAt", completed_at AS "completedAt", error_code AS "errorCode", error_message AS "errorMessage"
    FROM report_pdf_attempts WHERE organization_id=$1 AND job_id=$2 ORDER BY attempt_number`, [identity.organization_id, job.id])).rows;
  return { job, history };
}

export async function enqueueReportPdf(client, identity, reportId) {
  const report = await printableReport(client, identity, reportId);
  // A completed or in-flight artifact remains tied to its original renderer.
  const existing = await reportJob(client, identity, report.id);
  if (existing.job) return existing;
  await client.query('SELECT report_pdf_enqueue($1,$2)', [report.id, await currentRendererId()]);
  return reportJob(client, identity, report.id);
}

export async function reportPdfStatus(client, identity, reportId) {
  const report = await printableReport(client, identity, reportId);
  return reportJob(client, identity, report.id);
}

export async function reportPdfFile(client, identity, reportId) {
  const report = await printableReport(client, identity, reportId);
  const artifact = (await client.query(`SELECT content, content_type AS "contentType", byte_length AS "byteLength", encode(sha256,'hex') AS checksum
    FROM report_pdf_artifacts WHERE organization_id=$1 AND report_id=$2`, [identity.organization_id, report.id])).rows[0];
  if (!artifact) throw new HttpError(409, 'report_pdf_not_ready', 'The report PDF is not ready yet.');
  const name = report.report_number.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  return { ...artifact, filename: `${name}-v${report.revision}.pdf` };
}
