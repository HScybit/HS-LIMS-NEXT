import { HttpError } from '../auth/errors.js';
import { parameterDetailBytes, parameterDetailLimits, parameterDetailPayload } from './parameter-detail.js';

const keyFor = (value) => `${value.instanceId}:${value.fieldId}:${value.occurrenceId}:${value.revision}`;
const invalid = () => { throw new HttpError(422, 'invalid_parameter_detail_history', 'The saved parameter detail lists are incomplete.'); };

// Headers come from the existing capture query. Deduplicate a value selected
// both as current data and as a pinned result, and load all lists in two batches.
export async function loadParameterDetailItems(client, organizationId, values) {
  const selected = new Map();
  for (const value of values) if (value.valueType === 'parameter_detail') {
    if (value.parameterDetailKind === 'array') {
      if (value.state !== 'present' || !Number.isInteger(value.parameterDetailItemCount) || value.parameterDetailItemCount < 0 || value.parameterDetailItemCount > parameterDetailLimits.items) invalid();
      const key = keyFor(value);
      if (selected.has(key) && selected.get(key).parameterDetailItemCount !== value.parameterDetailItemCount) invalid();
      selected.set(key, value);
    } else parameterDetailPayload(value);
  }
  const bytes = parameterDetailBytes(values);
  const rows = [...selected.values()];
  const expected = rows.reduce((count, row) => count + row.parameterDetailItemCount, 0);
  if (!expected) {
    for (const value of values) if (selected.has(keyFor(value))) value.parameterDetailItems = [];
    return { queryCount: 0, databaseMs: 0, assemblyMs: 0, bytes };
  }
  if (expected > 500_000) throw new HttpError(422, 'parameter_detail_limit', 'The captured parameter details exceed the supported list size.');
  const parameters = [organizationId, rows.map((row) => row.instanceId), rows.map((row) => row.fieldId), rows.map((row) => row.occurrenceId), rows.map((row) => row.revision)];
  const join = `FROM template_parameter_detail_items item
    JOIN unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::integer[]) selected(instance_id,field_id,occurrence_id,revision)
      ON selected.instance_id=item.instance_id AND selected.field_id=item.field_id AND selected.occurrence_id=item.occurrence_id AND selected.revision=item.revision
    WHERE item.organization_id=$1`;
  const started = performance.now();
  const budget = (await client.query(`SELECT count(*)::integer AS count,
    coalesce(sum(octet_length(coalesce(item.text_value,item.number_value::text,item.boolean_value::text,''))),0)::text AS bytes ${join}`, parameters)).rows[0];
  if (budget?.count !== expected) invalid();
  if (Number(budget.bytes) + bytes > parameterDetailLimits.bytes) throw new HttpError(422, 'parameter_detail_limit', 'The captured parameter details exceed the supported data size.');
  const result = await client.query(`SELECT item.instance_id AS "instanceId",item.field_id AS "fieldId",item.occurrence_id AS "occurrenceId",item.revision,
    item.position,item.kind,item.text_value AS "textValue",item.number_value AS "numberValue",item.boolean_value AS "booleanValue" ${join}
    ORDER BY item.instance_id,item.field_id,item.occurrence_id,item.revision,item.position LIMIT 500001`, parameters);
  const databaseMs = performance.now() - started; const assemblyStarted = performance.now();
  if (result.rows.length !== expected) invalid();
  const items = new Map(rows.map((row) => [keyFor(row), []]));
  for (const row of result.rows) {
    const target = items.get(keyFor(row));
    if (!target || target.length !== row.position) invalid();
    target.push({ position: row.position, kind: row.kind, textValue: row.textValue, numberValue: row.numberValue, booleanValue: row.booleanValue });
  }
  for (const value of values) if (value.valueType === 'parameter_detail' && value.parameterDetailKind === 'array') {
    value.parameterDetailItems = items.get(keyFor(value));
    parameterDetailPayload(value);
  }
  const totalBytes = parameterDetailBytes(values);
  return { queryCount: 2, databaseMs, assemblyMs: performance.now() - assemblyStarted, bytes: totalBytes };
}
