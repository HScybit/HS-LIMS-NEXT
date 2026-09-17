import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveInstrumentCore, loadInstrumentCore, retireInstrumentCore } from '../../src/instruments/core.js';
import { instrumentCoreInput, instrumentCoreFields } from '../../src/instruments/input.js';
import { instrumentCustomFields, saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { generateInstrumentCustomFields } from '../../src/instruments/custom-field-generation.js';
import { instrumentFieldLookupOptions, instrumentFieldUserOptions } from '../../src/instruments/custom-field-options.js';
import { uploadInstrumentFieldAttachment, readInstrumentFieldAttachment } from '../../src/instruments/custom-field-attachments.js';
import { uploadCustomFieldAttachment } from '../../src/custom-fields/attachments.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture() {
  const setup = await account({ permissions: ['masters.manage', 'settings.manage'] });
  const writer = await account({ organizationId: setup.organizationId, permissions: ['instruments.manage'] });
  const reader = await account({ organizationId: setup.organizationId, permissions: ['instruments.read'] });
  const modules = emptyModuleAccess(); modules[2] = { ...modules[2], enabled: true, userIds: [writer.userId, reader.userId] };
  await saveModuleAccessSettings(setup, modules);
  const laboratoryId = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,'FIELDS','Field laboratory')", [setup.organizationId, laboratoryId]);
  return { setup, writer, reader, modules, laboratoryId };
}
const command = (context, changes) => ({ id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Instrument', code: 'IN-' + randomUUID(),
  laboratoryId: context.laboratoryId, dateOfInstallation: '2026-09-17', allowedUserIds: [context.reader.userId], ...changes });
const field = (context, changes) => work(context.setup, (client, identity) => saveCustomField(client, identity,
  { id: randomUUID(), revision: 0, requestId: randomUUID(), key: 'field', label: 'Instrument field', associatedWith: 'instrument', fieldType: 'text', ...changes }));
const values = (definitions, raw) => definitions.map((definition, index) => ({ fieldId: definition.id, fieldRevision: definition.revision, value: raw[index] }));
const save = (context, input) => work(context.writer, (client, identity) => saveInstrumentCore(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadInstrumentCore(client, identity, id, options), true);
const retireField = (context, definition) => work(context.setup, (client, identity) => retireCustomField(client, identity,
  { id: definition.id, revision: definition.revision, requestId: randomUUID() }));
const upload = (actor, input) => work(actor, (client, identity) => uploadInstrumentFieldAttachment(client, identity, input));
const readFile = (actor, id) => work(actor, (client, identity) => readInstrumentFieldAttachment(client, identity, id), true);

test('Instrument-only editors capture typed fields, resolve generated lookups and preserve exact retries', async () => {
  const context = await fixture(); const source = { id: randomUUID(), sourceId: randomUUID(), requestId: randomUUID(), revision: 0,
    name: 'Instrument lookup', lines: [{ id: 'A', label: 'Alpha' }, { id: 'B', label: false }] };
  await work(context.setup, (client, identity) => saveLookupSourceObservation(client, identity, source));
  const definitions = [];
  for (const [index, definition] of [
    { key: 'serial', scheme: '{{entity.uniqueKey}}/{{scheme_counter}}', splitter: '/' },
    { key: 'choice', fieldType: 'lookup', lookupSourceId: source.id, scheme: 'A' },
    { key: 'copy', scheme: '{{serial}}/{{choice}}/{{total_counter}}' },
    { key: 'numbers', fieldType: 'number', allowsMultiple: true }, { key: 'flag', fieldType: 'checkbox' },
    { key: 'date', fieldType: 'date_time' }, { key: 'users', fieldType: 'multi_user_select' },
  ].entries()) definitions.push(await field(context, { displayOrder: index, ...definition }));
  const raw = ['', '', '', [0, false, 'bad', '0x10'], false, '2026-03-08T02:30', [context.reader.userId]];
  const generation = { instrument: { name: 'Instrument', code: 'KEY' }, customFields: values(definitions, raw), customFieldTimeZone: 'America/New_York' };
  const generated = await work(context.writer, (client, identity) => generateInstrumentCustomFields(client, identity, generation));
  assert.deepEqual(generated.values.map(item => item.value), ['KEY/1', 'A', 'KEY/1/Alpha/1']);
  for (const item of generated.values) generation.customFields.find(value => value.fieldId === item.fieldId).value = item.value;
  const input = command(context, { active: false, customFields: generation.customFields, customFieldTimeZone: generation.customFieldTimeZone });
  const saved = await save(context, input); assert.deepEqual(await save(context, input), saved);
  assert.deepEqual(saved.customFields[3].value, raw[3]); assert.equal(saved.customFields[4].value, false);
  assert.equal(saved.customFields[3].items[2].interpretationState, 'invalid'); assert.equal(saved.customFields[5].timeZone, 'America/New_York');
  assert.equal(saved.customFields[6].items[0].userId, context.reader.userId);
  assert.deepEqual((await work(context.writer, (client, identity) => generateInstrumentCustomFields(client, identity, generation))).values, []);
  const next = await work(context.writer, (client, identity) => generateInstrumentCustomFields(client, identity, { ...generation, customFields: values(definitions, raw) }));
  assert.equal(next.values[0].value, 'KEY/2'); assert.equal(next.values[2].value, 'KEY/2/Alpha/2');
  assert.equal((await work(context.writer, client => client.query('SELECT id FROM custom_field_definitions'), true)).rowCount, 0);
});

test('Instrument required and unique fields cover inactive records, concurrent saves and retired definitions', async () => {
  const context = await fixture(); const definition = await field(context, { isRequired: true, validateUniqueness: true });
  const customFields = values([definition], ['Unique']);
  await assert.rejects(save(context, command(context)), { code: 'instrument_custom_fields_changed' });
  await assert.rejects(save(context, command(context, { customFields: values([definition], ['']) })), { code: 'invalid_custom_field_value' });
  const attempts = await Promise.allSettled([save(context, command(context, { active: false, customFields })), save(context, command(context, { active: false, customFields }))]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'duplicate_custom_field_value');
  const saved = attempts.find(result => result.status === 'fulfilled').value;
  await retireField(context, definition);
  const edited = await save(context, { id: saved.id, revision: 1, requestId: randomUUID(), name: 'Edited' });
  assert.deepEqual(edited.customFields, saved.customFields);
  await work(context.writer, (client, identity) => retireInstrumentCore(client, identity, { id: saved.id, revision: 2, requestId: randomUUID() }));
  assert.deepEqual((await load(context.writer, saved.id, { atRevision: 3 })).customFields, saved.customFields);
});

test('Instrument scheme counters follow the saved field key when a definition is recreated', async () => {
  const context = await fixture(); const definition = await field(context, { scheme: 'IN/{{scheme_counter}}', splitter: '/' });
  await save(context, command(context, { customFields: values([definition], ['IN/41']) }));
  await retireField(context, definition);
  const replacement = await field(context, { scheme: 'IN/{{scheme_counter}}', splitter: '/' });
  const generated = await work(context.writer, (client, identity) => generateInstrumentCustomFields(client, identity,
    { instrument: {}, customFields: values([replacement], ['']) }));
  assert.equal(generated.values[0].value, 'IN/42');
});

test('Instrument field files preserve original association and saved-key reuse while current record access controls historical reads', async () => {
  const context = await fixture(); let definition = await field(context, { fieldType: 'attachment' });
  const input = { requestId: randomUUID(), fieldId: definition.id, fieldRevision: 1, originalName: 'instrument.txt', mediaType: 'text/plain', content: Buffer.from('Synthetic Instrument file') };
  const file = await upload(context.writer, input); assert.equal((await upload(context.writer, input)).replayed, true);
  await assert.rejects(upload(context.writer, { ...input, content: Buffer.from('Changed bytes') }), { code: 'attachment_request_reused' });
  await assert.rejects(readFile(context.reader, file.id), { code: 'attachment_not_found' });
  const record = await save(context, command(context, { customFields: values([definition], [file.id]) }));
  assert.deepEqual((await readFile(context.reader, file.id)).content, input.content);
  const product = await field(context, { key: 'product_file', associatedWith: 'product', fieldType: 'attachment' });
  const productFile = await work(context.setup, (client, identity) => uploadCustomFieldAttachment(client, identity, { ...input, requestId: randomUUID(), fieldId: product.id }));
  await assert.rejects(save(context, command(context, { customFields: values([definition], [productFile.id]) })), { code: 'invalid_instrument_custom_field_attachment' });
  definition = await field(context, { id: definition.id, revision: 1, key: 'field', associatedWith: 'product', fieldType: 'attachment' });
  assert.equal((await upload(context.writer, input)).replayed, true);
  assert.deepEqual((await readFile(context.reader, file.id)).content, input.content);
  await retireField(context, definition);
  const replacement = await field(context, { fieldType: 'attachment' });
  const customFields = values([replacement], [file.id]);
  const edited = await save(context, { id: record.id, revision: 1, requestId: randomUUID(), customFields });
  assert.equal(edited.customFields[0].items[0].attachmentId, file.id);
  await save(context, { id: record.id, revision: 2, requestId: randomUUID(), allowedUserIds: [context.writer.userId], customFields });
  await assert.rejects(load(context.reader, record.id, { atRevision: 1 }), { code: 'instrument_not_found' });
  await assert.rejects(readFile(context.reader, file.id), { code: 'attachment_not_found' });
  assert.equal((await work(context.reader, client => client.query('SELECT 1 FROM instrument_version_custom_field_values WHERE instrument_id=$1', [record.id]), true)).rowCount, 0);
});

test('Instrument lookup options keep current empty observations and retained unavailable selections distinct from new invalid values', async () => {
  const context = await fixture(); const source = { id: randomUUID(), sourceId: randomUUID(), requestId: randomUUID(), revision: 0,
    name: 'Choices', lines: [{ id: 'zero', label: 0 }, { id: 'false', label: false }] };
  await work(context.setup, (client, identity) => saveLookupSourceObservation(client, identity, source));
  const definition = await field(context, { fieldType: 'lookup', lookupSourceId: source.id });
  const options = input => work(context.writer, (client, identity) => instrumentFieldLookupOptions(client, identity, input), true);
  assert.deepEqual((await options({ sourceId: source.id })).options, [{ value: 'zero', label: 0 }, { value: 'false', label: false }]);
  const saved = await save(context, command(context, { customFields: values([definition], ['zero']) }));
  await work(context.setup, (client, identity) => saveLookupSourceObservation(client, identity, { ...source, revision: 1, requestId: randomUUID(), lines: [] }));
  assert.deepEqual(await options({ sourceId: source.id, revision: 1, knownOrganizationId: context.writer.organizationId }),
    { organizationId: context.writer.organizationId, sourceId: source.id, revision: 2, options: [] });
  const edited = await save(context, { id: saved.id, revision: 1, requestId: randomUUID(), customFields: values([definition], ['zero']) });
  assert.equal(edited.customFields[0].items[0].interpretationState, 'invalid');
  assert.equal((await load(context.writer, saved.id, { atRevision: 1 })).customFields[0].items[0].lookupRevision, 1);
  await assert.rejects(save(context, command(context, { customFields: values([definition], ['zero']) })), { code: 'invalid_instrument_custom_field_lookup' });
  assert.deepEqual((await options({ sourceId: randomUUID() })).options, []);
});

test('Instrument field APIs enforce foreign, master-only and revoked access without granting raw table writes', async () => {
  const context = await fixture(); const definition = await field(context, { fieldType: 'attachment' });
  const input = { requestId: randomUUID(), fieldId: definition.id, fieldRevision: 1, originalName: 'file.txt', mediaType: 'text/plain', content: Buffer.from('Synthetic') };
  const file = await upload(context.writer, input);
  const foreign = await account({ permissions: ['instruments.manage'] });
  for (const actor of [context.setup, foreign]) {
    await assert.rejects(work(actor, (client, identity) => instrumentCustomFields(client, identity)), { status: 403 });
    await assert.rejects(upload(actor, input), { status: 403 });
    await assert.rejects(work(actor, (client, identity) => instrumentFieldUserOptions(client, identity)), { status: 403 });
  }
  const plain = await field(context, { key: 'other' });
  await assert.rejects(upload(context.writer, { ...input, requestId: randomUUID(), fieldId: plain.id }), { code: 'attachment_field_not_found' });
  for (const table of ['instrument_version_custom_fields', 'instrument_version_custom_field_values']) {
    await assert.rejects(work(context.writer, client => client.query(`DELETE FROM ${table}`)), { code: '42501' });
  }
  context.modules[2].enabled = false; await saveModuleAccessSettings(context.setup, context.modules);
  await assert.rejects(readFile(context.writer, file.id), { code: 'instrument_module_access_required' });
  await assert.rejects(upload(context.writer, input), { code: 'instrument_module_access_required' });
  assert.equal((await work(context.writer, client => client.query('SELECT 1 FROM instrument_custom_field_attachments'), true)).rowCount, 0);
});

test('native Instrument saves cannot skip the current fields or commit missing children', async () => {
  const context = await fixture(); await field(context);
  const input = instrumentCoreInput(command(context));
  const args = [input.id, 0, input.requestId, 'a'.repeat(64), ...instrumentCoreFields.map(key => input[key]), input.allowedUserIds, false, ...Array.from({ length: 12 }, () => []), 1, true];
  const execute = values => work(context.writer, async client => {
    await client.query(`SELECT instruments_save(${values.map((_, index) => '$' + (index + 1)).join(',')})`, values);
    await client.query('SET CONSTRAINTS instrument_custom_fields_complete IMMEDIATE');
  });
  await assert.rejects(execute(args), { constraint: 'instrument_custom_field_complete' });
  await assert.rejects(execute([...args.slice(0, 33), 0, false]), { constraint: 'instrument_custom_field_preserve' });
  assert.equal((await owner.query('SELECT 1 FROM instruments WHERE organization_id=$1 AND id=$2', [context.writer.organizationId, input.id])).rowCount, 0);
  const privilege = await work(context.writer, client => client.query("SELECT has_function_privilege(current_user,oid,'EXECUTE') AS allowed FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='instruments_save_core'"), true);
  assert.equal(privilege.rows[0].allowed, false);
});

test('Instrument saves wait for a current definition edit and reject their stale capture', { timeout: 15000 }, async () => {
  const context = await fixture(); const definition = await field(context);
  let release; const gate = new Promise(resolve => { release = resolve; }); let ready; const locked = new Promise(resolve => { ready = resolve; });
  let failure; let pid; let pending;
  const editing = work(context.setup, async (client, identity) => {
    await saveCustomField(client, identity, { id: definition.id, revision: 1, requestId: randomUUID(), key: 'field', label: 'Changed definition', associatedWith: 'instrument', fieldType: 'text' });
    ready(); await gate;
  }).catch(error => { failure = error; ready(); });
  try {
    await locked; if (failure) throw failure;
    pending = work(context.writer, async (client, identity) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return saveInstrumentCore(client, identity, command(context, { customFields: values([definition], ['Old definition']) }));
    }).then(value => ({ value }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (pid && (await owner.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).rowCount) { waiting = true; break; }
      await delay(10);
    }
    assert(waiting); release(); await editing; if (failure) throw failure;
    assert.equal((await pending).error?.code, 'instrument_custom_fields_changed');
    assert.equal((await owner.query('SELECT 1 FROM instruments WHERE organization_id=$1', [context.writer.organizationId])).rowCount, 0);
  } finally { release(); await editing; if (pending) await pending; }
});
