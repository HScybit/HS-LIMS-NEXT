import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createAnalyticalTemplate } from '../helpers/templates.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { freezeTemplate } from '../../src/templates/authoring.js';
import { createCapture, saveCapture, changeRepeat } from '../../src/templates/capture.js';
import { loadCapture, loadCaptures } from '../../src/templates/loader.js';
import { requireCaptureWrite } from '../../src/templates/access.js';

const owner = ownerPool(); let account;
const work = (callback, options = {}) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
before(async () => {
  account = await createAccount(owner, { permissions: ['templates.manage', 'datasheets.execute'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
});
after(async () => { await closePool(); await owner.end(); });

async function fixture() {
  const template = await work((client, identity) => createAnalyticalTemplate(client, identity));
  await work((client, identity) => freezeTemplate(client, identity, template.versionId, 1));
  const capture = await work((client, identity) => createCapture(client, identity, template.versionId));
  const loaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId), { readOnly: true });
  return { template, capture, loaded, row: loaded.occurrences.find((row) => row.groupId) };
}

test('a later transaction cannot add a missing value to an already committed capture revision', async () => {
  const { template, capture, row } = await fixture();
  await assert.rejects(work(async (client, identity) => {
    await requireCaptureWrite(client, capture.instanceId);
    await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,number_value,lexical,saved_by)
      VALUES($1,$2,$3,$4,$5,1,'numeric','present','entered',9,'9',$6)`,
    [identity.organization_id, capture.instanceId, template.versionId, template.records.fields[0].id, row.id, identity.user_id]);
  }), { code: '23514' });
});

test('a later transaction cannot backdate repeat creation or removal into a committed capture revision', async () => {
  const { template, capture, row } = await fixture();
  await assert.rejects(work(async (client, identity) => {
    await requireCaptureWrite(client, capture.instanceId);
    await client.query(`INSERT INTO template_occurrences(organization_id,instance_id,version_id,id,group_id,parent_id,position,created_revision)
      VALUES($1,$2,$3,$4,$5,$6,99,1)`, [identity.organization_id, capture.instanceId, template.versionId, randomUUID(), row.groupId, row.parentId]);
  }), { code: '23514' });
  await work((client, identity) => saveCapture(client, identity, capture.instanceId, 1,
    [{ fieldId: template.records.fields[0].id, occurrenceId: row.id, state: 'present', value: '0' }]));
  await assert.rejects(work(async (client, identity) => {
    await requireCaptureWrite(client, capture.instanceId);
    await client.query('UPDATE template_occurrences SET removed_revision=2 WHERE organization_id=$1 AND instance_id=$2 AND id=$3', [identity.organization_id, capture.instanceId, row.id]);
  }), { code: '23514' });
});

test('real save, clone, removal and freeze revisions record immutable actors and full transactions, with atomic rollback', async () => {
  const { template, capture, loaded, row } = await fixture();
  const input = { fieldId: template.records.fields[0].id, occurrenceId: row.id, state: 'present', value: '0' };
  await work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, [input]));
  const cloned = await work((client, identity) => changeRepeat(client, identity, capture.instanceId, 2, { type: 'clone', occurrenceId: row.id, withData: true }));
  const copy = cloned.occurrences.find((item) => !loaded.occurrences.some((prior) => prior.id === item.id));
  await work((client, identity) => changeRepeat(client, identity, capture.instanceId, 3, { type: 'remove', occurrenceId: copy.id }));
  const revisions = async () => (await work((client, identity) => client.query('SELECT * FROM template_capture_revisions WHERE organization_id=$1 AND instance_id=$2 ORDER BY revision', [identity.organization_id, capture.instanceId]), { readOnly: true })).rows;
  const before = await revisions();
  assert.deepEqual(before.map((item) => item.revision), [1, 2, 3, 4]);
  assert.equal(new Set(before.map((item) => item.transaction_id)).size, 4);
  assert.ok(before.every((item) => item.recorded_by === account.userId && item.database_role === 'sampleify_app' && item.status === 'editing'));
  await assert.rejects(work(async (client, identity) => {
    await saveCapture(client, identity, capture.instanceId, 4, [{ ...input, value: '8' }]);
    throw new Error('Synthetic after-revision failure');
  }), /Synthetic after-revision failure/);
  assert.deepEqual(await revisions(), before);
  await work(async (client, identity) => {
    await requireCaptureWrite(client, capture.instanceId);
    await client.query("UPDATE template_instances SET revision=revision+1,status='frozen' WHERE organization_id=$1 AND id=$2", [identity.organization_id, capture.instanceId]);
  });
  assert.equal((await revisions()).at(-1).status, 'frozen');
  await assert.rejects(work((client, identity) => client.query('INSERT INTO template_capture_revisions(organization_id) VALUES($1)', [identity.organization_id])), { code: '42501' });
  await assert.rejects(work((client, identity) => client.query('UPDATE template_capture_revisions SET recorded_by=$1 WHERE organization_id=$2 AND instance_id=$3', [identity.user_id, identity.organization_id, capture.instanceId])), { code: '42501' });
  const foreign = await createAccount(owner, { permissions: ['datasheets.execute'] });
  Object.assign(foreign, await signIn({ identifier: foreign.username, password: foreign.password }));
  assert.equal((await withSession(foreign.token, (client) => client.query('SELECT * FROM template_capture_revisions WHERE instance_id=$1', [capture.instanceId]), { readOnly: true })).rowCount, 0);
});

test('even a newly created revision cannot accept a forged value actor or time', async () => {
  const { template, capture, row } = await fixture();
  const other = await createAccount(owner, { organizationId: account.organizationId });
  for (const [actor, time] of [[other.userId, null], [account.userId, '2000-01-01T00:00:00Z']]) {
    await assert.rejects(work(async (client, identity) => {
      await requireCaptureWrite(client, capture.instanceId);
      await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [identity.organization_id, capture.instanceId]);
      await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,number_value,lexical,saved_by,saved_at)
        VALUES($1,$2,$3,$4,$5,2,'numeric','present','entered',9,'9',$6,coalesce($7::timestamptz,transaction_timestamp()))`,
      [identity.organization_id, capture.instanceId, template.versionId, template.records.fields[0].id, row.id, actor, time]);
    }), { code: '23514' });
  }
});

test('batch reads bound active values before transfer while retaining exact pinned and historical revisions', async () => {
  const first = await fixture();
  const fieldId = first.template.records.fields[0].id;
  const second = await work((client, identity) => createCapture(client, identity, first.template.versionId));
  const secondInitial = await work((client, identity) => loadCapture(client, identity.organization_id, second.instanceId), { readOnly: true });
  const secondRow = secondInitial.occurrences.find((row) => row.groupId);
  await work((client, identity) => saveCapture(client, identity, first.capture.instanceId, 1,
    [{ fieldId, occurrenceId: first.row.id, state: 'present', value: '0' }]));
  const cloned = await work((client, identity) => changeRepeat(client, identity, first.capture.instanceId, 2,
    { type: 'clone', occurrenceId: first.row.id, withData: true }));
  const copy = cloned.occurrences.find((row) => !first.loaded.occurrences.some((original) => original.id === row.id));
  await work((client, identity) => saveCapture(client, identity, first.capture.instanceId, 3,
    [{ fieldId, occurrenceId: first.row.id, state: 'present', value: '9' }]));
  await work((client, identity) => changeRepeat(client, identity, first.capture.instanceId, 4, { type: 'remove', occurrenceId: copy.id }));
  await work((client, identity) => saveCapture(client, identity, second.instanceId, 1,
    [{ fieldId, occurrenceId: secondRow.id, state: 'present', value: '7' }]));
  await work((client, identity) => saveCapture(client, identity, second.instanceId, 2,
    [{ fieldId, occurrenceId: secondRow.id, state: 'empty' }]));
  const pins = [
    { instanceId: first.capture.instanceId, fieldId, occurrenceId: first.row.id, revision: 2 },
    { instanceId: first.capture.instanceId, fieldId, occurrenceId: copy.id, revision: 3 },
  ];
  await work(async (client, identity) => {
    const reads = [];
    const observed = { query: async (...args) => {
      const result = await client.query(...args);
      reads.push(result.rows);
      return result;
    } };
    const batch = await loadCaptures(observed, identity.organization_id,
      [{ instanceId: second.instanceId, revision: 2 }, { instanceId: first.capture.instanceId, revision: 5 }], { pinnedValues: pins });
    assert.equal(reads.length, 3); assert.equal(batch.metrics.queryCount, 3);
    assert.equal(batch.captures.size, 2);
    const current = batch.captures.get(first.capture.instanceId);
    const prior = batch.captures.get(second.instanceId);
    assert.equal(current.values.find((value) => value.fieldId === fieldId && value.occurrenceId === first.row.id).numberValue, '9');
    assert.equal(prior.values.find((value) => value.fieldId === fieldId && value.occurrenceId === secondRow.id).numberValue, '7');
    assert.equal(current.occurrences.some((row) => row.id === copy.id), false);
    assert.equal(current.values.some((value) => value.occurrenceId === copy.id), false);
    for (const pin of pins) {
      const value = batch.pinnedValues.get(`${pin.instanceId}:${pin.fieldId}:${pin.occurrenceId}:${pin.revision}`);
      assert.equal(value.numberValue, '0'); assert.equal(value.revision, pin.revision);
    }
    // Removed rows must not consume the SQL result limit before the loader discards them.
    assert.equal(reads[2].length, current.values.length + prior.values.length + pins.length);
    assert.equal(reads[2].some((value) => !value.pinned && value.instanceId === first.capture.instanceId && value.occurrenceId === copy.id), false);
  }, { readOnly: true });
  const beforeRemoval = await work((client, identity) => loadCapture(client, identity.organization_id, first.capture.instanceId, 3), { readOnly: true });
  assert.equal(beforeRemoval.occurrences.some((row) => row.id === copy.id), true);
  assert.equal(beforeRemoval.values.find((value) => value.fieldId === fieldId && value.occurrenceId === copy.id).numberValue, '0');
  assert.equal(beforeRemoval.values.find((value) => value.fieldId === fieldId && value.occurrenceId === first.row.id).numberValue, '0');
  const secondCurrent = await work((client, identity) => loadCapture(client, identity.organization_id, second.instanceId), { readOnly: true });
  assert.equal(secondCurrent.values.find((value) => value.fieldId === fieldId && value.occurrenceId === secondRow.id).state, 'empty');
  await assert.rejects(work((client, identity) => loadCaptures(client, identity.organization_id,
    [{ instanceId: first.capture.instanceId, revision: 2 }], { pinnedValues: [pins[1]] }), { readOnly: true }), { code: 'invalid_pinned_values' });
  await assert.rejects(work((client, identity) => loadCaptures(client, identity.organization_id,
    [{ instanceId: second.instanceId }], { pinnedValues: pins }), { readOnly: true }), { code: 'invalid_pinned_values' });
});
