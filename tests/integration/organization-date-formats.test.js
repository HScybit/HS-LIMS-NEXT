import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { customFieldDateFormats, customFieldDateTimeFormats } from '../../src/masters/custom-field-config.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });
const base = { autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null };
async function account(options = {}) {
  const user = await createAccount(owner, { permissions: ['settings.manage'], ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
const read = async (user) => (await work(user, loadLaboratorySettings, true)).settings;
const save = (user, input) => work(user, (client, identity) => saveLaboratorySettings(client, identity, { ...base, ...input }));

test('absent settings stay absent on read; independent fields and older saves retain their recorded values', async () => {
  const user = await account();
  const initial = await read(user); assert.equal(initial.revision, 0); assert.equal(initial.dateFormat, null); assert.equal(initial.datetimeFormat, null);
  assert.equal((await owner.query('SELECT 1 FROM organization_laboratory_settings WHERE organization_id=$1', [user.organizationId])).rowCount, 0);
  let queries = 0;
  await work(user, (client, identity) => saveLaboratorySettings({ query: (...args) => { queries++; return client.query(...args); } }, identity,
    { ...base, revision: 0, dateFormat: 'DD-MM-YYYY', selfAllocationEnabled: true }));
  assert.equal(queries, 3);
  const first = await read(user); assert.equal(first.dateFormat, 'DD-MM-YYYY'); assert.equal(first.datetimeFormat, null); assert.equal(first.updatedBy, user.userId);
  assert(first.updatedAt instanceof Date);
  await save(user, { revision: 1, datetimeFormat: '  YYYY [year] HH:mm Z  ' });
  await save(user, { revision: 2 });
  queries = 0;
  const { settings } = await work(user, (client, identity) => loadLaboratorySettings({ query: (...args) => { queries++; return client.query(...args); } }, identity), true);
  assert.equal(queries, 3); assert.equal(settings.revision, 3); assert.equal(settings.dateFormat, first.dateFormat);
  assert.equal(settings.datetimeFormat, '  YYYY [year] HH:mm Z  '); assert.equal(settings.selfAllocationEnabled, true);
});

test('all source choices, custom formats, null and empty settings round-trip without normalization', async () => {
  const user = await account(); let revision = 0;
  await work(user, async (client, identity) => {
    for (let index = 0; index < customFieldDateTimeFormats.length; index++) {
      const dateFormat = customFieldDateFormats[index % customFieldDateFormats.length].value;
      const datetimeFormat = customFieldDateTimeFormats[index].value;
      ({ revision } = await saveLaboratorySettings(client, identity, { ...base, revision, dateFormat, datetimeFormat }));
      const { settings } = await loadLaboratorySettings(client, identity);
      assert.equal(settings.dateFormat, dateFormat); assert.equal(settings.datetimeFormat, datetimeFormat);
    }
  });
  await save(user, { revision: revision++, dateFormat: 'x'.repeat(40), datetimeFormat: 'x'.repeat(60) });
  const custom = await read(user); assert.equal(custom.dateFormat, 'x'.repeat(40)); assert.equal(custom.datetimeFormat, 'x'.repeat(60));
  await save(user, { revision: revision++, dateFormat: null, datetimeFormat: '' });
  await save(user, { revision });
  const cleared = await read(user); assert.equal(cleared.dateFormat, null); assert.equal(cleared.datetimeFormat, '');
});

test('date settings require management permission and preserve tenant, actor and timestamp boundaries', async () => {
  const user = await account(); const viewer = await account({ organizationId: user.organizationId, permissions: ['settings.read'] });
  const foreign = await account(); const denied = await account({ organizationId: user.organizationId, permissions: ['templates.read'] });
  await save(user, { revision: 0, dateFormat: 'YYYY/MM/DD' });
  assert.equal((await read(viewer)).dateFormat, 'YYYY/MM/DD'); assert.equal((await read(foreign)).dateFormat, null);
  await assert.rejects(read(denied), { code: 'forbidden' });
  await assert.rejects(save(viewer, { revision: 1, dateFormat: '' }), { code: 'forbidden' });
  assert.equal((await work(foreign, (client) => client.query('SELECT date_format FROM organization_laboratory_settings WHERE organization_id=$1', [user.organizationId]), true)).rowCount, 0);
  assert.equal((await work(foreign, (client) => client.query("UPDATE organization_laboratory_settings SET date_format='YYYY',revision=revision+1,updated_by=$2,updated_at=now() WHERE organization_id=$1", [user.organizationId, foreign.userId]))).rowCount, 0);
  for (const [actor, timestamp] of [[viewer.userId, 'now()'], [user.userId, "now()-interval '1 second'"]]) {
    await assert.rejects(work(user, (client) => client.query(`UPDATE organization_laboratory_settings SET date_format='YYYY',revision=revision+1,updated_by=$2,updated_at=${timestamp} WHERE organization_id=$1`,
      [user.organizationId, actor])), { code: '42501' });
  }
  assert.equal((await read(user)).revision, 1);
});

test('concurrent first and later saves admit one revision and retain the winning format', async () => {
  const user = await account();
  for (const revision of [0, 1]) {
    const outcomes = await Promise.allSettled(['DD/MM/YYYY', 'YYYY-MM-DD'].map((dateFormat) => save(user, { revision, dateFormat })));
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find((result) => result.status === 'rejected').reason.code, 'stale_settings');
    const settings = await read(user); assert.equal(settings.revision, revision + 1);
    assert.equal(settings.dateFormat, ['DD/MM/YYYY', 'YYYY-MM-DD'][outcomes.findIndex((result) => result.status === 'fulfilled')]);
    await assert.rejects(save(user, { revision, datetimeFormat: 'HH:mm' }), { code: 'stale_settings' });
    assert.deepEqual(await read(user), settings);
  }
});

test('SQL length constraints and invalid API input leave the saved settings unchanged', async () => {
  const user = await account(); await save(user, { revision: 0, dateFormat: 'YYYY-MM-DD', datetimeFormat: 'HH:mm' });
  const original = await read(user);
  for (const [column, maximum, constraint] of [['date_format', 40, 'lab_settings_date_format'], ['datetime_format', 60, 'lab_settings_datetime_format']]) {
    await assert.rejects(work(user, (client, identity) => client.query(`UPDATE organization_laboratory_settings SET ${column}=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE organization_id=$3`,
      ['x'.repeat(maximum + 1), identity.user_id, identity.organization_id])), { code: '23514', constraint });
  }
  for (const input of [{ dateFormat: false }, { datetimeFormat: 'x'.repeat(61) }, { dateFormat: '\0' }, { datetimeFormat: undefined }]) {
    await assert.rejects(save(user, { revision: 1, ...input }), { code: 'invalid_date_format' });
  }
  assert.deepEqual(await read(user), original);
});
