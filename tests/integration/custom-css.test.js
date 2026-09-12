import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadCustomCss, saveCustomCss, loadCurrentCustomCss } from '../../src/report-assets/custom-css.js';
import { createReportAssets } from '../helpers/report-assets.js';

const owner = ownerPool(); let account;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
before(async () => {
  const user = await createAccount(owner, { permissions: ['report_settings.manage'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

test('Custom CSS starts empty and retains every authored revision, clear and actual save evidence', async () => {
  assert.deepEqual(await work(loadCustomCss, { readOnly: true }), { versionId: null, revision: 0, cssContent: '', savedBy: null, updatedAt: null });
  const input = { requestId: randomUUID(), revision: 0, cssContent: '  .report {\r\n color: #005577;\r\n}\n' };
  const saved = await work(async (client, identity) => {
    const result = await saveCustomCss(client, identity, input);
    const evidence = (await client.query('SELECT saved_at=now() AND transaction_id=pg_current_xact_id() AS actual FROM organization_custom_css_versions WHERE organization_id=$1 AND id=$2', [account.organizationId, result.versionId])).rows[0];
    assert.equal(evidence.actual, true); return result;
  });
  assert.equal(saved.revision, 1); assert.equal(saved.savedBy, account.userId); assert.equal(saved.cssContent, input.cssContent.replaceAll('\r\n', '\n'));
  const cleared = await work((client, identity) => saveCustomCss(client, identity, { requestId: randomUUID(), revision: 1, cssContent: '' }));
  assert.equal(cleared.revision, 2); assert.equal(cleared.cssContent, '');
  const old = await work((client, identity) => loadCustomCss(client, identity, { versionId: saved.versionId }), { readOnly: true });
  assert.equal(old.cssContent, saved.cssContent); assert.equal(old.updatedAt.getTime(), saved.updatedAt.getTime());
  await assert.rejects(owner.query('UPDATE organization_custom_css_versions SET css_content=$3 WHERE organization_id=$1 AND id=$2', [account.organizationId, saved.versionId, 'changed']), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM organization_custom_css_versions WHERE organization_id=$1 AND id=$2', [account.organizationId, saved.versionId]), { code: '55000' });
});

test('CSS response retries retain the exact original version while concurrent edits and changed request reuse fail', async () => {
  const previous = await work(loadCustomCss); const input = { requestId: randomUUID(), revision: previous.revision, cssContent: '.report { color: blue; }' };
  const duplicates = await Promise.all([1, 2].map(() => work((client, identity) => saveCustomCss(client, identity, input))));
  assert.equal(duplicates.filter((result) => result.replayed).length, 1); assert.equal(duplicates[0].versionId, duplicates[1].versionId);
  await assert.rejects(work((client, identity) => saveCustomCss(client, identity, { ...input, cssContent: '.changed{}' })), { code: 'custom_css_request_reused' });
  const edits = await Promise.allSettled(['red', 'green'].map((color) => work((client, identity) => saveCustomCss(client, identity,
    { requestId: randomUUID(), revision: input.revision + 1, cssContent: `.report { color: ${color}; }` }))));
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(edits.find((result) => result.status === 'rejected').reason.code, 'stale_custom_css');
  const original = await work((client, identity) => saveCustomCss(client, identity, input));
  assert.equal(original.replayed, true); assert.equal(original.revision, input.revision + 1); assert.equal(original.cssContent, input.cssContent);
});

test('CSS input boundaries and interrupted saves protect history at the service and database command boundaries', async () => {
  const current = await work(loadCustomCss); const input = { requestId: randomUUID(), revision: current.revision, cssContent: '.pending{}' };
  await assert.rejects(work(async (client, identity) => { await saveCustomCss(client, identity, input); throw new Error('Synthetic CSS interruption'); }), /Synthetic CSS interruption/);
  assert.equal((await work(loadCustomCss)).revision, current.revision);
  assert.equal((await work((client, identity) => saveCustomCss(client, identity, input))).replayed, false);
  for (const css of [null, '<STYLE>p{}</STYLE>', '</script>', '< script >', '</ style>', ' '.repeat(1_000_001)]) {
    await assert.rejects(work((client) => client.query('SELECT * FROM report_save_custom_css($1,$2,$3,$4)', [randomUUID(), current.revision + 1, css, []])), { constraint: 'custom_css_input' });
  }
  await assert.rejects(work((client, identity) => saveCustomCss(client, identity, { ...input, savedBy: account.userId })), { code: 'invalid_input' });
  await assert.rejects(work((client, identity) => loadCustomCss(client, identity, { versionId: randomUUID() })), { code: 'custom_css_not_found' });
});

test('CSS permissions, tenant isolation and actor identity apply to current reads, historical reads, retries and direct writes', async () => {
  const current = await work(loadCustomCss);
  for (const options of [{ organizationId: account.organizationId, permissions: ['report_settings.read'] }, { organizationId: account.organizationId, permissions: ['templates.read'] },
    { permissions: ['report_settings.manage'] }, { organizationId: account.organizationId, permissions: ['report_settings.manage'] }]) {
    const user = await createAccount(owner, options); const session = await signIn({ identifier: user.username, password: user.password });
    const run = (callback) => withSession(session.token, callback, { csrfToken: session.csrfToken });
    if (options.permissions[0] === 'templates.read') {
      await assert.rejects(run(loadCustomCss), { code: 'forbidden' });
      assert.equal((await run((client) => client.query('SELECT id FROM organization_custom_css_versions'))).rowCount, 0);
    } else if (user.organizationId !== account.organizationId) {
      assert.equal((await run(loadCustomCss)).revision, 0);
      await assert.rejects(run((client, identity) => loadCustomCss(client, identity, { versionId: current.versionId })), { code: 'custom_css_not_found' });
      assert.equal((await run((client) => client.query('SELECT id FROM organization_custom_css_versions WHERE id=$1', [current.versionId]))).rowCount, 0);
    } else if (options.permissions[0] === 'report_settings.read') {
      assert.equal((await run(loadCustomCss)).cssContent, current.cssContent);
      await assert.rejects(run((client, identity) => saveCustomCss(client, identity, { requestId: randomUUID(), revision: current.revision, cssContent: '' })), { code: 'forbidden' });
      await assert.rejects(run((client) => client.query('SELECT * FROM report_save_custom_css($1,$2,$3,$4)', [randomUUID(), current.revision, '', []])), { code: '42501' });
    } else {
      await assert.rejects(run((client, identity) => saveCustomCss(client, identity, { requestId: current.versionId, revision: current.revision - 1, cssContent: current.cssContent })), { code: 'custom_css_request_reused' });
      const saved = await run((client, identity) => saveCustomCss(client, identity, { requestId: randomUUID(), revision: current.revision, cssContent: '' }));
      assert.equal(saved.savedBy, user.userId);
    }
  }
  await assert.rejects(work((client) => client.query('INSERT INTO organization_custom_css_versions(organization_id,id,revision,css_content,saved_by,transaction_id) VALUES($1,$2,1,$3,$4,pg_current_xact_id())',
    [account.organizationId, randomUUID(), '.forged{}', account.userId])), { code: '42501' });
});

test('stylesheet image links share the actual save transaction and cannot be changed or added later', async () => {
  const current = await work(loadCustomCss); const assets = await work(createReportAssets);
  const input = { requestId: randomUUID(), revision: current.revision, cssContent: `.report{--logo:url('${assets.image.url}');background:var(--logo)}` };
  const saved = await work((client, identity) => saveCustomCss(client, identity, input));
  assert.deepEqual((await work((client) => client.query('SELECT image_id FROM organization_custom_css_images WHERE version_id=$1', [saved.versionId]))).rows, [{ image_id: assets.image.id }]);
  assert.equal((await work((client, identity) => saveCustomCss(client, identity, input))).replayed, true);
  await assert.rejects(work((client) => client.query('SELECT * FROM report_save_custom_css($1,$2,$3,$4)', [saved.versionId, current.revision, input.cssContent, []])), { constraint: 'custom_css_request_reused' });
  for (const statement of ['DELETE FROM organization_custom_css_images WHERE version_id=$1', 'UPDATE organization_custom_css_images SET image_id=image_id WHERE version_id=$1']) {
    await assert.rejects(owner.query(statement, [saved.versionId]), { code: '55000' });
  }
  const other = await work(createReportAssets);
  await assert.rejects(owner.query('INSERT INTO organization_custom_css_images(organization_id,version_id,image_id) VALUES($1,$2,$3)', [account.organizationId, saved.versionId, other.image.id]), { code: '23514' });
  await assert.rejects(work((client) => client.query('INSERT INTO organization_custom_css_images(organization_id,version_id,image_id) VALUES($1,$2,$3)', [account.organizationId, saved.versionId, other.image.id])), { code: '42501' });
  await assert.rejects(work((client, identity) => saveCustomCss(client, identity, { requestId: randomUUID(), revision: saved.revision,
    cssContent: `.report{background:url('/api/report-assets/images/${randomUUID()}')}` })), { code: 'custom_css_images' });
});

test('organization members receive only the current stylesheet and bound images without settings access', async () => {
  const member = await createAccount(owner, { organizationId: account.organizationId, permissions: ['templates.read'] });
  const session = await signIn({ identifier: member.username, password: member.password });
  const run = (callback) => withSession(session.token, callback, { readOnly: true });
  const current = await work(loadCustomCss); const visible = await run(loadCurrentCustomCss);
  assert.equal(visible.versionId, current.versionId); assert.match(visible.cssContent, /data:image\/png;base64,/);
  assert.deepEqual(Object.keys(visible).sort(), ['cssContent', 'revision', 'updatedAt', 'versionId']);
  await assert.rejects(run(loadCustomCss), { code: 'forbidden' });
  for (const relation of ['organization_custom_css_versions', 'organization_custom_css_images']) assert.equal((await run((client) => client.query(`SELECT * FROM ${relation}`))).rowCount, 0);
  const cleared = await work((client, identity) => saveCustomCss(client, identity, { requestId: randomUUID(), revision: current.revision, cssContent: '' }));
  assert.equal((await run(loadCurrentCustomCss)).versionId, cleared.versionId);
  assert.equal((await run((client) => client.query('SELECT * FROM report_current_custom_css()'))).rowCount, 1);
  const foreign = await createAccount(owner, { permissions: ['report_settings.manage'] }); const foreignSession = await signIn({ identifier: foreign.username, password: foreign.password });
  assert.deepEqual(await withSession(foreignSession.token, loadCurrentCustomCss, { readOnly: true }), { versionId: null, revision: 0, cssContent: '', updatedAt: null });
  await assert.rejects(run((client) => client.query('SELECT * FROM report_current_custom_css($1)', [current.versionId])), { code: '42883' });
  await assert.rejects(work((client) => client.query('SELECT * FROM report_save_custom_css($1,$2,$3)', [randomUUID(), cleared.revision, ''])), { code: '42883' });
});
