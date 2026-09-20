import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool } from '../helpers/database.js';
import { agreementAccount, agreementWork as work, serviceAgreementFixture, serviceAgreementCommand } from '../helpers/service-agreements.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { closePool } from '../../src/db/pool.js';
import { loadServiceAgreement, saveServiceAgreement, retireServiceAgreement } from '../../src/masters/service-agreements.js';
import { readServiceAgreementFile, uploadServiceAgreementFile } from '../../src/masters/service-agreement-files.js';
import { serviceAgreementFileByteLimit, serviceAgreementFileMediaTypes } from '../../src/masters/service-agreement-file-config.js';
import { saveVendor, retireVendor } from '../../src/masters/vendors.js';
import { saveInstrumentCore, retireInstrumentCore } from '../../src/instruments/core.js';
import { updateRole } from '../../src/roles/service.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const fixture = () => serviceAgreementFixture(owner);
const save = (actor, input) => work(actor, (client, identity) => saveServiceAgreement(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadServiceAgreement(client, identity, id, options), true);
const retire = (actor, input) => work(actor, (client, identity) => retireServiceAgreement(client, identity, input));
const upload = (actor, input) => work(actor, (client, identity) => uploadServiceAgreementFile(client, identity, input));
const file = (actor, id) => work(actor, (client, identity) => readServiceAgreementFile(client, identity, id), true);
const command = record => ({ id: record.id, revision: record.revision, requestId: randomUUID() });

test('Agreement history keeps observed labels, order, zero, false and exact partial date retries after later edits', async () => {
  const context = await fixture(); const { actor } = context;
  const original = serviceAgreementCommand(context, { instrumentIds: context.instruments.map(item => item.id).reverse(), includedServices: ['breakdown', 'calibration'] });
  const first = await save(actor, original);
  assert.equal(first.cost, '0.00'); assert.equal(first.noOfServices, 0); assert.equal(first.inEffect, false); assert.equal(first.savedBy, actor.userId);
  assert.deepEqual(first.instrumentIds, original.instrumentIds); assert.deepEqual(first.includedServices, original.includedServices);
  assert.equal(first.vendorRevision, 1); assert.equal(first.instruments[0].revision, 1);
  await work(actor, (client, identity) => saveVendor(client, identity, { ...command(context.vendor), name: 'Later Vendor label' }));
  await work(actor, (client, identity) => saveInstrumentCore(client, identity, { ...command(context.instruments[1]), name: 'Later Instrument label' }));
  const current = await load(actor, first.id); assert.equal(current.vendorName, 'Later Vendor label'); assert.equal(current.instruments[0].name, 'Later Instrument label');
  assert.deepEqual(await load(actor, first.id, { atRevision: 1 }), first);
  const partial = { ...command(first), startDate: '2026-09-01' }; const second = await save(actor, partial);
  assert.equal(second.vendorRevision, 2); assert.equal(second.vendorName, 'Later Vendor label'); assert.deepEqual(second.instruments, first.instruments);
  const third = await save(actor, { ...command(second), startDate: '2026-01-01', endDate: '2026-06-30', includedServices: [] });
  assert.deepEqual(third.includedServices, []); assert.deepEqual(third.instruments, first.instruments);
  assert.deepEqual(await save(actor, partial), second); assert.deepEqual(await save(actor, original), first);
  await assert.rejects(save(actor, { ...partial, startDate: '2026-10-01' }), { code: 'save_request_reused' });
  await assert.rejects(save(actor, { ...partial, requestId: randomUUID() }), { code: 'stale_service_agreement' });
  const removal = command(third); const removed = await retire(actor, removal);
  assert.deepEqual(await retire(actor, removal), removed); assert.deepEqual(await save(actor, partial), second);
  await assert.rejects(load(actor, first.id), { code: 'service_agreement_not_found' });
  assert.equal((await load(actor, first.id, { atRevision: 4 })).retired, true);
});

test('Agreement-only access exposes narrow inactive-inclusive catalogs and denies raw, spoofed, foreign and revoked access', async () => {
  const context = await fixture(); const { actor } = context; const foreign = await fixture();
  const editor = await agreementAccount(owner, { organizationId: actor.organizationId });
  const reader = await agreementAccount(owner, { organizationId: actor.organizationId, permissions: ['masters.read'] });
  const denied = await agreementAccount(owner, { organizationId: actor.organizationId });
  context.modules[3].userIds.push(editor.userId, reader.userId); await saveModuleAccessSettings(actor, context.modules);
  const record = await save(editor, serviceAgreementCommand(context));
  assert.equal((await load(reader, record.id)).id, record.id);
  await work(editor, async client => {
    assert.equal((await client.query('SELECT * FROM vendors')).rowCount, 0); assert.equal((await client.query('SELECT * FROM instruments')).rowCount, 0);
    const vendors = (await client.query('SELECT * FROM service_agreement_vendor_catalog')).rows;
    assert.equal(vendors.length, 1); assert.equal(vendors[0].active, false);
    const instruments = (await client.query('SELECT * FROM service_agreement_instrument_catalog ORDER BY active')).rows;
    assert.equal(instruments.length, 2); assert.equal(instruments[0].active, false);
  }, true);
  await assert.rejects(save(reader, serviceAgreementCommand(context)), { status: 403 });
  await assert.rejects(work(reader, client => client.query('SELECT service_agreements_require_writer()')), { code: '42501' });
  await assert.rejects(load(denied, record.id), { code: 'service_agreement_module_access_required' });
  await work(denied, async client => {
    assert.equal((await client.query('SELECT * FROM service_agreements')).rowCount, 0);
    assert.equal((await client.query('SELECT * FROM service_agreement_instrument_catalog')).rowCount, 0);
  }, true);
  await assert.rejects(load(foreign.actor, record.id), { code: 'service_agreement_not_found' });
  await assert.rejects(save(editor, serviceAgreementCommand(context, { vendorId: foreign.vendor.id })), { code: 'invalid_agreement_reference' });
  await assert.rejects(save(editor, serviceAgreementCommand(context, { instrumentIds: [foreign.instruments[0].id] })), { code: 'invalid_agreement_reference' });
  await assert.rejects(work(denied, async client => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [editor.userId]); await client.query('SELECT service_agreements_require_writer()');
  }), { code: '42501' });
  for (const table of ['service_agreements', 'service_agreement_versions', 'service_agreement_version_instruments', 'service_agreement_version_services']) {
    await assert.rejects(work(editor, client => client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [actor.organizationId])), { code: '42501' });
  }
  context.modules[3].userIds = [actor.userId]; await saveModuleAccessSettings(actor, context.modules);
  await assert.rejects(load(reader, record.id), { status: 403 });
  await assert.rejects(save(editor, { ...command(record), notes: 'Revoked' }), { status: 403 });
});

test('Agreement files enforce source MIME/size bounds, immutable retries and current access to historically bound bytes', async () => {
  const context = await fixture(); const { actor } = context;
  const reader = await agreementAccount(owner, { organizationId: actor.organizationId, permissions: ['masters.read'] });
  const other = await agreementAccount(owner, { organizationId: actor.organizationId });
  context.modules[3].userIds.push(reader.userId, other.userId); await saveModuleAccessSettings(actor, context.modules);
  const input = { requestId: randomUUID(), originalName: 'Synthetic agreement.pdf', mediaType: 'application/pdf', content: Buffer.alloc(serviceAgreementFileByteLimit, 65) };
  const attachment = await upload(actor, input); assert.equal(attachment.byteLength, serviceAgreementFileByteLimit);
  assert.equal(attachment.uploadedBy, actor.userId); assert.equal((await upload(actor, input)).replayed, true);
  await assert.rejects(file(reader, attachment.id), { code: 'attachment_not_found' });
  await assert.rejects(upload(other, input), { code: 'attachment_request_reused' });
  await assert.rejects(upload(actor, { ...input, content: Buffer.from('Changed') }), { code: 'attachment_request_reused' });
  await assert.rejects(upload(actor, { ...input, requestId: randomUUID(), content: Buffer.alloc(serviceAgreementFileByteLimit + 1) }), { status: 413 });
  for (const mediaType of serviceAgreementFileMediaTypes) assert.equal((await upload(actor, { requestId: randomUUID(), originalName: 'Synthetic', mediaType, content: Buffer.from('x') })).mediaType, mediaType);
  await assert.rejects(upload(actor, { ...input, requestId: randomUUID(), content: Buffer.alloc(0) }), { code: 'empty_attachment' });
  await assert.rejects(upload(actor, { ...input, requestId: randomUUID(), mediaType: 'text/html' }), { status: 415 });
  const saved = await save(actor, serviceAgreementCommand(context, { attachmentFileId: attachment.id }));
  assert.deepEqual((await file(reader, attachment.id)).content, input.content);
  const omitted = await save(actor, { ...command(saved), notes: 'Keep attachment' }); assert.equal(omitted.attachmentFileId, attachment.id);
  const cleared = await save(actor, { ...command(omitted), attachmentFileId: null }); assert.equal(cleared.attachment, null);
  await retire(actor, command(cleared)); assert.equal((await load(reader, saved.id, { atRevision: 1 })).attachment.id, attachment.id);
  assert.deepEqual((await file(reader, attachment.id)).content, input.content);
  await assert.rejects(owner.query('UPDATE service_agreement_files SET content=$1 WHERE organization_id=$2 AND id=$3', [Buffer.from('Tampered'), actor.organizationId, attachment.id]), { code: '55000' });
  context.modules[3].userIds = [actor.userId]; await saveModuleAccessSettings(actor, context.modules);
  await assert.rejects(file(reader, attachment.id), { status: 403 });
});

test('direct Agreement commands reject malformed relationships and values, and protect history and head completeness', async () => {
  const context = await fixture(); const { actor } = context;
  const record = await save(actor, serviceAgreementCommand(context, { includedServices: ['calibration'] }));
  const id = context.instruments[0].id;
  const malformed = [[[], [], '0'], [[id, id], [], '0'], [[id, null], [], '0'], [[id], [null], '0'], [[id], ['calibration', 'calibration'], '0'],
    [[id], ['inspection'], '0'], [[id], [], '-0.001'], [[id], [], 'NaN'], [[id], [], 'Infinity'], [Array.from({ length: 501 }, () => randomUUID()), [], '0']];
  for (const [instruments, services, cost] of malformed) await assert.rejects(work(actor, client => client.query(
    'SELECT service_agreements_save($1,0,$2,$3,$4,$5,$6,0,$7,NULL,false,NULL,$8::uuid[],$9::text[])',
    [randomUUID(), randomUUID(), 'a'.repeat(64), context.vendor.id, '2026-01-01', '2026-12-31', cost, instruments, services])), { constraint: 'service_agreement_command_input' });
  for (const table of ['service_agreement_versions', 'service_agreement_version_instruments', 'service_agreement_version_services']) {
    await assert.rejects(owner.query(`DELETE FROM ${table} WHERE organization_id=$1`, [actor.organizationId]), { code: '55000' });
  }
  await assert.rejects(owner.query('UPDATE service_agreements SET cost=1 WHERE organization_id=$1 AND id=$2', [actor.organizationId, record.id]), { constraint: 'service_agreement_head_history' });
  assert.equal((await load(actor, record.id)).cost, '0.00');
  assert.equal((await owner.query("SELECT count(*)::integer AS count FROM pg_class WHERE relname IN ('service_agreements','service_agreement_versions','service_agreement_version_instruments','service_agreement_version_services','service_agreement_files') AND relrowsecurity AND relforcerowsecurity")).rows[0].count, 5);
  const privileges = (await owner.query("SELECT proname,has_function_privilege('sampleify_report_worker',oid,'EXECUTE') AS allowed FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'service_agreements_%'")).rows;
  assert(privileges.length); assert(privileges.every(row => !row.allowed));
});

test('out-of-effect Agreements block reference retirement until the Instrument is removed or Agreement retired', async () => {
  const context = await fixture(); const { actor } = context;
  const first = await save(actor, serviceAgreementCommand(context));
  await assert.rejects(work(actor, (client, identity) => retireVendor(client, identity, command(context.vendor))), { code: 'vendor_in_use' });
  await assert.rejects(work(actor, (client, identity) => retireInstrumentCore(client, identity, command(context.instruments[0]))), { code: 'instrument_in_use' });
  const second = await save(actor, { ...command(first), instrumentIds: [context.instruments[1].id] });
  await work(actor, (client, identity) => retireInstrumentCore(client, identity, command(context.instruments[0])));
  await assert.rejects(save(actor, serviceAgreementCommand(context)), { code: 'invalid_agreement_reference' });
  await retire(actor, command(second));
  await work(actor, (client, identity) => retireVendor(client, identity, command(context.vendor)));
  await work(actor, (client, identity) => retireInstrumentCore(client, identity, command(context.instruments[1])));
  assert.deepEqual(await load(actor, first.id, { atRevision: 1 }), first);
  await assert.rejects(save(actor, serviceAgreementCommand(context)), { code: 'invalid_agreement_reference' });
});

async function lockedRace(firstAction, secondAction) {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let ready; const locked = new Promise(resolve => { ready = resolve; });
  let firstError; let secondPid; let pending;
  const first = firstAction(async () => { ready(); await gate; }).then(value => ({ value }), error => { firstError = error; ready(); return { error }; });
  try {
    await locked; if (firstError) throw firstError;
    let settled = false;
    pending = secondAction(pid => { secondPid = pid; }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    let waiting = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (firstError) throw firstError;
      if (secondPid && (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [secondPid])).rows[0]?.waiting) { waiting = true; break; }
      if (settled) break;
      await delay(10);
    }
    assert(waiting, 'Expected the second restricted operation to wait for the first database writer');
    release(); const firstResult = await first; if (firstResult.error) throw firstResult.error;
    return { first: firstResult.value, second: await pending };
  } finally { release(); await first; if (pending) await pending; }
}

for (const kind of ['Vendor', 'Instrument']) {
  const remove = (context, client, identity) => kind === 'Vendor' ? retireVendor(client, identity, command(context.vendor)) : retireInstrumentCore(client, identity, command(context.instruments[0]));
  test(`Agreement saves wait for ${kind} retirement and reject the committed retired reference`, { timeout: 15000 }, async () => {
    const context = await fixture(); const { actor } = context;
    const race = await lockedRace(
      hold => work(actor, async (client, identity) => { const result = await remove(context, client, identity); await hold(); return result; }),
      pid => work(actor, async (client, identity) => { pid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return saveServiceAgreement(client, identity, serviceAgreementCommand(context)); }),
    );
    assert.equal(race.second.error?.code, 'invalid_agreement_reference');
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM service_agreements WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 0);
  });

  test(`${kind} retirement waits for the first Agreement capture and rejects its committed reference`, { timeout: 15000 }, async () => {
    const context = await fixture(); const { actor } = context;
    const race = await lockedRace(
      hold => work(actor, async (client, identity) => { const result = await saveServiceAgreement(client, identity, serviceAgreementCommand(context)); await hold(); return result; }),
      pid => work(actor, async (client, identity) => { pid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return remove(context, client, identity); }),
    );
    assert.equal(race.second.error?.code, kind === 'Vendor' ? 'vendor_in_use' : 'instrument_in_use');
    assert.equal((await load(actor, race.first.id)).id, race.first.id);
    const table = kind === 'Vendor' ? 'vendors' : 'instruments'; const id = kind === 'Vendor' ? context.vendor.id : context.instruments[0].id;
    assert.equal((await owner.query(`SELECT retired FROM ${table} WHERE organization_id=$1 AND id=$2`, [actor.organizationId, id])).rows[0].retired, false);
  });
}

test('Agreement saves wait for settings and Role writers and reject their committed access revocations', { timeout: 20000 }, async () => {
  for (const kind of ['settings', 'role']) {
    const context = await fixture(); const { actor } = context;
    const editor = await agreementAccount(owner, { organizationId: actor.organizationId });
    context.modules[3].userIds.push(editor.userId); await saveModuleAccessSettings(actor, context.modules);
    const race = await lockedRace(
      hold => work(actor, async (client, identity) => {
        if (kind === 'settings') {
          const { settings } = await loadLaboratorySettings(client, identity);
          await saveLaboratorySettings(client, identity, { revision: settings.revision, autoCreateJobs: false, moduleAccess: emptyModuleAccess() });
        } else await updateRole(client, identity, { id: editor.roleId, revision: 0, requestId: randomUUID(), name: 'Revoked Agreement editor', permissionCodes: [] });
        await hold();
      }),
      pid => work(editor, async (client, identity) => { pid((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return saveServiceAgreement(client, identity, serviceAgreementCommand(context)); }),
    );
    assert.equal(race.second.error?.status, 403);
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM service_agreements WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 0);
  }
});
