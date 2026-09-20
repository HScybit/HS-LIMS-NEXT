import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';

const columns = `datasheet_id AS "datasheetId",report_id AS "reportId",sample_product_id AS "sampleProductId",
  product_id AS "productId",sample_category_id AS "sampleCategoryId",product_name AS "productName",category_name AS "categoryName",
  description,quantity,sample_size AS "sampleSize",quality,identification_mark AS "identificationMark",received_condition AS "receivedCondition"`;

// One typed row per actual consumer, shared by every widget and occurrence.
// Missing history is not filled from today's mutable sample line or masters.
export async function loadSampleLineContexts(client, organizationId, { datasheetId, reportIds } = {}) {
  const requested = datasheetId ? [datasheetId] : reportIds;
  if (!Array.isArray(requested) || !requested.length || requested.length > 1000 || datasheetId && reportIds) throw new HttpError(400, 'invalid_line_consumer', 'Select a datasheet or a batch of reports.');
  const ids = [...new Set(requested.map((id) => uuid(id, 'Line context owner').toLowerCase()))];
  const started = performance.now();
  const result = await client.query(`SELECT ${columns} FROM sample_line_contexts WHERE organization_id=$1 AND ${datasheetId ? 'datasheet_id' : 'report_id'}=ANY($2::uuid[])`, [organizationId, ids]);
  const byOwnerId = new Map(result.rows.map(({ datasheetId: sheetId, reportId, ...lineItem }) => [sheetId ?? reportId, lineItem]));
  if (ids.some((id) => !byOwnerId.has(id))) throw new HttpError(409, 'incomplete_sample_line_history', 'The recorded line-item context is unavailable.');
  return { byOwnerId, metrics: { queryCount: 1, rowCount: result.rowCount, databaseMs: performance.now() - started } };
}

// The projection grants only section submissions selected by these reports;
// the PDF role still cannot read base datasheet line contexts.
export async function loadReportFinalLineContexts(client, organizationId, reportIds) {
  if (!Array.isArray(reportIds) || !reportIds.length || reportIds.length > 1000) throw new HttpError(400, 'invalid_line_consumer', 'Select a batch of reports.');
  const ids = [...new Set(reportIds.map((id) => uuid(id, 'Report').toLowerCase()))];
  const started = performance.now();
  const result = await client.query(`SELECT instance_id AS "instanceId",${columns} FROM report_final_line_contexts($2::uuid[]) WHERE organization_id=$1`, [organizationId, ids]);
  const byReportId = new Map();
  for (const { reportId, instanceId, datasheetId: _datasheetId, ...lineItem } of result.rows) {
    if (!byReportId.has(reportId)) byReportId.set(reportId, {});
    byReportId.get(reportId)[instanceId] = lineItem;
  }
  return { byReportId, metrics: { queryCount: 1, rowCount: result.rowCount, databaseMs: performance.now() - started } };
}
