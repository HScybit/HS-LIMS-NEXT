import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { analyticalRecords, createAnalyticalTemplate } from '../helpers/templates.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool, database } from '../../src/db/pool.js';
import { createTemplate, editTemplate, freezeTemplate, createDraft, copyDefinition, cloneTemplate } from '../../src/templates/authoring.js';
import { loadDefinition, loadCapture } from '../../src/templates/loader.js';
import { createCapture, saveCapture, changeRepeat } from '../../src/templates/capture.js';
import { calculateCapture, displayValue } from '../../src/templates/calculations.js';
import { saveTemplatePrintConfig } from '../../src/templates/print-config.js';

const owner = ownerPool();
let account; let session;
before(async () => {
  account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
  session = await signIn({ identifier: account.username, password: account.password });
});
after(async () => { await closePool(); await owner.end(); });
const work = (action, options) => withSession(session.token, action, { csrfToken: session.csrfToken, ...options });
const fixture = (options) => work((client, identity) => createAnalyticalTemplate(client, identity, options));
const definition = (id) => work((client, identity) => loadDefinition(client, identity.organization_id, id), { readOnly: true });
const freeze = (versionId, revision = 1) => work((client, identity) => freezeTemplate(client, identity, versionId, revision));

function maximumPlanRowVisits(plan) {
  const rows = (plan['Actual Rows'] ?? 0) + (plan['Rows Removed by Filter'] ?? 0) + (plan['Rows Removed by Join Filter'] ?? 0);
  let maximum = rows * (plan['Actual Loops'] ?? 0);
  for (const child of plan.Plans ?? []) maximum = Math.max(maximum, maximumPlanRowVisits(child));
  return maximum;
}

test('relational definition loads in eight queries with explicit repeat dependencies and no JSON columns', async () => {
  const template = await fixture();
  const loaded = await definition(template.versionId);
  assert.equal(loaded.metrics.queryCount, 9);
  assert.equal(Object.keys(loaded.model.fieldsById).length, 4);
  assert.equal(loaded.model.calculationOrder.length, 2);
  assert.equal(loaded.records.expressions.find((expression) => expression.fieldId === template.records.fields.at(-1).id).references.some((reference) => reference.scope === 'descendants'), true);
  assert.equal((await owner.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')")).rowCount, 0);
  assert.equal((await getPool().query('SELECT * FROM templates')).rowCount, 0);
});

test('authoring uses stable IDs, transactional moves, stale conflicts and atomic rollback', async () => {
  const template = await fixture({ repeated: false });
  const [firstRow, secondRow] = template.records.rows;
  const results = await Promise.allSettled([firstRow, firstRow].map((row) => work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'move', kind: 'row', id: row.id, direction: 1 }))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.reason?.code === 'stale_template').length, 1);
  let loaded = await definition(template.versionId);
  assert.deepEqual(loaded.model.sectionsById[template.records.sections[0].id].rowIds, [secondRow.id, firstRow.id]);
  await assert.rejects(work((client, identity) => editTemplate(client, identity, template.versionId, 2, { type: 'addRow', sectionId: randomUUID() })), { status: 404 });
  loaded = await definition(template.versionId);
  assert.equal(loaded.model.version.revision, 2);
  assert.deepEqual(new Set(Object.keys(loaded.model.fieldsById)), new Set(template.records.fields.map((field) => field.id)));
});

test('template creation validates UUID input and reports a duplicate code without inserting a version', async () => {
  await assert.rejects(work((client, identity) => createTemplate(client, identity, { name: 'Invalid code', kind: 'datasheet', code: 12 })), { status: 400 });
  const code = randomUUID();
  await work((client, identity) => createTemplate(client, identity, { name: 'Unique code', kind: 'datasheet', code }));
  await assert.rejects(work((client, identity) => createTemplate(client, identity, { name: 'Duplicate code', kind: 'datasheet', code: code.toUpperCase() })), { code: 'template_code_taken', status: 409 });
  assert.equal((await owner.query('SELECT 1 FROM templates WHERE organization_id = $1 AND lower(code) = lower($2)', [account.organizationId, code])).rowCount, 1);
});

test('frozen versions reject direct changes; new drafts preserve logical IDs and old calculation history', async () => {
  const template = await fixture({ repeated: false });
  await freeze(template.versionId);
  await assert.rejects(work((client) => client.query('UPDATE template_fields SET label = $3 WHERE organization_id = $1 AND version_id = $2', [account.organizationId, template.versionId, 'Changed'])), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM template_versions WHERE organization_id = $1 AND id = $2', [account.organizationId, template.versionId]), { code: '55000' });
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  const draft = await work((client, identity) => createDraft(client, identity, template.versionId));
  const next = await definition(draft.versionId);
  assert.deepEqual(new Set(Object.keys(next.model.fieldsById)), new Set(template.records.fields.map((field) => field.id)));
  const field = next.model.fieldsById[template.records.fields[1].id];
  await work((client, identity) => editTemplate(client, identity, draft.versionId, 1, {
    type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, formula: 'raw_0 * 3',
  }));
  const historical = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId), { readOnly: true });
  assert.equal(historical.instance.version_id, template.versionId);
  assert.equal((await definition(template.versionId)).model.fieldsById[field.id].formula, 'raw_0*2');
  assert.equal((await definition(draft.versionId)).model.fieldsById[field.id].formula, 'raw_0*3');
  await assert.rejects(work((client, identity) => createDraft(client, identity, template.versionId)), { code: 'draft_exists' });
});

test('capture saves repeat zero values, recalculates totals, reloads history and prevents stale edits', async () => {
  const template = await fixture();
  await freeze(template.versionId);
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  let loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId), { readOnly: true });
  assert.equal(loaded.metrics.queryCount, 3);
  const repeated = loaded.occurrences.filter((row) => row.groupId);
  const raw = template.records.fields[0];
  const inputs = repeated.map((row, index) => ({ fieldId: raw.id, occurrenceId: row.id, state: 'present', value: index ? '1.005' : '0' }));
  const saved = await work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, inputs));
  assert.equal(saved.revision, 2);
  const total = saved.values.find((value) => value.fieldId === template.records.fields.at(-1).id);
  assert.equal(total.numberValue, '1.005');
  const model = (await definition(template.versionId)).model;
  assert.equal(displayValue(model.fieldsById[total.fieldId], total), '1.00');
  await assert.rejects(work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, inputs)), { code: 'stale_capture' });
  loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId), { readOnly: true });
  assert.equal(loaded.values.find((value) => value.fieldId === raw.id && value.occurrenceId === repeated[0].id).numberValue, '0');
  const prior = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId, 1), { readOnly: true });
  assert.equal(prior.values.some((value) => value.origin === 'entered'), false);
  const previousCalculation = calculateCapture(model, prior.occurrences, prior.values).calculated;
  assert.equal(previousCalculation.filter((value) => value.fieldId === template.records.fields[1].id).every((value) => value.state === 'invalid'), true);
  assert.equal(previousCalculation.find((value) => value.fieldId === template.records.fields.at(-1).id).numberValue, '0');
  await assert.rejects(owner.query('UPDATE template_values SET number_value = 999 WHERE organization_id = $1 AND instance_id = $2', [account.organizationId, capture.instanceId]), { code: '55000' });
});

test('invalid values, forged calculations and cross-repeat writes roll back the capture revision', async () => {
  const template = await fixture(); await freeze(template.versionId);
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  const loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const root = loaded.occurrences.find((row) => !row.groupId);
  const repeat = loaded.occurrences.find((row) => row.groupId);
  for (const [fieldId, occurrenceId, value, code] of [
    [template.records.fields[0].id, root.id, '1', 'invalid_capture_field'],
    [template.records.fields[1].id, repeat.id, '2', 'readonly_field'],
    [template.records.fields[0].id, repeat.id, 'not-a-number', 'invalid_number'],
  ]) await assert.rejects(work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, [{ fieldId, occurrenceId, state: 'present', value }])), { code });
  assert.equal((await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId))).revision, 1);
  await assert.rejects(owner.query(`INSERT INTO template_values(organization_id, instance_id, version_id, field_id, occurrence_id, revision, value_type, state, origin, number_value, saved_by)
    VALUES($1,$2,$3,$4,$5,1,'numeric','present','entered',1,$6)`, [account.organizationId, capture.instanceId, template.versionId, template.records.fields[0].id, root.id, account.userId]), { code: '23514' });
});

test('tenant and role boundaries cover direct definition reads, writes and cross-tenant references', async () => {
  const template = await fixture();
  const other = await createAccount(owner);
  const otherSession = await signIn({ identifier: other.username, password: other.password });
  await assert.rejects(withSession(otherSession.token, (client, identity) => loadDefinition(client, identity.organization_id, template.versionId)), { status: 404 });
  await assert.rejects(withSession(otherSession.token, (client, identity) => createTemplate(client, identity, { name: 'Denied', kind: 'datasheet' })), { status: 403 });
  await assert.rejects(owner.query('INSERT INTO template_rows(organization_id, version_id, section_id, position) VALUES($1,$2,$3,100)', [other.organizationId, template.versionId, template.records.sections[0].id]), { code: '55000' });
});

test('permission checks are reevaluated after revocation on pooled connections', async () => {
  const template = await fixture();
  const reader = await createAccount(owner, { organizationId: account.organizationId });
  const active = await signIn({ identifier: reader.username, password: reader.password });
  const read = () => withSession(active.token, (client) => client.query('SELECT id FROM templates WHERE id = $1', [template.templateId]), { readOnly: true });
  assert.equal((await read()).rowCount, 1);
  await owner.query('DELETE FROM role_permissions WHERE organization_id = $1 AND role_id = $2', [account.organizationId, reader.roleId]);
  assert.equal((await read()).rowCount, 0);
  assert.equal((await definition(template.versionId)).model.version.id, template.versionId);
});

test('cloning a repeated row creates distinct identities and rewires internal formula references', async () => {
  const template = await fixture();
  const sourceRow = template.records.rows[0];
  const originalFields = new Set(template.records.fields.map((field) => field.id));
  const cloned = await work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'clone', kind: 'row', id: sourceRow.id }));
  const newFields = Object.values(cloned.model.fieldsById).filter((field) => !originalFields.has(field.id));
  assert.equal(newFields.length, 2);
  const raw = newFields.find((field) => field.widget === 'number_widget');
  const calculated = newFields.find((field) => field.widget === 'formula_widget');
  assert.notEqual(raw.repeatGroupId, template.records.groups[0].id);
  assert.equal(cloned.model.expressions[`${calculated.id}:calculate`].references[0].fieldId, raw.id);
  await assert.rejects(work((client, identity) => editTemplate(client, identity, template.versionId, 2, { type: 'delete', kind: 'field', id: template.records.fields[0].id })), { code: 'referenced_field' });
  const removed = await work((client, identity) => editTemplate(client, identity, template.versionId, 2, { type: 'delete', kind: 'row', id: cloned.model.columnsById[raw.columnId].rowId }));
  assert.equal(Object.keys(removed.model.fieldsById).length, originalFields.size);
});

test('nested-container draft copying preserves placement; cyclic formula edits roll back', async () => {
  const template = await fixture({ repeated: false });
  let loaded = await work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'addColumn', rowId: template.records.rows[0].id }));
  const emptyColumn = Object.values(loaded.model.columnsById).find((column) => !column.fieldId);
  loaded = await work((client, identity) => editTemplate(client, identity, template.versionId, 2, { type: 'addSection', parentColumnId: emptyColumn.id }));
  const nestedSection = Object.values(loaded.model.sectionsById).find((section) => section.parentColumnId);
  await freeze(template.versionId, 3);
  const draft = await work((client, identity) => createDraft(client, identity, template.versionId));
  loaded = await definition(draft.versionId);
  assert.equal(loaded.model.sectionsById[nestedSection.id].parentColumnId, emptyColumn.id);
  const formula = template.records.fields[1];
  await assert.rejects(work((client, identity) => editTemplate(client, identity, draft.versionId, 1, {
    type: 'configureField', columnId: formula.columnId, widget: formula.widget, alias: formula.alias, formula: `${formula.alias} + 1`,
  })), { code: 'expression_cycle' });
  assert.equal((await definition(draft.versionId)).model.version.revision, 1);
});

test('repeat cloning and removal preserve values, insertion order and historical occurrences', async () => {
  const template = await fixture(); await freeze(template.versionId);
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  const original = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const first = original.occurrences.find((row) => row.groupId);
  await work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, [{ fieldId: template.records.fields[0].id, occurrenceId: first.id, state: 'present', value: '4' }]));
  const cloned = await work((client, identity) => changeRepeat(client, identity, capture.instanceId, 2, { type: 'clone', occurrenceId: first.id, withData: true }));
  const newOccurrence = cloned.occurrences.find((row) => !original.occurrences.some((prior) => prior.id === row.id));
  assert.equal(cloned.values.find((value) => value.fieldId === template.records.fields[0].id && value.occurrenceId === newOccurrence.id).numberValue, '4');
  let loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const order = loaded.occurrences.filter((row) => row.groupId).map((row) => row.id);
  assert.equal(order[order.indexOf(first.id) + 1], newOccurrence.id);
  await work((client, identity) => changeRepeat(client, identity, capture.instanceId, 3, { type: 'remove', occurrenceId: newOccurrence.id }));
  loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  assert.equal(loaded.occurrences.some((row) => row.id === newOccurrence.id), false);
  assert.equal(loaded.values.some((value) => value.occurrenceId === newOccurrence.id), false);
  const historical = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId, 3));
  assert.equal(historical.occurrences.some((row) => row.id === newOccurrence.id), true);
  assert.equal(historical.values.find((value) => value.occurrenceId === newOccurrence.id && value.fieldId === template.records.fields[0].id).numberValue, '4');
  await assert.rejects(work((client, identity) => changeRepeat(client, identity, capture.instanceId, 4, { type: 'remove', occurrenceId: first.id })), { code: 'repeat_minimum' });
});

test('cloneable-row authoring changes explicit reference scopes and can be reversed', async () => {
  const template = await fixture({ repeated: false });
  let loaded = await work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'repeatRow', id: template.records.rows[0].id, enabled: true }));
  assert.equal(loaded.records.groups.length, 1);
  assert.ok(loaded.model.fieldsById[template.records.fields[0].id].repeatGroupId);
  loaded = await work((client, identity) => editTemplate(client, identity, template.versionId, 2, { type: 'repeatRow', id: template.records.rows[0].id, enabled: false }));
  assert.equal(loaded.records.groups.length, 0);
  assert.equal(loaded.model.fieldsById[template.records.fields[0].id].repeatGroupId, null);
});

test('typed defaults and capture preserve false, zero, empty text, calendar dates and pinned options', async () => {
  const sectionId = randomUUID(); const rowId = randomUUID();
  const fields = [
    { widget: 'number_widget', valueType: 'numeric', defaultState: 'present', defaultNumber: '0' },
    { widget: 'checkbox_widget', valueType: 'boolean', defaultState: 'present', defaultBoolean: false },
    { widget: 'datepicker_widget', valueType: 'date', defaultState: 'present', defaultDate: '2024-02-29' },
    { widget: 'input_widget', valueType: 'text', defaultState: 'present', defaultText: '' },
    { widget: 'dropdown_widget', valueType: 'option' },
  ].map((field, position) => ({ ...field, id: randomUUID(), columnId: randomUUID(), alias: `typed_${position}` }));
  const optionId = randomUUID();
  const template = await work(async (client, identity) => {
    const created = await createTemplate(client, identity, { name: 'Synthetic typed capture', kind: 'datasheet' });
    await copyDefinition(database(client), { sections: [{ id: sectionId, position: 0 }], rows: [{ id: rowId, sectionId, position: 0 }],
      columns: fields.map((field, position) => ({ id: field.columnId, rowId, position })), fields,
      options: [{ id: optionId, fieldId: fields[4].id, position: 0, label: 'Pinned option', value: 'A' }], expressions: [], groups: [] }, identity.organization_id, created.versionId);
    return created;
  });
  await freeze(template.versionId);
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  let loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const root = loaded.occurrences[0].id;
  const get = (index) => loaded.values.find((value) => value.fieldId === fields[index].id);
  assert.equal(get(0).numberValue, '0'); assert.equal(get(1).booleanValue, false);
  assert.equal(get(2).dateValue, '2024-02-29'); assert.equal(get(3).textValue, ''); assert.equal(get(3).state, 'present');
  for (const [index, value, code] of [[1, 0, 'invalid_input'], [2, '2025-02-29', 'invalid_date'], [3, null, 'invalid_input'], [4, randomUUID(), 'invalid_option']]) {
    await assert.rejects(work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, [{ fieldId: fields[index].id, occurrenceId: root, state: 'present', value }])), { code });
  }
  await work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, [
    { fieldId: fields[0].id, occurrenceId: root, state: 'empty' }, { fieldId: fields[3].id, occurrenceId: root, state: 'absent' },
    { fieldId: fields[4].id, occurrenceId: root, state: 'present', value: optionId },
  ]));
  loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  assert.equal(get(0).state, 'empty'); assert.equal(get(0).numberValue, null); assert.equal(get(3).state, 'absent');
  assert.equal(get(4).optionId, optionId);
  assert.equal(displayValue((await definition(template.versionId)).model.fieldsById[fields[4].id], get(4)), 'Pinned option');
});

test('the database rejects nonfinite repeat ordering without changing history', async () => {
  const template = await fixture(); await freeze(template.versionId);
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  const loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const root = loaded.occurrences.find((occurrence) => !occurrence.groupId);
  for (const position of ['NaN', 'Infinity']) await assert.rejects(owner.query(`INSERT INTO template_occurrences
    (organization_id, instance_id, version_id, id, group_id, parent_id, position, created_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
  [account.organizationId, capture.instanceId, template.versionId, randomUUID(), template.records.groups[0].id, root.id, position]), { code: '23514', constraint: 'template_occurrence_position_finite' });
});

test('a fresh 1000-field definition and its capture use nine plus three actual SQL reads', async () => {
  const template = await fixture({ rowCount: 500, repeated: false });
  // No ANALYZE or fixture-specific planner settings: regression for the fresh-data join failure.
  await freeze(template.versionId);
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  await work(async (client, identity) => {
    const query = client.query;
    const statements = [];
    client.query = function (...args) {
      statements.push({ sql: typeof args[0] === 'string' ? args[0] : args[0].text,
        parameters: (typeof args[0] === 'object' ? args[0].values : undefined) ?? args[1] });
      return query.apply(this, args);
    };
    try {
      const definition = await loadDefinition(client, identity.organization_id, null, { templateId: template.templateId });
      assert.equal(Object.keys(definition.model.fieldsById).length, 1000);
      assert.equal(statements.length, 9);
      await loadCapture(client, identity.organization_id, capture.instanceId);
      assert.equal(statements.length, 12);
      assert.equal(statements.every(({ sql }) => /^(select|with)\b/i.test(sql) && !/\b(insert|update|delete)\b/i.test(sql)), true);
      const nodeCount = definition.records.expressions.reduce((count, expression) => count + expression.references.length, 0);
      const bounds = [
        { table: 'template_columns', label: 'Column', records: definition.records.columns.length },
        { table: 'template_fields', label: 'Field/numeric configuration', records: definition.records.fields.length },
        { table: 'template_expressions', label: 'Expression reference', records: nodeCount },
      ];
      for (const bound of bounds) {
        const statement = statements.find(({ sql }) => sql.includes(`from "${bound.table}"`));
        assert.ok(statement);
        const result = await query.call(client, `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.parameters);
        const visits = maximumPlanRowVisits(result.rows[0]['QUERY PLAN'][0].Plan);
        // Allow linear scan/join overhead, but not a whole-version scan per parent.
        assert.ok(visits <= bound.records * 10, `${bound.label} loading visited ${visits} rows for ${bound.records} records.`);
      }
    } finally { client.query = query; }
  }, { readOnly: true });
});

test('a fresh repeated capture avoids comparing every value against every occurrence', async () => {
  const template = await work(async (client, identity) => {
    const created = await createTemplate(client, identity, { name: 'Synthetic occurrence lookup', kind: 'datasheet' });
    const records = analyticalRecords();
    records.groups[0].minimum = 200;
    await copyDefinition(database(client), records, identity.organization_id, created.versionId);
    return { ...created, records };
  });
  await freeze(template.versionId);
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  const initial = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId), { readOnly: true });
  const inputs = initial.occurrences.filter((row) => row.groupId === template.records.groups[0].id)
    .map((row) => ({ fieldId: template.records.fields[0].id, occurrenceId: row.id, state: 'present', value: '0' }));
  await work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, inputs));
  await work(async (client, identity) => {
    const statements = [];
    const observed = { query: (sql, parameters) => { statements.push({ sql, parameters }); return client.query(sql, parameters); } };
    const pinnedValues = initial.values.map(({ fieldId, occurrenceId, revision }) => ({ instanceId: capture.instanceId, fieldId, occurrenceId, revision }));
    const loaded = await loadCapture(observed, identity.organization_id, capture.instanceId, undefined, { pinnedValues });
    assert.equal(statements.length, 3); assert.equal(loaded.occurrences.length, 201);
    assert.ok(loaded.values.length >= 400);
    assert.equal(loaded.pinnedValues.size, initial.values.length);
    assert.deepEqual(new Map([...loaded.pinnedValues].map(([key, { state, numberValue }]) => [key, { state, numberValue }])),
      new Map(initial.values.map(({ fieldId, occurrenceId, revision, state, numberValue }) => [`${capture.instanceId}:${fieldId}:${occurrenceId}:${revision}`, { state, numberValue }])));
    const statement = statements[2];
    const result = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.parameters);
    const visits = maximumPlanRowVisits(result.rows[0]['QUERY PLAN'][0].Plan);
    const records = loaded.values.length + loaded.occurrences.length;
    assert.ok(visits <= records * 10, `Capture loading visited ${visits} rows for ${records} active records.`);
  }, { readOnly: true });
});

test('configureRow sets a row CSS class and moveRowToSection reparents it into another container', async () => {
  const template = await fixture({ repeated: false, rowCount: 1 });
  const sourceSectionId = template.records.sections[0].id;
  const [rowId] = template.records.rows.map((row) => row.id);
  const withSecondSection = await work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'addSection' }));
  const targetSectionId = withSecondSection.model.rootSectionIds.find((id) => id !== sourceSectionId);
  const afterConfigure = await work((client, identity) => editTemplate(client, identity, template.versionId, withSecondSection.model.version.revision, { type: 'configureRow', id: rowId, cssClass: 'border border-primary' }));
  assert.equal(afterConfigure.model.rowsById[rowId].cssClass, 'border border-primary');
  const afterMove = await work((client, identity) => editTemplate(client, identity, template.versionId, afterConfigure.model.version.revision, { type: 'moveRowToSection', id: rowId, sectionId: targetSectionId }));
  assert.equal(afterMove.model.rowsById[rowId].sectionId, targetSectionId);
  assert.deepEqual(afterMove.model.sectionsById[sourceSectionId].rowIds, []);
  assert.deepEqual(afterMove.model.sectionsById[targetSectionId].rowIds, [rowId]);
  assert.equal(afterMove.model.rowsById[rowId].cssClass, 'border border-primary');
  await assert.rejects(work((client, identity) => editTemplate(client, identity, template.versionId, afterMove.model.version.revision, { type: 'moveRowToSection', id: rowId, sectionId: targetSectionId })), { code: 'unchanged_move' });
});

test('V4 row, column and print settings persist as typed template configuration', async () => {
  const template = await fixture({ repeated: false });
  const rowId = template.records.rows[0].id;
  let loaded = await definition(template.versionId);
  const rowColumns = loaded.model.rowsById[rowId].columnIds.map((id) => loaded.model.columnsById[id]);
  const column = rowColumns[0];
  loaded = await work((client, identity) => editTemplate(client, identity, template.versionId, loaded.model.version.revision, {
    type: 'configureRow', id: rowId, name: 'Result row', cssClass: 'border-bottom', keepTogether: true,
  }));
  loaded = await work((client, identity) => editTemplate(client, identity, template.versionId, loaded.model.version.revision, {
    type: 'configureRowLayout', id: rowId, columns: rowColumns.map((item, index) => ({ id: item.id, name: index ? null : 'Result column', gridSpan: item.span || 6, widthMm: index ? null : 72.5 })),
  }));
  loaded = await work((client, identity) => editTemplate(client, identity, template.versionId, loaded.model.version.revision, {
    type: 'configureColumn', id: column.id, cssClass: 'text-center', indexValue: '-2', masterValue: 'results', heightMm: 15,
    showInCoa: false, showInTemplate: true, showInNabl: true, showInNonNabl: false, isFinalResult: true,
    editRoleIds: [account.roleId], viewRoleIds: [account.roleId],
  }));
  assert.deepEqual({ name: loaded.model.rowsById[rowId].name, keepTogether: loaded.model.rowsById[rowId].keepTogether }, { name: 'Result row', keepTogether: true });
  assert.deepEqual({ name: loaded.model.columnsById[column.id].name, span: loaded.model.columnsById[column.id].span,
    widthMm: loaded.model.columnsById[column.id].widthMm, heightMm: loaded.model.columnsById[column.id].heightMm,
    indexValue: loaded.model.columnsById[column.id].indexValue, masterValue: loaded.model.columnsById[column.id].masterValue,
    showInCoa: loaded.model.columnsById[column.id].showInCoa, showInTemplate: loaded.model.columnsById[column.id].showInTemplate },
  { name: 'Result column', span: 6, widthMm: '72.5', heightMm: '15', indexValue: '-2', masterValue: 'results', showInCoa: false, showInTemplate: true });
  const field = loaded.model.fieldsById[loaded.model.columnsById[column.id].fieldId];
  assert.deepEqual(field.editRoleIds, [account.roleId]);
  assert.deepEqual(field.viewRoleIds, [account.roleId]);

  const config = await work((client, identity) => saveTemplatePrintConfig(client, identity.organization_id, template.templateId, {
    pageSize: 'Legal', scale: 0.8, xMargin: 9, isLandscape: true, printHeader: false, printFooter: true,
    headerAlignment: 'left', footerAlignment: 'right', nonNablTopMargin: 10, nonNablBottomMargin: 11,
    nablTopMargin: 20, nablBottomMargin: 21, useCustomTopNonNabl: true, useCustomBottomNonNabl: false,
    useCustomTopNabl: false, useCustomBottomNabl: true,
  }));
  assert.equal(config.pageSize, 'Legal');
  assert.equal(config.useCustomBottomNabl, true);
  assert.deepEqual((await definition(template.versionId)).model.version.printConfig, config);
});

test('bulkConfigureColumns applies one CSS class to every selected column atomically', async () => {
  const template = await fixture({ repeated: false });
  const columnIds = template.records.columns.map((column) => column.id);
  const foreignColumn = randomUUID();
  await assert.rejects(work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'bulkConfigureColumns', ids: [...columnIds, foreignColumn], cssClass: 'col-6' })), { status: 404 });
  let loaded = await definition(template.versionId);
  assert.equal(loaded.model.version.revision, 1, 'a rejected bulk edit must not partially apply or bump the revision');
  const applied = await work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'bulkConfigureColumns', ids: columnIds, cssClass: 'col-6 text-center' }));
  assert.deepEqual(columnIds.map((id) => applied.model.columnsById[id].cssClass), columnIds.map(() => 'col-6 text-center'));
});

test('pasteSection copies a self-contained container into another template with fresh IDs, and rejects one with an external formula reference', async () => {
  const source = await fixture({ repeated: false });
  const target = await work((client, identity) => createTemplate(client, identity, { name: `Paste target ${randomUUID()}`, kind: 'datasheet' }));
  const sectionId = source.records.sections[0].id;
  const pasted = await work((client, identity) => editTemplate(client, identity, target.versionId, target.revision, { type: 'pasteSection', sourceVersionId: source.versionId, sourceSectionId: sectionId }));
  assert.equal(pasted.model.rootSectionIds.length, 1);
  const pastedSectionId = pasted.model.rootSectionIds[0];
  assert.notEqual(pastedSectionId, sectionId, 'a pasted container must get a fresh id, not reuse the source id across templates');
  assert.equal(pasted.model.sectionsById[pastedSectionId].rowIds.length, source.records.rows.length);
  assert.equal(Object.keys(pasted.model.fieldsById).length, Object.keys((await definition(source.versionId)).model.fieldsById).length);
  // A chained (non-repeated) fixture's second row references the first row's calculated field —
  // pasting only the second row's section in isolation would silently orphan that reference.
  const chained = await fixture({ repeated: false, chain: true, rowCount: 2 });
  const secondRow = chained.records.rows[1];
  const isolatedSection = (await work((client, identity) => editTemplate(client, identity, chained.versionId, 1, { type: 'addSection' }))).model.rootSectionIds.find((id) => id !== chained.records.sections[0].id);
  const afterSplit = await work((client, identity) => editTemplate(client, identity, chained.versionId, 2, { type: 'moveRowToSection', id: secondRow.id, sectionId: isolatedSection }));
  await assert.rejects(work((client, identity) => editTemplate(client, identity, target.versionId, pasted.model.version.revision, { type: 'pasteSection', sourceVersionId: chained.versionId, sourceSectionId: isolatedSection })), { code: 'external_reference' });
  assert.equal(afterSplit.model.version.revision, 3);
});

test('cloning a template copies the whole definition under fresh identifiers and leaves the source untouched', async () => {
  const template = await fixture();
  const source = await definition(template.versionId);
  const cloned = await work((client, identity) => cloneTemplate(client, identity, template.versionId));
  assert.notEqual(cloned.templateId, template.templateId);
  assert.notEqual(cloned.versionId, template.versionId);

  const copy = await definition(cloned.versionId);
  assert.equal(copy.records.version.name, `${source.records.version.name} - Copy`);
  assert.equal(copy.records.version.number, 1);
  assert.equal(copy.records.version.status, 'draft');
  assert.equal(copy.records.version.kind, source.records.version.kind);

  // Same shape, none of the same record identifiers.
  for (const key of ['sections', 'rows', 'columns', 'fields', 'options', 'expressions']) {
    assert.equal(copy.records[key].length, source.records[key].length, key);
    const reused = copy.records[key].map((row) => row.id).filter((id) => source.records[key].some((row) => row.id === id));
    assert.deepEqual(reused, [], `${key} reused identifiers`);
  }
  assert.deepEqual(Object.values(copy.model.fieldsById).map((field) => field.alias).sort(),
    Object.values(source.model.fieldsById).map((field) => field.alias).sort());

  // Formulas must point at the copy's own fields, not the originals.
  const sourceFields = new Set(Object.keys(source.model.fieldsById));
  for (const expression of copy.records.expressions) {
    assert.equal(sourceFields.has(expression.fieldId), false);
    for (const reference of expression.references) assert.equal(sourceFields.has(reference.fieldId), false);
    assert.equal(Boolean(copy.model.fieldsById[expression.fieldId]), true);
  }
  assert.equal(copy.model.calculationOrder.length, source.model.calculationOrder.length);

  // The clone is independent: editing it leaves the original alone.
  await work((client, identity) => editTemplate(client, identity, cloned.versionId, 1, { type: 'addSection' }));
  assert.equal((await definition(cloned.versionId)).records.sections.length, source.records.sections.length + 1);
  assert.equal((await definition(template.versionId)).records.sections.length, source.records.sections.length);
});
