import pg from 'pg';
import { transaction } from '../db/pool.js';
import { loadReport } from './service.js';

export function createReportWorkerPool(connectionString = process.env.WORKER_DATABASE_URL) {
  if (!connectionString || new URL(connectionString).username !== 'sampleify_report_worker') throw new Error('A dedicated report worker database connection is required.');
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 30_000, idleTimeoutMillis: 30_000 });
  pool.on('error', () => console.error('An idle report worker database connection failed.'));
  return pool;
}

export async function verifyReportWorkerRole(pool) {
  const role = (await pool.query(`SELECT session_user AS name, role.rolsuper, role.rolbypassrls, role.rolcreatedb, role.rolcreaterole,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role.oid) AS has_memberships FROM pg_roles role WHERE role.rolname=session_user`)).rows[0];
  if (!role || role.name !== 'sampleify_report_worker' || role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole || role.has_memberships) throw new Error('The report worker role has unexpected privileges.');
}

export function reportPdfFailure(error) {
  if (['42501', 'forbidden', 'workflow_action_denied'].includes(error.code)) return { code: 'report_print_permission_revoked', message: 'Report printing is no longer permitted for the requester.', retry: false };
  if (['report_external_resource', 'report_css_not_captured', 'custom_css_complexity_limit', 'custom_css_image_limit', 'custom_css_size_limit', 'report_pdf_size_limit', 'report_pdf_timeout', 'report_asset_size_limit'].includes(error.code)) return { code: error.code, message: error.message, retry: error.code === 'report_pdf_timeout' };
  if (['report_not_found', 'report_history_unavailable', 'report_asset_history_unavailable', 'report_image_unavailable', 'invalid_report_image', 'empty_report_image', 'report_image_size_limit', 'report_image_type', 'report_image_dimensions', 'animated_report_image', 'unsafe_report_html', 'unsafe_report_svg', 'report_svg_limit', 'template_not_found', 'capture_not_found', 'template_batch_limit', 'capture_batch_limit', 'report_size_limit'].includes(error.code)) {
    return { code: 'report_pdf_history_unavailable', message: 'The frozen report could not be loaded for printing.', retry: false };
  }
  return { code: 'report_pdf_failed', message: 'The report could not be rendered. Please try again later.', retry: true };
}

export async function processNextReportJob({ pool, renderer, workerId }) {
  const job = await transaction(async (client) => (await client.query('SELECT * FROM report_pdf_claim($1,$2)', [renderer.rendererId, workerId])).rows[0], { pool });
  if (!job) return null;
  const lease = [job.organization_id, job.job_id, job.lease_token];
  try {
    const report = await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const identity = (await client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', lease)).rows[0];
      return loadReport(client, identity, job.report_id);
    }, { pool });
    const html = renderer.renderReportDocument(report, renderer.stylesheet);
    const bytes = await renderer.renderReportPdf({ html, printConfig: report.printConfig, stylesheet: `${renderer.stylesheet}\n${report.assets?.customCss?.css ?? ''}` });
    await transaction((client) => client.query('SELECT report_pdf_complete($1,$2,$3,$4)', [...lease, bytes]), { pool });
    return { jobId: job.job_id, status: 'succeeded' };
  } catch (error) {
    if (error.code === '40001') return { jobId: job.job_id, status: 'lease_lost' };
    const failure = reportPdfFailure(error);
    try {
      await transaction((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,$6)', [...lease, failure.code, failure.message, failure.retry]), { pool });
    } catch (writeError) {
      if (writeError.code === '40001') return { jobId: job.job_id, status: 'lease_lost' };
      throw writeError;
    }
    return { jobId: job.job_id, status: failure.retry && job.attempt_number < 5 ? 'retrying' : 'failed', errorCode: failure.code };
  }
}
