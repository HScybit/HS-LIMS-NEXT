import { HttpError } from '../auth/errors.js';
import { reportContentHtml } from '../report-assets/markup.js';
import { uuid } from '../templates/input.js';

// One batched asset read in addition to the eight core definition reads and
// three capture reads. Images shared by multiple slots are fetched once.
export async function loadReportAssets(client, organizationId, reportId) {
  const result = await loadReportAssetBatch(client, organizationId, [reportId]);
  return { assets: result.assets.get(reportId.toLowerCase()), metrics: result.metrics };
}

export async function loadReportAssetBatch(client, organizationId, reportIds) {
  if (!reportIds.length || reportIds.length > 1000) throw new HttpError(422, 'report_asset_size_limit', 'Select at most 1,000 reports in one generation.');
  reportIds = reportIds.map((id) => uuid(id, 'Report').toLowerCase());
  const started = performance.now();
  const rows = (await client.query(`WITH selected AS (
    SELECT captured.report_id,slot.name AS slot,version.id,version.template_html,
      ARRAY(SELECT image.image_id FROM report_document_images image WHERE image.organization_id=version.organization_id AND image.version_id=version.id ORDER BY image.image_id) AS image_ids
    FROM sample_report_assets captured CROSS JOIN LATERAL (VALUES ('header',captured.header_version_id),('footer',captured.footer_version_id),
      ('nablHeader',captured.nabl_header_version_id),('nablFooter',captured.nabl_footer_version_id)) slot(name,version_id)
    LEFT JOIN report_document_versions version ON version.organization_id=captured.organization_id AND version.id=slot.version_id
    WHERE captured.organization_id=$1 AND captured.report_id=ANY($2::uuid[]) AND slot.version_id IS NOT NULL
  ), images AS (SELECT image.* FROM report_image_assets image WHERE image.organization_id=$1
    AND image.id IN (SELECT unnest(image_ids) FROM selected)), size AS (SELECT coalesce(sum(byte_length),0) AS bytes FROM images)
  SELECT 'document' AS kind,report_id,slot,id,template_html,image_ids,NULL::text AS media_type,NULL::bytea AS content,(SELECT bytes FROM size) AS image_bytes FROM selected
  UNION ALL SELECT 'image',NULL,NULL,id,NULL,NULL,media_type,CASE WHEN (SELECT bytes FROM size)<=25165824 THEN content ELSE NULL END,(SELECT bytes FROM size) FROM images`,
  [organizationId, reportIds])).rows;
  const databaseMs = performance.now() - started;
  if (rows.some((row) => Number(row.image_bytes) > 24 * 1024 * 1024)) throw new HttpError(422, 'report_asset_size_limit', 'The selected report images exceed 24 MiB.');
  const sources = new Map(rows.filter((row) => row.kind === 'image').map((row) => [row.id, `data:${row.media_type};base64,${row.content.toString('base64')}`]));
  const assets = new Map(reportIds.map((id) => [id, {}])); let renderedBytes = 0;
  for (const row of rows.filter((item) => item.kind === 'document')) {
    if (!row.id) throw new HttpError(409, 'report_asset_history_unavailable', 'The captured report content is unavailable.');
    const parsed = reportContentHtml(row.template_html, { imageSources: sources });
    if (parsed.imageIds.slice().sort().join(',') !== row.image_ids.slice().sort().join(',')) {
      throw new HttpError(409, 'report_asset_history_unavailable', 'The report image references do not match the captured content.');
    }
    renderedBytes += Buffer.byteLength(parsed.html);
    if (renderedBytes > 32 * 1024 * 1024) throw new HttpError(422, 'report_asset_size_limit', 'The expanded report assets exceed 32 MiB.');
    assets.get(row.report_id)[row.slot] = { versionId: row.id, html: parsed.html };
  }
  return { assets, metrics: { queryCount: 1, databaseMs, rows: rows.length, renderedBytes } };
}
