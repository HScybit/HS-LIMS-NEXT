import { HttpError } from '../auth/errors.js';
import { dateOnly, fieldsOnly, integer, text } from '../templates/input.js';
import { requireInstrumentRead } from './core.js';
import { instrumentCustomFields } from '../masters/custom-fields.js';
import { masterCustomFieldMatch, loadMasterListingValues } from '../masters/master-custom-field-listing.js';
import { customFieldColumnKey } from '../custom-fields/listing-values.js';
import { instrumentCalendarDay } from './calendar.js';

const literalSearch = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function searchText(value) {
  const result = text(value, 'Search', 500, { optional: true }).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_input', 'Search must contain valid text.');
  return result;
}

// Match the source's canonical calibration/maintenance summaries. Equal severity
// retains the saved configuration order. Service execution will supply completed
// log observations through its own native tables; a master never invents a log.
const summary = `WITH configuration AS (
  SELECT service.instrument_id,service.position,service.last_performed_on,service.service_code AS key,
    coalesce(service.next_reminder_on,service.last_performed_on+service.frequency_days) AS due_on,service.reminder_before_days
  FROM instrument_version_services service JOIN instruments head ON head.organization_id=service.organization_id
    AND head.id=service.instrument_id AND head.revision=service.revision
  WHERE head.organization_id=$1 AND NOT head.retired
), rated AS (
  SELECT *,CASE WHEN key='calibration' THEN 'calibration' ELSE 'maintenance' END AS canonical,
    CASE WHEN due_on IS NULL THEN 0 WHEN $2::date>due_on THEN 3 WHEN $2::date>=due_on-reminder_before_days THEN 2 ELSE 1 END AS severity
  FROM configuration WHERE key IN ('calibration','preventive_maintenance')
), ranked AS (
  SELECT *,row_number() OVER(PARTITION BY instrument_id,canonical ORDER BY severity DESC,position) AS priority FROM rated
), instrument_rows AS (
  SELECT instrument.organization_id,instrument.id,instrument.revision,instrument.created_at,instrument.name,instrument.code AS uid,
    instrument.serial_number AS "serialNo",instrument.make,instrument.model_name AS "modelNo",coalesce(laboratory.name,'') AS lab,
    CASE WHEN instrument.current_status='in_breakdown' THEN 'Breakdown' ELSE 'Working' END AS status,
    coalesce(calibration.severity,0) AS calibration_severity,coalesce(maintenance.severity,0) AS maintenance_severity,
    CASE coalesce(calibration.severity,0) WHEN 0 THEN '' WHEN 3 THEN 'No' ELSE 'Yes' END AS calibrated,
    to_char(greatest(calibration.last_performed_on,maintenance.last_performed_on),'DD/MM/YYYY') AS "lastServiceOn",
    to_char(least(calibration.due_on,maintenance.due_on),'DD/MM/YYYY') AS "nextServiceOn"
  FROM instruments instrument LEFT JOIN instrument_laboratory_catalog laboratory
    ON laboratory.organization_id=instrument.organization_id AND laboratory.id=instrument.laboratory_id
  LEFT JOIN ranked calibration ON calibration.instrument_id=instrument.id AND calibration.canonical='calibration' AND calibration.priority=1
  LEFT JOIN ranked maintenance ON maintenance.instrument_id=instrument.id AND maintenance.canonical='maintenance' AND maintenance.priority=1
  WHERE instrument.organization_id=$1 AND NOT instrument.retired
)`;
const columns = ['name', 'status', 'lab', 'uid', 'serialNo', 'make', 'modelNo', 'lastServiceOn', 'calibrated', 'nextServiceOn'];
const listingField = ({ id, key, label, fieldType, displayOrder, showInList, showInFilter, options, dateFormat, datetimeFormat }) =>
  ({ id, key, label, fieldType, displayOrder, showInList, showInFilter, options, dateFormat, datetimeFormat });

export async function listInstruments(client, identity, input = {}) {
  await requireInstrumentRead(client, identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'asOfDate']);
  const requestedPage = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search); const fields = await instrumentCustomFields(client, identity, { forListing: true });
  const filterFields = new Map(fields.filter(field => field.showInFilter).map(field => [customFieldColumnKey(field), field]));
  const args = [identity.organization_id, dateOnly(input.asOfDate ?? instrumentCalendarDay())]; const conditions = [];
  const bind = value => { args.push(value); return '$' + args.length; };
  if (search) {
    const pattern = bind(literalSearch(search));
    conditions.push(`(${columns.map(column => `instrument."${column}" ILIKE ${pattern}`).join(' OR ')}
      ${fields.length ? `OR ${masterCustomFieldMatch('instrument', bind, fields.map(field => field.id), search)}` : ''})`);
  }
  const filters = input.filters ?? {}; fieldsOnly(filters, ['status', 'lab', 'calibrated', 'make', ...filterFields.keys()]);
  for (const [key, raw] of Object.entries(filters)) {
    const value = searchText(raw); if (!value) continue;
    if (key === 'status' && !['Working', 'Breakdown'].includes(value) || key === 'calibrated' && !['Yes', 'No'].includes(value)) throw new HttpError(400, 'invalid_instrument_filter', 'Select a supported Instrument filter.');
    if (filterFields.has(key)) conditions.push(masterCustomFieldMatch('instrument', bind, [filterFields.get(key).id], value));
    else conditions.push(`instrument."${key}"=${bind(value)}`);
  }
  const from = `FROM instrument_rows instrument ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}`;
  const totalCount = (await client.query(`${summary} SELECT count(*)::integer AS count ${from}`, args)).rows[0].count;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(totalCount / pageSize)));
  const rows = (await client.query(`${summary} SELECT instrument.id AS _id,instrument.revision,${columns.map(column => `instrument."${column}"`).join(',')}
    ${from} ORDER BY instrument.created_at DESC,instrument.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows: await loadMasterListingValues('instrument', client, identity, rows, fields), totalCount, page, pageSize, fields: fields.map(listingField) };
}

export async function instrumentOverview(client, identity, input = {}) {
  await requireInstrumentRead(client, identity); fieldsOnly(input, ['asOfDate']);
  const health = (await client.query(`${summary} SELECT count(*)::integer AS total,
    count(*) FILTER(WHERE status='Working' AND calibration_severity<>3 AND maintenance_severity<>3)::integer AS healthy,
    count(*) FILTER(WHERE status='Breakdown')::integer AS "inBreakdown",
    count(*) FILTER(WHERE maintenance_severity=3)::integer AS "maintenanceOverdue",
    count(*) FILTER(WHERE status='Working' AND calibration_severity=3)::integer AS "notCalibrated",
    count(*) FILTER(WHERE status='Working' AND calibration_severity=0)::integer AS "noCalibrationData",
    count(*) FILTER(WHERE status='Working' AND calibration_severity IN(1,2))::integer AS calibrated
    FROM instrument_rows`, [identity.organization_id, dateOnly(input.asOfDate ?? instrumentCalendarDay())])).rows[0];
  return { health };
}

export async function instrumentFilterOptions(client, identity, input) {
  await requireInstrumentRead(client, identity); fieldsOnly(input, ['kind', 'search']);
  if (!['lab', 'make'].includes(input.kind)) throw new HttpError(400, 'invalid_instrument_filter', 'Select a supported Instrument filter.');
  const rows = (await client.query(`${summary} SELECT DISTINCT "${input.kind}" AS value FROM instrument_rows
    WHERE coalesce("${input.kind}",'')<>'' AND "${input.kind}" ILIKE $3 ORDER BY "${input.kind}" LIMIT 101`,
  [identity.organization_id, instrumentCalendarDay(), literalSearch(searchText(input.search))])).rows;
  return { rows: rows.slice(0, 100).map(row => ({ value: row.value, label: row.value })), hasMore: rows.length > 100 };
}
