import { and, or, eq, asc, desc, ne, inArray, sql } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import * as tables from '../db/template-schema.js';
import { assembleDefinition } from './model.js';
import { uuid } from './input.js';

// Eight definition SELECTs, including optional version selection, independent of template size.
// Load columns separately; each field can have at most one numeric configuration.
export async function loadDefinition(client, organizationId, versionId, options = {}) {
  const result = await loadDefinitions(client, organizationId, versionId ? [versionId] : [], options);
  const definition = result.definitions.values().next().value;
  return { ...definition, metrics: result.metrics, versions: result.versions };
}

// A report can reference many historical datasheets. Stable field IDs recur in
// different versions, so records are partitioned by version before assembly.
export async function loadDefinitions(client, organizationId, versionIds, options = {}) {
  if ((!versionIds.length && !options.templateId && !options.templateIds?.length) || versionIds.length > 1001 || options.templateIds?.length > 250) throw new HttpError(422, 'template_batch_limit', 'The requested template batch exceeds the supported size.');
  versionIds = versionIds.map((id) => uuid(id, 'Template version').toLowerCase());
  const db = database(client);
  const metrics = { queries: [], queryCount: 0, databaseMs: 0, assemblyMs: 0 };
  async function query(name, operation) {
    const start = performance.now();
    const result = await operation();
    const durationMs = performance.now() - start;
    metrics.queries.push({ name, durationMs, rows: result.length });
    metrics.queryCount += 1;
    metrics.databaseMs += durationMs;
    if (result.length > 200_000) throw new HttpError(422, 'template_batch_limit', 'The combined template definitions exceed the supported report size.');
    return result;
  }
  const where = (table) => and(eq(table.organizationId, organizationId), inArray(table.versionId, versionIds));
  const { templates, templateVersions: versions, templateSections: sections, templateRows: rows,
    templateColumns: columns, templateFields: fields, templateNumericConfig: numeric,
    templateOptions: choices, templateExpressions: expressions, templateExpressionNodes: nodes, templateRepeatGroups: groups } = tables;
  const latestVersions = options.templateIds ? db.selectDistinctOn([versions.templateId], { id: versions.id }).from(versions)
    .where(and(eq(versions.organizationId, organizationId), ne(versions.status, 'building'), inArray(versions.templateId, options.templateIds)))
    .orderBy(asc(versions.templateId), desc(sql`${versions.status} = 'draft'`), desc(versions.number)) : null;
  const versionRows = await query('version', () => db.select({ version: versions, code: templates.code, active: templates.active }).from(versions)
    .innerJoin(templates, and(eq(versions.organizationId, templates.organizationId), eq(versions.templateId, templates.id)))
    .where(and(eq(versions.organizationId, organizationId), ne(versions.status, 'building'), options.templateIds ? or(inArray(versions.id, latestVersions), versionIds.length ? inArray(versions.id, versionIds) : undefined) : options.templateId ? eq(versions.templateId, options.templateId) : inArray(versions.id, versionIds)))
    .orderBy(desc(sql`${versions.status} = 'draft'`), desc(versions.number)));
  const selectedVersions = options.templateId ? [versionIds.length ? versionRows.find((row) => row.version.id === versionIds[0]) : versionRows[0]].filter(Boolean) : versionRows;
  const foundVersionIds = new Set(selectedVersions.map(({ version }) => version.id));
  const foundTemplateIds = new Set(selectedVersions.map(({ version }) => version.templateId));
  if (!selectedVersions.length || versionIds.some((id) => !foundVersionIds.has(id.toLowerCase()))
    || options.templateIds?.some((id) => !foundTemplateIds.has(id.toLowerCase()))) throw new HttpError(404, 'template_not_found', 'Template version was not found.');
  versionIds = selectedVersions.map(({ version }) => version.id);
  const sectionRows = await query('sections', () => db.select().from(sections).where(where(sections)).orderBy(asc(sections.position), asc(sections.id)).limit(200_001));
  const layoutRows = await query('rows', () => db.select().from(rows).where(where(rows)).orderBy(asc(rows.position), asc(rows.id)).limit(200_001));
  const columnRows = await query('columns', () => db.select().from(columns)
    .where(where(columns)).orderBy(asc(columns.position), asc(columns.id)).limit(200_001));
  // The full numeric primary key bounds each lookup even with fresh-data estimates.
  const fieldNumeric = db.select().from(numeric)
    .where(and(eq(numeric.organizationId, fields.organizationId), eq(numeric.versionId, fields.versionId), eq(numeric.fieldId, fields.id)))
    .limit(1).as('template_numeric_config');
  const fieldRows = await query('fields_numeric_configuration', () => db.select({ field: fields, numeric }).from(fields)
    .leftJoinLateral(fieldNumeric, sql`true`).where(where(fields)).limit(200_001));
  const optionRows = await query('options', () => db.select().from(choices).where(where(choices)).orderBy(asc(choices.position), asc(choices.id)).limit(200_001));
  // The bounded lateral lookup keeps fresh-data estimates from scanning every
  // node in the version for each expression. Retain the existing node projection.
  const expressionNodes = db.select().from(nodes)
    .where(and(eq(nodes.organizationId, expressions.organizationId), eq(nodes.versionId, expressions.versionId), eq(nodes.expressionId, expressions.id)))
    .orderBy(asc(nodes.nodeIndex)).limit(200_001).as('template_expression_nodes');
  const expressionRows = await query('expressions_dependencies', () => db.select({ expression: expressions, node: nodes }).from(expressions)
    .leftJoinLateral(expressionNodes, sql`true`)
    .where(where(expressions)).orderBy(asc(expressions.id), asc(nodes.nodeIndex)).limit(200_001));
  const groupRows = await query('repeat_definitions', () => db.select().from(groups).where(where(groups)).limit(200_001));
  const assemblyStart = performance.now();
  const definitions = new Map(selectedVersions.map((selectedVersion) => [selectedVersion.version.id, {
    records: { version: { ...selectedVersion.version, code: selectedVersion.code, active: selectedVersion.active },
      sections: [], rows: [], columns: [], fields: [], options: [], expressions: [], groups: [] },
  }]));
  const fieldByColumn = new Map(fieldRows.map(({ field, numeric }) => [`${field.versionId}:${field.columnId}`, { ...field, numeric }]));
  const expressionMap = new Map();
  for (const { expression, node } of expressionRows) {
    const key = `${expression.versionId}:${expression.id}`;
    if (!expressionMap.has(key)) expressionMap.set(key, { ...expression, nodes: [] });
    if (node) expressionMap.get(key).nodes.push({
      index: node.nodeIndex, parentIndex: node.parentIndex, operandOrder: node.operandOrder, kind: node.kind,
      number: node.numberLiteral, text: node.textLiteral, boolean: node.booleanLiteral,
      fieldId: node.referenceFieldId, scope: node.referenceScope, operator: node.operator, functionName: node.functionName,
    });
  }
  for (const [key, records] of [['sections', sectionRows], ['rows', layoutRows], ['options', optionRows], ['expressions', expressionMap.values()], ['groups', groupRows]]) {
    for (const record of records) definitions.get(record.versionId).records[key].push(record);
  }
  for (const column of columnRows) {
    const { records } = definitions.get(column.versionId);
    records.columns.push(column);
    const field = fieldByColumn.get(`${column.versionId}:${column.id}`);
    if (field) records.fields.push(field);
  }
  for (const definition of definitions.values()) definition.model = assembleDefinition(definition.records, options);
  metrics.assemblyMs = performance.now() - assemblyStart;
  return { definitions, metrics, versions: versionRows.map(({ version: { id, number, status, revision } }) => ({ id, number, status, revision })) };
}

export async function loadCapture(client, organizationId, instanceId, revision, options) {
  const { captures, metrics, pinnedValues } = await loadCaptures(client, organizationId, [{ instanceId, revision }], options);
  return { ...captures.get(instanceId.toLowerCase()), metrics, pinnedValues };
}

export async function loadCaptures(client, organizationId, requests, { pinnedValues = [] } = {}) {
  requests = requests.map((request) => ({ ...request, instanceId: uuid(request.instanceId, 'Capture').toLowerCase() }));
  if (!requests.length || requests.length > 1000 || new Set(requests.map((request) => request.instanceId)).size !== requests.length) throw new HttpError(400, 'invalid_capture_batch', 'Select between one and 1,000 distinct captures.');
  const started = performance.now();
  const instanceIds = requests.map((request) => request.instanceId);
  const result = await client.query('SELECT * FROM template_instances WHERE organization_id = $1 AND id = ANY($2::uuid[])', [organizationId, instanceIds]);
  const instances = new Map(result.rows.map((instance) => [instance.id, instance]));
  const captures = new Map();
  for (const request of requests) {
    const instance = instances.get(request.instanceId);
    if (!instance) throw new HttpError(404, 'capture_not_found', 'Datasheet capture was not found.');
    const atRevision = request.revision ?? instance.revision;
    if (!Number.isSafeInteger(atRevision) || atRevision < 1 || atRevision > instance.revision) throw new HttpError(400, 'invalid_revision', 'Capture revision is invalid.');
    captures.set(instance.id, { instance, revision: atRevision, occurrences: [], values: [] });
  }
  if (!Array.isArray(pinnedValues) || pinnedValues.length > 1000) throw new HttpError(400, 'invalid_pinned_values', 'Select at most 1,000 recorded values.');
  pinnedValues = pinnedValues.map((value) => {
    const normalized = { instanceId: uuid(value.instanceId).toLowerCase(), fieldId: uuid(value.fieldId).toLowerCase(), occurrenceId: uuid(value.occurrenceId).toLowerCase(), revision: value.revision };
    if (!Number.isSafeInteger(normalized.revision) || normalized.revision < 1 || !captures.has(normalized.instanceId)
      || normalized.revision > captures.get(normalized.instanceId).revision) throw new HttpError(400, 'invalid_pinned_values', 'The recorded value is outside the requested capture history.');
    return normalized;
  });
  const parameters = [organizationId, instanceIds, [...captures.values()].map((capture) => capture.revision)];
  const occurrences = await client.query(`SELECT occurrence.instance_id AS "instanceId", occurrence.id, occurrence.group_id AS "groupId", occurrence.parent_id AS "parentId", occurrence.position,
    occurrence.created_revision AS "createdRevision", occurrence.removed_revision AS "removedRevision", subject.id AS "subjectId",
    subject.test_request_id AS "subjectTestRequestId",subject.specification_id AS "subjectSpecificationId",
    specification.parameter_name AS "subjectParameterName",specification.method_name AS "subjectMethodName",specification.unit_symbol AS "subjectMeasurementUnit",
    specification.rule_name AS "subjectSpecification"
    FROM template_occurrences occurrence
    JOIN unnest($2::uuid[], $3::integer[]) requested(instance_id, revision) ON requested.instance_id=occurrence.instance_id
    LEFT JOIN datasheet_subjects subject ON subject.organization_id=occurrence.organization_id AND subject.instance_id=occurrence.instance_id AND subject.occurrence_id=occurrence.id
    LEFT JOIN analytical_specifications specification ON specification.organization_id=subject.organization_id AND specification.id=subject.specification_id
    WHERE occurrence.organization_id = $1 AND occurrence.created_revision <= requested.revision AND (occurrence.removed_revision IS NULL OR occurrence.removed_revision > requested.revision)
    ORDER BY occurrence.instance_id, occurrence.position, occurrence.id LIMIT 200001`, parameters);
  if (occurrences.rows.length > 200_000) throw new HttpError(422, 'capture_batch_limit', 'The combined captures exceed the supported report size.');
  const valueColumns = `value.instance_id AS "instanceId", value.field_id AS "fieldId", value.occurrence_id AS "occurrenceId",
    value.revision, value.value_type AS "valueType", value.state, value.origin, value.number_value AS "numberValue", value.text_value AS "textValue", value.boolean_value AS "booleanValue",
    value.date_value::text AS "dateValue", value.option_id AS "optionId", value.lexical, value.error_code AS "errorCode", value.error_message AS "errorMessage", value.saved_at AS "savedAt", value.saved_by AS "savedBy"`;
  // Explicit historical result selections share the third capture statement.
  // They remain separate from the active values rendered in the current rows.
  // Materialize each key set once: joining occurrences into the history scan
  // otherwise repeats that scan per occurrence under the application RLS plan.
  // Project membership once to avoid rechecking every occurrence for each value.
  // NULLS LAST matches template_value_latest; revision itself is NOT NULL.
  const values = await client.query(`WITH active_occurrences AS MATERIALIZED (
    SELECT occurrence.instance_id,occurrence.id FROM template_occurrences occurrence
    JOIN unnest($2::uuid[],$3::integer[]) requested(instance_id,revision) ON requested.instance_id=occurrence.instance_id
    WHERE occurrence.organization_id=$1 AND occurrence.created_revision<=requested.revision
      AND (occurrence.removed_revision IS NULL OR occurrence.removed_revision>requested.revision) LIMIT 200001
  ), latest_keys AS MATERIALIZED (
    SELECT requested.instance_id,latest.field_id,latest.occurrence_id,latest.revision,
      (requested.instance_id,latest.occurrence_id) IN (SELECT instance_id,id FROM active_occurrences) AS is_active
    FROM unnest($2::uuid[],$3::integer[]) requested(instance_id,revision)
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (field_id,occurrence_id) field_id,occurrence_id,revision
      FROM template_values WHERE organization_id=$1 AND instance_id=requested.instance_id AND revision<=requested.revision
      ORDER BY field_id,occurrence_id,revision DESC NULLS LAST
    ) latest
  ), current_keys AS MATERIALIZED (
    SELECT latest.instance_id,latest.field_id,latest.occurrence_id,latest.revision FROM latest_keys latest WHERE latest.is_active
    ORDER BY latest.instance_id,latest.field_id,latest.occurrence_id LIMIT 200001
  ) (SELECT ${valueColumns},false AS pinned FROM current_keys selected JOIN template_values value
    ON value.organization_id=$1 AND value.instance_id=selected.instance_id AND value.field_id=selected.field_id
      AND value.occurrence_id=selected.occurrence_id AND value.revision=selected.revision
    ORDER BY value.instance_id,value.field_id,value.occurrence_id)
    UNION ALL SELECT ${valueColumns},true AS pinned FROM template_values value
      JOIN unnest($4::uuid[],$5::uuid[],$6::uuid[],$7::integer[]) selected(instance_id,field_id,occurrence_id,revision)
        ON selected.instance_id=value.instance_id AND selected.field_id=value.field_id AND selected.occurrence_id=value.occurrence_id AND selected.revision=value.revision
      WHERE value.organization_id=$1 LIMIT 200001`, [...parameters, pinnedValues.map((value) => value.instanceId), pinnedValues.map((value) => value.fieldId),
    pinnedValues.map((value) => value.occurrenceId), pinnedValues.map((value) => value.revision)]);
  if (values.rows.length > 200_000) throw new HttpError(422, 'capture_batch_limit', 'The combined captures exceed the supported report size.');
  const activeOccurrenceIds = new Set();
  for (const { instanceId, subjectId, subjectTestRequestId, subjectSpecificationId, subjectParameterName, subjectMethodName,
    subjectMeasurementUnit, subjectSpecification, ...occurrence } of occurrences.rows) {
    if (subjectId) occurrence.subject = { id: subjectId, testRequestId: subjectTestRequestId, specificationId: subjectSpecificationId,
      parameterName: subjectParameterName, methodName: subjectMethodName, measurementUnit: subjectMeasurementUnit, specification: subjectSpecification };
    captures.get(instanceId).occurrences.push(occurrence);
    activeOccurrenceIds.add(`${instanceId}:${occurrence.id}`);
  }
  const recordedValues = new Map();
  for (const { instanceId, pinned, ...value } of values.rows) {
    if (pinned) recordedValues.set(`${instanceId}:${value.fieldId}:${value.occurrenceId}:${value.revision}`, value);
    else if (activeOccurrenceIds.has(`${instanceId}:${value.occurrenceId}`)) captures.get(instanceId).values.push(value);
  }
  return { captures, pinnedValues: recordedValues, metrics: { queryCount: 3, databaseMs: performance.now() - started } };
}
