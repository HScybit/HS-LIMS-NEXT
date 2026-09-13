import { HttpError } from '../auth/errors.js';
import { parameterTitleProjection, resolveParameterTitle, stringifyTitleValue } from '../templates/parameter-title.js';
import { parameterTitleRequests } from '../templates/parameter-title-requests.js';

const limits = Object.freeze({ parameters: 1000, selectors: 20_000, fields: 50_000, values: 500_000, bytes: 16 * 1024 * 1024 });
const incomplete = () => new HttpError(409, 'incomplete_parameter_title_history', 'The captured Parameter title history is incomplete.');
const tooLarge = () => new HttpError(422, 'parameter_title_size_limit', 'The requested Parameter titles exceed the supported document size.');
const versionKey = (row) => `${row.parameterId}:${row.parameterRevision}`;
const selection = `WITH requested AS MATERIALIZED (
  SELECT * FROM unnest($2::uuid[],$3::integer[],$4::text[]) AS requested(parameter_id,parameter_revision,field_key)
)`;
const selected = `organization_id=$1 AND EXISTS (SELECT 1 FROM requested
  WHERE requested.parameter_id=source.parameter_id AND requested.parameter_revision=source.parameter_revision
    AND (requested.field_key IS NULL OR requested.field_key=source.field_key))`;

function primitive(row, prefix) {
  const kind = row[`${prefix}Kind`]; const suffix = { text: 'Text', number: 'Number', boolean: 'Boolean' }[kind];
  const value = suffix && row[`${prefix}${suffix}`];
  if (kind === 'text' && typeof value === 'string' || kind === 'number' && typeof value === 'number' && Number.isFinite(value)
    || kind === 'boolean' && typeof value === 'boolean') return value;
  throw incomplete();
}

export function assembleParameterTitleFields(versions, fields, values) {
  const maps = new Map([...versions.keys()].map((key) => [key, Object.create(null)])); const byField = new Map();
  for (const row of fields) {
    const version = versionKey(row); const map = maps.get(version); const key = `${version}:${row.fieldId}`;
    if (!map || byField.has(key) || Object.hasOwn(map, row.key) || !Number.isInteger(row.valueCount)
      || row.valueCount < 0 || row.valueCount > 500 || !row.isArray && row.valueCount !== 1) throw incomplete();
    const field = { key: row.key, name: row.label, value: row.isArray ? [] : undefined, display_value: primitive(row, 'display'), type: row.fieldType };
    if (row.scheme) field.scheme = row.scheme;
    field.padded_number = row.paddedNumber;
    if (row.splitter) field.splitter = row.splitter;
    if (row.dateFormat) field.date_format = row.dateFormat;
    if (row.datetimeFormat) field.datetime_format = row.datetimeFormat;
    if (row.fieldType === 'multi_user_select') field.is_multi_user_select = true;
    map[row.key] = field;
    byField.set(key, { field, isArray: row.isArray, count: 0, expected: row.valueCount });
  }
  for (const row of values) {
    const selected = byField.get(`${versionKey(row)}:${row.fieldId}`);
    if (!selected || row.position !== selected.count || selected.count >= selected.expected) throw incomplete();
    const value = primitive(row, 'raw');
    if (selected.isArray) selected.field.value.push(value); else selected.field.value = value;
    selected.count += 1;
  }
  for (const { count, expected } of byField.values()) if (count !== expected) throw incomplete();
  return maps;
}

// Metadata is already captured in one datasheet/report query. Three additional
// statements serve all selected revisions, with counts/bytes checked first.
export async function loadParameterTitleFields(client, identity, rows, requests) {
  const metrics = { queryCount: 0, databaseMs: 0, assemblyMs: 0, bytes: 0, renderedTextBytes: 0 };
  const query = async (statement, parameters) => {
    const started = performance.now(); metrics.queryCount += 1;
    try { return (await client.query(statement, parameters)).rows; } finally { metrics.databaseMs += performance.now() - started; }
  };
  const versions = new Map(); const byRequest = new Map();
  for (const row of rows) {
    const request = requests.get(row.testRequestId);
    if (!request || !row.parameterHistoryAvailable) continue;
    if (!Number.isInteger(row.parameterCustomFieldCount) || row.parameterCustomFieldCount < 0 || row.parameterCustomFieldCount > 500) throw incomplete();
    const key = versionKey(row);
    if (!versions.has(key)) versions.set(key, { ...row, all: false, keys: new Set() });
    const version = versions.get(key);
    if (version.parameterCustomFieldCount !== row.parameterCustomFieldCount) throw incomplete();
    version.all ||= request.all;
    for (const key of request.keys) if (key.length <= 150 && /^[a-z0-9_]+$/.test(key)) version.keys.add(key);
    byRequest.set(row.testRequestId, key);
  }
  if (versions.size > limits.parameters) throw tooLarge();
  const selectedVersions = [...versions.values()].flatMap((row) => row.parameterCustomFieldCount
    ? (row.all ? [null] : [...row.keys]).map((key) => ({ ...row, key })) : []);
  if (selectedVersions.length > limits.selectors) throw tooLarge();
  let fields = []; let values = [];
  if (selectedVersions.length) {
    const parameters = [identity.organization_id, selectedVersions.map((row) => row.parameterId), selectedVersions.map((row) => row.parameterRevision), selectedVersions.map((row) => row.key)];
    const budgets = await query(`${selection}, field_budget AS (
      SELECT parameter_id,parameter_revision,count(*) AS fields,
        coalesce(sum(octet_length(field_key)+octet_length(label)+octet_length(scheme)+octet_length(splitter)
          +octet_length(date_format)+octet_length(datetime_format)+coalesce(octet_length(display_text),0)),0) AS bytes
      FROM laboratory_parameter_field_context source WHERE ${selected} GROUP BY parameter_id,parameter_revision
    ), value_budget AS (
      SELECT parameter_id,parameter_revision,count(*) AS values,coalesce(sum(coalesce(octet_length(raw_text),0)),0) AS bytes
      FROM laboratory_parameter_value_context source WHERE ${selected} GROUP BY parameter_id,parameter_revision
    ) SELECT field_budget.parameter_id AS "parameterId",field_budget.parameter_revision AS "parameterRevision",field_budget.fields,
      coalesce(value_budget.values,0) AS values,field_budget.bytes+coalesce(value_budget.bytes,0) AS bytes
    FROM field_budget LEFT JOIN value_budget USING(parameter_id,parameter_revision)`, parameters);
    let fieldCount = 0; let valueCount = 0; let bytes = 0;
    const counts = new Map();
    for (const row of budgets) {
      const next = [Number(row.fields), Number(row.values), Number(row.bytes)];
      if (!next.every((value) => Number.isSafeInteger(value) && value >= 0)) throw tooLarge();
      fieldCount += next[0]; valueCount += next[1]; bytes += next[2]; counts.set(versionKey(row), next[0]);
    }
    if (fieldCount > limits.fields || valueCount > limits.values || bytes > limits.bytes) throw tooLarge();
    for (const [key, row] of versions) if (row.all && (counts.get(key) ?? 0) !== row.parameterCustomFieldCount) throw incomplete();
    if (fieldCount) fields = await query(`${selection}
      SELECT parameter_id AS "parameterId",parameter_revision AS "parameterRevision",field_id AS "fieldId",field_revision AS "fieldRevision",
        field_key AS key,label,field_type AS "fieldType",is_array AS "isArray",value_count AS "valueCount",
        display_kind AS "displayKind",display_text AS "displayText",display_number AS "displayNumber",display_boolean AS "displayBoolean",
        scheme,padded_number AS "paddedNumber",splitter,date_format AS "dateFormat",datetime_format AS "datetimeFormat"
      FROM laboratory_parameter_field_context source WHERE ${selected} ORDER BY parameter_id,parameter_revision,position LIMIT 50001`, parameters);
    if (fields.length !== fieldCount) throw incomplete();
    if (valueCount) values = await query(`${selection}
      SELECT parameter_id AS "parameterId",parameter_revision AS "parameterRevision",field_id AS "fieldId",position,
        raw_kind AS "rawKind",raw_text AS "rawText",raw_number AS "rawNumber",raw_boolean AS "rawBoolean"
      FROM laboratory_parameter_value_context source WHERE ${selected} ORDER BY parameter_id,parameter_revision,field_id,position LIMIT 500001`, parameters);
    if (values.length !== valueCount) throw incomplete();
  }
  const started = performance.now(); const maps = assembleParameterTitleFields(versions, fields, values);
  const fieldsByRequestId = new Map(); const sizes = new Map(); const renderedSizes = new Map();
  for (const [requestId, key] of byRequest) {
    const map = maps.get(key); fieldsByRequestId.set(requestId, map);
    if (!sizes.has(key)) sizes.set(key, Buffer.byteLength(JSON.stringify(map)));
    metrics.bytes += sizes.get(key);
    // Bound repeated title text independently of the shared in-memory maps.
    for (const [title, count] of requests.get(requestId).titles) {
      const titleKey = `${key}:${title}`;
      if (!renderedSizes.has(titleKey)) renderedSizes.set(titleKey, Buffer.byteLength(stringifyTitleValue(resolveParameterTitle(title, { project_field_data: map }))));
      metrics.renderedTextBytes += renderedSizes.get(titleKey) * count;
    }
    if (metrics.bytes > limits.bytes || metrics.renderedTextBytes > limits.bytes) throw tooLarge();
  }
  metrics.assemblyMs = performance.now() - started;
  return { fieldsByRequestId, metrics };
}

// Capture commands already hold the definition and proposed values. Validate
// their title size in that transaction and return fresh mappings to autosave.
export async function capturedParameterTitles(client, identity, model, capture, validation = {}) {
  const subjects = new Map(capture.occurrences.filter((row) => row.subject).map((row) => [row.subject.testRequestId, row.subject]));
  if (!subjects.size) return {};
  const requests = parameterTitleRequests(model, [...subjects.values()], { capture, validation });
  return requestedParameterTitles(client, identity, subjects, requests);
}

export async function requestedParameterTitles(client, identity, subjects, requests) {
  if (!requests.size) return {};
  const chosen = [...requests.keys()].map((id) => subjects.get(id));
  const rows = await capturedParameterRows(client, identity, chosen);
  const loaded = await loadParameterTitleFields(client, identity, rows, requests);
  return Object.fromEntries(rows.map((row) => [row.testRequestId, parameterTitleProjection(row, loaded.fieldsByRequestId.get(row.testRequestId))]));
}

export async function capturedParameterRows(client, identity, chosen) {
  if (!chosen.length) return [];
  const rows = (await client.query(`SELECT chosen.test_request_id AS "testRequestId",parameter.parameter_id AS "parameterId",
      parameter.parameter_revision AS "parameterRevision",parameter.organization_id AS "parameterOrganizationId",parameter.parameter_name AS "parameterName",
      parameter.parameter_master_key AS "parameterKey",parameter.history_available AS "parameterHistoryAvailable",parameter.custom_field_count AS "parameterCustomFieldCount",
      parameter.description AS "parameterDescription",parameter.display_order AS "parameterOrder",parameter.scheme_abbreviation AS "parameterSchemeAbbreviation",parameter.laboratory_id AS "parameterLaboratoryId"
    FROM unnest($2::uuid[],$3::uuid[]) chosen(test_request_id,specification_id)
    JOIN laboratory_parameter_context parameter ON parameter.organization_id=$1 AND parameter.specification_id=chosen.specification_id`,
  [identity.organization_id, chosen.map((row) => row.testRequestId), chosen.map((row) => row.specificationId)])).rows;
  if (rows.length !== chosen.length) throw incomplete();
  return rows;
}
