import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { uploadReportImage, readReportImage } from '../../src/report-assets/images.js';

const owner = ownerPool(); let account; let content;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
const input = () => ({ requestId: randomUUID(), originalName: 'Laboratory logo.png', mediaType: 'image/png', content });
before(async () => {
  const user = await createAccount(owner, { permissions: ['report_settings.manage'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  content = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#003366' } }).png().toBuffer();
});
after(async () => { await closePool(); await owner.end(); });

test('captured images retain exact bytes and actual upload evidence across concurrent retries', async () => {
  const upload = input();
  const attempts = await Promise.all([1, 2].map(() => work((client, identity) => uploadReportImage(client, identity, upload))));
  assert.equal(attempts[0].id, upload.requestId);
  assert.equal(attempts[1].id, upload.requestId);
  assert.equal(attempts.filter((result) => result.replayed).length, 1);
  const file = await work((client, identity) => readReportImage(client, identity, upload.requestId.toUpperCase()), { readOnly: true });
  assert.deepEqual(file.content, content);
  assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(file.width, 32); assert.equal(file.height, 16);
  const evidence = (await owner.query('SELECT uploaded_by,uploaded_at IS NOT NULL AS recorded FROM report_image_assets WHERE organization_id=$1 AND id=$2', [account.organizationId, upload.requestId])).rows;
  assert.deepEqual(evidence, [{ uploaded_by: account.userId, recorded: true }]);
  await assert.rejects(work((client, identity) => uploadReportImage(client, identity, { ...upload, originalName: 'Changed.png' })), { code: 'image_request_reused' });
  const different = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#aa0000' } }).png().toBuffer();
  await assert.rejects(work((client, identity) => uploadReportImage(client, identity, { ...upload, content: different })), { code: 'image_request_reused' });
  await assert.rejects(owner.query('UPDATE report_image_assets SET original_name=$3 WHERE organization_id=$1 AND id=$2', [account.organizationId, upload.requestId, 'Changed.png']), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM report_image_assets WHERE organization_id=$1 AND id=$2', [account.organizationId, upload.requestId]), { code: '55000' });
});

test('asset reads and writes enforce tenant and read/manage permissions at service and database boundaries', async () => {
  const upload = input();
  await work((client, identity) => uploadReportImage(client, identity, upload));
  for (const options of [
    { organizationId: account.organizationId, permissions: ['report_settings.read'] },
    { organizationId: account.organizationId, permissions: [] },
    { permissions: ['report_settings.read', 'report_settings.manage'] },
  ]) {
    const user = await createAccount(owner, options); const session = await signIn({ identifier: user.username, password: user.password });
    const run = (callback) => withSession(session.token, callback, { csrfToken: session.csrfToken });
    const sameTenant = user.organizationId === account.organizationId; const read = options.permissions.includes('report_settings.read');
    if (sameTenant && read) assert.deepEqual((await run((client, identity) => readReportImage(client, identity, upload.requestId))).content, content);
    else await assert.rejects(run((client, identity) => readReportImage(client, identity, upload.requestId)), { code: sameTenant ? 'forbidden' : 'report_image_not_found' });
    const rows = await run((client) => client.query('SELECT id FROM report_image_assets WHERE id=$1', [upload.requestId]));
    assert.equal(rows.rowCount, sameTenant && read ? 1 : 0);
    if (sameTenant) {
      await assert.rejects(run((client, identity) => uploadReportImage(client, identity, input())), { code: 'forbidden' });
      await assert.rejects(run((client) => client.query(`INSERT INTO report_image_assets(organization_id,id,original_name,media_type,content,byte_length,sha256,width,height,uploaded_by)
        VALUES($1,$2,'Forged.png','image/png',$3,$4,$5,32,16,$6)`, [user.organizationId, randomUUID(), content, content.length, createHash('sha256').update(content).digest('hex'), user.userId])), { code: '42501' });
    }
  }
});

test('forged image actor, time, digest and filename fail atomically; an interrupted upload can retry', async () => {
  const other = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  const digest = createHash('sha256').update(content).digest('hex');
  for (const values of [
    { actor: other.userId, time: 'now()', name: 'Logo.png', digest, code: '42501' },
    { actor: account.userId, time: "now()-interval '1 minute'", name: 'Logo.png', digest, code: '42501' },
    { actor: account.userId, time: 'now()', name: 'Logo.png', digest: '0'.repeat(64), code: '23514' },
    { actor: account.userId, time: 'now()', name: '../Logo.png', digest, code: '23514' },
  ]) {
    await assert.rejects(work((client) => client.query(`INSERT INTO report_image_assets(organization_id,id,original_name,media_type,content,byte_length,sha256,width,height,uploaded_by,uploaded_at)
      VALUES($1,$2,$3,'image/png',$4,$5,$6,32,16,$7,${values.time})`, [account.organizationId, randomUUID(), values.name, content, content.length, values.digest, values.actor])), { code: values.code });
  }
  const upload = input();
  await assert.rejects(work(async (client, identity) => { await uploadReportImage(client, identity, upload); throw new Error('Synthetic interrupted upload'); }), /Synthetic interrupted upload/);
  assert.equal((await owner.query('SELECT id FROM report_image_assets WHERE organization_id=$1 AND id=$2', [account.organizationId, upload.requestId])).rowCount, 0);
  assert.equal((await work((client, identity) => uploadReportImage(client, identity, upload))).replayed, false);
});
