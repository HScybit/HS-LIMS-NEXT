import { and, or, eq, asc, desc, ne, inArray, sql } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import * as tables from '../db/template-schema.js';
import { assembleDefinition } from './model.js';
import { uuid } from './input.js';

// Eight definition SELECTs, including optional version selection, independent of template size.
// Numeric configuration is batched separately to avoid a three-way join explosion with fresh-data estimates.
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
  const columnRows = await query('columns_fields', () => db.select({ column: columns, field: fields }).from(columns)
    .leftJoin(fields, and(eq(columns.organizationId, fields.organizationId), eq(columns.versionId, fields.versionId), eq(columns.id, fields.columnId)))
    .where(where(columns)).orderBy(asc(columns.position), asc(columns.id)).limit(200_001));
  const numericRows = await query('numeric_configuration', () => db.select().from(numeric).where(where(numeric)).limit(200_001));
  const optionRows = await query('options', () => db.select().from(choices).where(where(choices)).orderBy(asc(choices.position), asc(choices.id)).limit(200_001));
  const expressionRows = await query('expressions_dependencies', () => db.select({ expression: expressions, node: nodes }).from(expressions)
    .leftJoin(nodes, and(eq(expressions.organizationId, nodes.organizationId), eq(expressions.versionId, nodes.versionId), eq(expressions.id, nodes.expressionId)))
    .where(where(expressions)).orderBy(asc(expressions.id), asc(nodes.nodeIndex)).limit(200_001));
  const groupRows = await query('repeat_definitions', () => db.select().from(groups).where(where(groups)).limit(200_001));
  const assemblyStart = performance.now();
  const definitions = new Map(selectedVersions.map((selectedVersion) => [selectedVersion.version.id, {
    records: { version: { ...selectedVersion.version, code: selectedVersion.code, active: selectedVersion.active },
      sections: [], rows: [], columns: [], fields: [], options: [], expressions: [], groups: [] },
  }]));
  const numericByField = new Map(numericRows.map((row) => [`${row.versionId}:${row.fieldId}`, row]));
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
  for (const { column, field } of columnRows) {
    const { records } = definitions.get(column.versionId);
    records.columns.push(column);
    if (field) records.fields.push({ ...field, numeric: numericByField.get(`${field.versionId}:${field.id}`) ?? null });
  }
  for (const definition of definitions.values()) definition.model = assembleDefinition(definition.records, options);
  metrics.assemblyMs = performance.now() - assemblyStart;
  return { definitions, metrics, versions: versionRows.map(({ version: { id, number, status, revision } }) => ({ id, number, status, revision })) };
}

export async function loadCapture(client, organizationId, instanceId, revision) {
  const { captures, metrics } = await loadCaptures(client, organizationId, [{ instanceId, revision }]);
  return { ...captures.get(instanceId.toLowerCase()), metrics };
}

export async function loadCaptures(client, organizationId, requests) {
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
  const parameters = [organizationId, instanceIds, [...captures.values()].map((capture) => capture.revision)];
  const occurrences = await client.query(`SELECT occurrence.instance_id AS "instanceId", occurrence.id, group_id AS "groupId", parent_id AS "parentId", position,
    created_revision AS "createdRevision", removed_revision AS "removedRevision" FROM template_occurrences occurrence
    JOIN unnest($2::uuid[], $3::integer[]) requested(instance_id, revision) ON requested.instance_id=occurrence.instance_id
    WHERE organization_id = $1 AND created_revision <= requested.revision AND (removed_revision IS NULL OR removed_revision > requested.revision)
    ORDER BY occurrence.instance_id, position, occurrence.id LIMIT 200001`, parameters);
  const values = await client.query(`SELECT DISTINCT ON (value.instance_id, field_id, occurrence_id) value.instance_id AS "instanceId", field_id AS "fieldId", occurrence_id AS "occurrenceId",
    value.revision, value_type AS "valueType", state, origin, number_value AS "numberValue", text_value AS "textValue", boolean_value AS "booleanValue",
    date_value::text AS "dateValue", option_id AS "optionId", lexical, error_code AS "errorCode", error_message AS "errorMessage", saved_at AS "savedAt", saved_by AS "savedBy"
    FROM template_values value JOIN unnest($2::uuid[], $3::integer[]) requested(instance_id, revision) ON requested.instance_id=value.instance_id
    WHERE organization_id = $1 AND value.revision <= requested.revision ORDER BY value.instance_id, field_id, occurrence_id, value.revision DESC LIMIT 200001`, parameters);
  if (occurrences.rows.length > 200_000 || values.rows.length > 200_000) throw new HttpError(422, 'capture_batch_limit', 'The combined captures exceed the supported report size.');
  const activeOccurrenceIds = new Set();
  for (const { instanceId, ...occurrence } of occurrences.rows) {
    captures.get(instanceId).occurrences.push(occurrence);
    activeOccurrenceIds.add(`${instanceId}:${occurrence.id}`);
  }
  for (const { instanceId, ...value } of values.rows) if (activeOccurrenceIds.has(`${instanceId}:${value.occurrenceId}`)) captures.get(instanceId).values.push(value);
  return { captures, metrics: { queryCount: 3, databaseMs: performance.now() - started } };
}
