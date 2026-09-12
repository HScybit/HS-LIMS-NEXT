import { HttpError } from '../auth/errors.js';
import { reportContentHtml } from '../report-assets/markup.js';
import { uuid } from '../templates/input.js';
import { validateReportImage } from '../report-assets/images.js';
import { capturedCustomCss } from '../report-assets/css-resources.js';
import { templateImageSources } from '../template-assets/service.js';

// One batched asset read in addition to the eight core definition reads and
// three capture reads. Images shared by multiple slots are fetched once.
export async function loadReportAssets(client, organizationId, reportId, imageCounts = {}) {
  const result = await loadReportAssetBatch(client, organizationId, [reportId], { [reportId.toLowerCase()]: imageCounts });
  return { assets: result.assets.get(reportId.toLowerCase()), metrics: result.metrics };
}

export async function loadReportAssetBatch(client, organizationId, reportIds, templateImages = {}) {
  if (!reportIds.length || reportIds.length > 1000) throw new HttpError(422, 'report_asset_size_limit', 'Select at most 1,000 reports in one generation.');
  reportIds = reportIds.map((id) => uuid(id, 'Report').toLowerCase());
  const references = reportIds.flatMap((reportId) => Object.entries(templateImages[reportId] ?? {}).map(([imageId, count]) => ({ reportId, imageId: uuid(imageId, 'Template image'), count })));
  const started = performance.now();
  const rows = (await client.query(`WITH selected AS (
    SELECT 'document' AS kind,captured.report_id,slot.name AS slot,version.id,version.template_html AS content_text,
      ARRAY(SELECT image.image_id FROM report_document_images image WHERE image.organization_id=version.organization_id AND image.version_id=version.id ORDER BY image.image_id) AS image_ids
    FROM sample_report_assets captured CROSS JOIN LATERAL (VALUES ('header',captured.header_version_id),('footer',captured.footer_version_id),
      ('nablHeader',captured.nabl_header_version_id),('nablFooter',captured.nabl_footer_version_id)) slot(name,version_id)
    LEFT JOIN report_document_versions version ON version.organization_id=captured.organization_id AND version.id=slot.version_id
    WHERE captured.organization_id=$1 AND captured.report_id=ANY($2::uuid[]) AND slot.version_id IS NOT NULL
    UNION ALL SELECT 'stylesheet',captured.report_id,'customCss',version.id,version.css_content,
      ARRAY(SELECT image.image_id FROM organization_custom_css_images image WHERE image.organization_id=version.organization_id AND image.version_id=version.id ORDER BY image.image_id)
    FROM sample_report_assets captured LEFT JOIN organization_custom_css_versions version ON version.organization_id=captured.organization_id AND version.id=captured.css_version_id
    WHERE captured.organization_id=$1 AND captured.report_id=ANY($2::uuid[]) AND captured.css_version_id IS NOT NULL
  ), images AS (SELECT 'image' AS kind,image.id,image.media_type,image.content,image.byte_length,NULL::bytea AS print_content,NULL::text AS sha256,NULL::text AS print_sha256
    FROM report_image_assets image WHERE image.organization_id=$1 AND image.id IN (SELECT unnest(image_ids) FROM selected)
    UNION ALL SELECT 'templateImage',image.id,image.media_type,image.content,image.byte_length+image.print_byte_length,image.print_content,image.sha256,image.print_sha256
    FROM template_image_assets image WHERE image.organization_id=$1 AND image.id=ANY($3::uuid[])), size AS (SELECT coalesce(sum(byte_length),0) AS bytes FROM images)
  SELECT kind,report_id,slot,id,content_text,image_ids,NULL::text AS media_type,NULL::bytea AS content,(SELECT bytes FROM size) AS image_bytes,
    NULL::bytea AS print_content,NULL::text AS sha256,NULL::text AS print_sha256 FROM selected
  UNION ALL SELECT kind,NULL,NULL,id,NULL,NULL,media_type,CASE WHEN (SELECT bytes FROM size)<=25165824 THEN content ELSE NULL END,(SELECT bytes FROM size),
    CASE WHEN (SELECT bytes FROM size)<=25165824 THEN print_content ELSE NULL END,sha256,print_sha256 FROM images`,
  [organizationId, reportIds, [...new Set(references.map((reference) => reference.imageId))]])).rows;
  const databaseMs = performance.now() - started;
  if (rows.some((row) => Number(row.image_bytes) > 24 * 1024 * 1024)) throw new HttpError(422, 'report_asset_size_limit', 'The selected report images exceed 24 MiB.');
  const sources = new Map(); const validationStarted = performance.now();
  for (const row of rows.filter((item) => item.kind === 'image')) {
    // CSS backgrounds are not document.images and would otherwise evade the
    // browser's image.decode check. Decode each distinct captured file once.
    await validateReportImage(row.content, row.media_type);
    sources.set(row.id, `data:${row.media_type};base64,${row.content.toString('base64')}`);
  }
  const templateSources = new Map();
  for (const row of rows.filter((item) => item.kind === 'templateImage')) {
    const source = templateImageSources(row);
    await validateReportImage(row.print_content, 'image/png');
    templateSources.set(row.id, source);
  }
  const imageValidationMs = performance.now() - validationStarted;
  const assets = new Map(reportIds.map((id) => [id, {}])); let renderedBytes = 0;
  for (const row of rows.filter((item) => ['document', 'stylesheet'].includes(item.kind))) {
    if (!row.id) throw new HttpError(409, 'report_asset_history_unavailable', 'The captured report content is unavailable.');
    const parsed = row.kind === 'stylesheet' ? capturedCustomCss(row.content_text, sources) : reportContentHtml(row.content_text, { imageSources: sources });
    if (parsed.imageIds.slice().sort().join(',') !== row.image_ids.slice().sort().join(',')) {
      throw new HttpError(409, 'report_asset_history_unavailable', 'The report image references do not match the captured content.');
    }
    renderedBytes += Buffer.byteLength(parsed.html ?? parsed.css);
    if (renderedBytes > 32 * 1024 * 1024) throw new HttpError(422, 'report_asset_size_limit', 'The expanded report assets exceed 32 MiB.');
    assets.get(row.report_id)[row.slot] = { versionId: row.id, ...(row.kind === 'stylesheet' ? { css: parsed.css } : { html: parsed.html }) };
  }
  for (const { reportId, imageId, count } of references) {
    const source = templateSources.get(imageId);
    if (!source) throw new HttpError(409, 'template_image_history_unavailable', 'A captured template image is unavailable.');
    renderedBytes += (source.src.length + source.printSrc.length) * count;
    if (renderedBytes > 32 * 1024 * 1024) throw new HttpError(422, 'report_asset_size_limit', 'The expanded report assets exceed 32 MiB.');
    (assets.get(reportId).templateImages ??= {})[imageId] = source;
  }
  return { assets, metrics: { queryCount: 1, databaseMs, imageValidationMs, rows: rows.length, renderedBytes,
    documents: rows.filter((row) => row.kind === 'document').length, stylesheets: rows.filter((row) => row.kind === 'stylesheet').length, images: sources.size + templateSources.size } };
}
