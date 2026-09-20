import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { createTemplate } from '../../src/templates/authoring.js';
import { loadProduct, saveProduct, retireProduct, listProducts, productTags, productTemplates } from '../../src/masters/products.js';

const owner = ownerPool(); let account; let viewer; let author; let outsider; let noAccess;
const work = (callback, user = account, readOnly = false) => withSession(user.token, callback, { csrfToken: user.csrfToken, readOnly });
const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic product', key: `P-${randomUUID()}`,
  description: ' 0\n ', abbreviation: '0', jobTemplateId: null, tagIds: [], ...changes });
async function tag(name, user = account) {
  return (await owner.query('INSERT INTO tags(organization_id,code,name) VALUES($1,$2,$3) RETURNING id', [user.organizationId, randomUUID(), name])).rows[0].id;
}
async function category(name, user = account, { active = true } = {}) {
  return (await owner.query(`INSERT INTO sample_categories(organization_id,code,name,abbreviation,estimated_time_in_days,active) VALUES($1,$2,$3,'C',0,$4) RETURNING id`,
    [user.organizationId, randomUUID(), name, active])).rows[0].id;
}
async function rawProduct(client, identity, id, tagCount) {
  await client.query('INSERT INTO products(organization_id,id,code,name,tag_count,save_request_id) VALUES($1,$2,$3,$4,$5,$6)',
    [identity.organization_id, id, randomUUID(), 'Synthetic direct product', tagCount, randomUUID()]);
}
before(async () => {
  account = await createAccount(owner, { permissions: ['masters.manage'] });
  viewer = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  author = await createAccount(owner, { organizationId: account.organizationId, permissions: ['templates.manage'] });
  noAccess = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  outsider = await createAccount(owner, { permissions: ['masters.read', 'masters.manage'] });
  for (const user of [account, viewer, author, outsider, noAccess]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('product edits retain hidden categories, ordered tags, zero text and actual immutable history across key changes', async () => {
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const alpha = await tag('Alpha'); const beta = await tag('Beta');
  const command = input({ id: fixture.product.id, revision: 1, tagIds: [beta, alpha], jobTemplateId: fixture.template.templateId });
  const saved = await work((client, identity) => saveProduct(client, identity, command));
  assert.equal(saved.revision, 2); assert.equal(saved.key, command.key); assert.equal(saved.description, ' 0\n '); assert.equal(saved.abbreviation, '0');
  assert.deepEqual(saved.tagIds, [beta, alpha]); assert.deepEqual(saved.sampleCategoryIds, [fixture.category.id]);
  await assert.rejects(work((client, identity) => loadProduct(client, identity, saved.id, { atRevision: 1 }), viewer, true), { code: 'product_not_found' });
  const historical = await work((client, identity) => loadProduct(client, identity, saved.id, { atRevision: 2 }), viewer, true);
  assert.equal(historical.savedBy, account.userId); assert.equal(historical.previousRevision, 1);
  const edited = await work((client, identity) => saveProduct(client, identity, { ...command, revision: 2, requestId: randomUUID(),
    key: `${command.key}/2`, name: 'Later product', description: '', abbreviation: '', jobTemplateId: null, tagIds: [alpha] }));
  assert.equal(edited.revision, 3); assert.equal(edited.abbreviation, ''); assert.equal(edited.jobTemplateId, null);
  assert.deepEqual(edited.tagIds, [alpha]); assert.deepEqual(edited.sampleCategoryIds, [fixture.category.id]);
  assert.deepEqual(await work((client, identity) => loadProduct(client, identity, saved.id, { atRevision: 2 }), viewer, true), historical);
  assert.equal((await work((client, identity) => saveProduct(client, identity, command))).revision, 2);
  await assert.rejects(work((client, identity) => saveProduct(client, identity, { ...command, tagIds: [alpha, beta] })), { code: 'save_request_reused' });
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM product_versions WHERE organization_id=$1 AND product_id=$2', [account.organizationId, saved.id])).rows[0].count, 2);
});

test('product sample category selection can be explicitly set and cleared, and rejects inactive or unknown categories', async () => {
  const first = await category('First'); const second = await category('Second'); const retired = await category('Retired', account, { active: false });
  const created = await work((client, identity) => saveProduct(client, identity, input({ sampleCategoryIds: [first] })));
  assert.deepEqual(created.sampleCategoryIds, [first]);
  const untouched = await work((client, identity) => saveProduct(client, identity, { ...input({ id: created.id, revision: 1 }) }));
  assert.deepEqual(untouched.sampleCategoryIds, [first]);
  const changed = await work((client, identity) => saveProduct(client, identity, input({ id: created.id, revision: 2, sampleCategoryIds: [second] })));
  assert.deepEqual(changed.sampleCategoryIds, [second]);
  const cleared = await work((client, identity) => saveProduct(client, identity, input({ id: created.id, revision: 3, sampleCategoryIds: [] })));
  assert.deepEqual(cleared.sampleCategoryIds, []);
  for (const categoryIds of [[retired], [randomUUID()]]) {
    await assert.rejects(work((client, identity) => saveProduct(client, identity, input({ id: created.id, revision: 4, sampleCategoryIds: categoryIds }))),
      { code: 'invalid_product_sample_categories' });
  }
  const historical = await work((client, identity) => loadProduct(client, identity, created.id, { atRevision: 2 }), viewer, true);
  assert.deepEqual(historical.sampleCategoryIds, [first]);
  const finalRevision = await work((client, identity) => retireProduct(client, identity, { id: created.id, requestId: randomUUID(), revision: 4 }));
  const afterRetire = await work((client, identity) => loadProduct(client, identity, created.id, { atRevision: finalRevision.revision }), viewer, true);
  assert.deepEqual(afterRetire.sampleCategoryIds, []);
});

test('product retries and concurrent saves preserve one revision and reject conflicting keys or stale edits', async () => {
  const alpha = await tag('Concurrent alpha'); const beta = await tag('Concurrent beta');
  const command = input({ tagIds: [alpha] });
  const results = await Promise.all([0, 1].map(() => work((client, identity) => saveProduct(client, identity, command))));
  assert.deepEqual(results.map((row) => [row.id, row.revision]), [[command.id, 1], [command.id, 1]]);
  const changes = await Promise.allSettled([[], [beta]].map((tagIds) => work((client, identity) => saveProduct(client, identity,
    { ...command, requestId: randomUUID(), revision: 1, tagIds }))));
  assert.equal(changes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(changes.filter((result) => result.reason?.code === 'stale_product').length, 1);
  const key = `Collision-${randomUUID()}`;
  const collisions = await Promise.allSettled([key, key.toLowerCase()].map((key) => work((client, identity) => saveProduct(client, identity, input({ key })))));
  assert.equal(collisions.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(collisions.filter((result) => result.reason?.code === 'duplicate_product').length, 1);
  await assert.rejects(work((client, identity) => saveProduct(client, identity, input({ requestId: command.requestId }))), { code: 'save_request_reused' });
});

test('retirement preserves unversioned long text, existing categories and inactive template/tag references without inventing prior history', async () => {
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const selected = await tag('Retained inactive tag');
  await owner.query('INSERT INTO product_tags(organization_id,product_id,tag_id) VALUES($1,$2,$3)', [account.organizationId, fixture.product.id, selected]);
  await owner.query(`UPDATE products SET name=$3,description=$4,code='Legacy key with spaces',job_template_id=$5,revision=revision+1
    WHERE organization_id=$1 AND id=$2`, [account.organizationId, fixture.product.id, 'L'.repeat(250), 'D'.repeat(16001), fixture.template.templateId]);
  await owner.query('UPDATE tags SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, selected]);
  await owner.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [account.organizationId, fixture.template.templateId]);
  await assert.rejects(work((client) => client.query(`UPDATE products SET active=false,name='Changed during retirement',revision=revision+1,tag_count=1,save_request_id=$3
    WHERE organization_id=$1 AND id=$2`, [account.organizationId, fixture.product.id, randomUUID()])), { code: '23514' });
  const command = { id: fixture.product.id, revision: 2, requestId: randomUUID() };
  const retired = await work((client, identity) => retireProduct(client, identity, command));
  assert.deepEqual(await work((client, identity) => retireProduct(client, identity, command)), retired);
  const historical = await work((client, identity) => loadProduct(client, identity, command.id, { atRevision: 3 }), viewer, true);
  assert.equal(historical.name.length, 250); assert.equal(historical.description.length, 16001); assert.equal(historical.key, 'Legacy key with spaces');
  assert.equal(historical.active, false); assert.equal(historical.jobTemplateId, fixture.template.templateId); assert.equal(historical.jobTemplateActive, false);
  assert.deepEqual(historical.tagIds, [selected]); assert.equal(historical.tags[0].active, false); assert.deepEqual(historical.sampleCategoryIds, [fixture.category.id]);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM product_versions WHERE organization_id=$1 AND product_id=$2', [account.organizationId, command.id])).rows[0].count, 1);
  await assert.rejects(work((client, identity) => loadProduct(client, identity, command.id), viewer, true), { code: 'product_not_found' });
  assert.equal((await owner.query('SELECT 1 FROM product_tags WHERE organization_id=$1 AND product_id=$2 AND tag_id=$3', [account.organizationId, command.id, selected])).rowCount, 1);
});

test('Product metadata lookups allow active template kinds while protecting definitions, tenants and mutation permissions', async () => {
  const template = await work((client, identity) => createTemplate(client, identity, { name: 'Report metadata choice', kind: 'report' }), author);
  const selected = await tag('Visible own tag'); const foreign = await tag('Foreign tag', outsider);
  const inactive = await tag('Inactive tag'); await owner.query('UPDATE tags SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [account.organizationId, inactive]);
  const command = input({ jobTemplateId: template.templateId, tagIds: [selected] });
  const saved = await work((client, identity) => saveProduct(client, identity, command));
  assert.equal(saved.jobTemplateName, 'Report metadata choice');
  assert.equal((await work((client) => client.query('SELECT 1 FROM template_versions'), account, true)).rowCount, 0);
  const labels = await work((client) => client.query('SELECT * FROM product_template_labels'), viewer, true);
  assert.ok(labels.rows.every((row) => row.organization_id === account.organizationId));
  assert.deepEqual(labels.fields.map((field) => field.name), ['organization_id', 'template_id', 'code', 'name', 'kind', 'active']);
  assert.equal((await work((client) => client.query('SELECT * FROM product_template_labels'), noAccess, true)).rowCount, 0);
  assert.equal((await getPool().query('SELECT * FROM product_template_labels')).rowCount, 0);
  for (const tagId of [foreign, inactive]) await assert.rejects(work((client, identity) => saveProduct(client, identity, input({ tagIds: [tagId] }))), { code: 'invalid_product_tags' });
  await assert.rejects(work((client, identity) => saveProduct(client, identity, input({ jobTemplateId: randomUUID() }))), { code: 'invalid_product_template' });
  for (const options of [{}, { atRevision: 1 }]) await assert.rejects(work((client, identity) => loadProduct(client, identity, saved.id, options), outsider, true), { code: 'product_not_found' });
  await assert.rejects(work((client, identity) => saveProduct(client, identity, input()), viewer), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => loadProduct(client, identity, saved.id), noAccess, true), { code: 'forbidden' });
  assert.equal((await owner.query("SELECT has_table_privilege('sampleify_report_worker','product_template_labels','SELECT') AS allowed")).rows[0].allowed, false);
});

test('product SQL boundaries reject incomplete history, late children, unsaved links, hidden-link writes and forged history', async () => {
  const selected = await tag('Guarded tag'); const command = input({ tagIds: [selected] });
  await work((client, identity) => saveProduct(client, identity, command));
  const categoryId = (await owner.query(`INSERT INTO sample_categories(organization_id,code,name,abbreviation,estimated_time_in_days) VALUES($1,$2,'Guarded category','GC',0) RETURNING id`,
    [account.organizationId, randomUUID()])).rows[0].id;
  await owner.query('INSERT INTO product_sample_categories(organization_id,product_id,sample_category_id) VALUES($1,$2,$3)', [account.organizationId, command.id, categoryId]);
  const incompleteId = randomUUID();
  await assert.rejects(work((client, identity) => rawProduct(client, identity, incompleteId, 1)), { code: '23514' });
  assert.equal((await owner.query('SELECT 1 FROM products WHERE organization_id=$1 AND id=$2', [account.organizationId, incompleteId])).rowCount, 0);
  await assert.rejects(work((client) => client.query('INSERT INTO product_version_tags(organization_id,product_id,revision,tag_id,position) VALUES($1,$2,1,$3,1)',
    [account.organizationId, command.id, selected])), { code: '23514' });
  await assert.rejects(work((client) => client.query('DELETE FROM product_tags WHERE organization_id=$1 AND product_id=$2', [account.organizationId, command.id])), { code: '23514' });
  await assert.rejects(work((client) => client.query('DELETE FROM product_sample_categories WHERE organization_id=$1 AND product_id=$2', [account.organizationId, command.id])), { code: '23514' });
  await assert.rejects(work((client) => client.query('INSERT INTO product_versions SELECT * FROM product_versions WHERE organization_id=$1 AND product_id=$2', [account.organizationId, command.id])), { code: '42501' });
  await assert.rejects(work((client) => client.query('DELETE FROM products WHERE organization_id=$1 AND id=$2', [account.organizationId, command.id])), { code: '42501' });
  await assert.rejects(owner.query("UPDATE product_versions SET name='Forged' WHERE organization_id=$1 AND product_id=$2", [account.organizationId, command.id]), { code: '55000' });
});

test('multiple saves in one transaction retain each complete tag revision and early constraint checks cannot allow later mismatches', async () => {
  const first = await tag('First transaction tag'); const second = await tag('Second transaction tag'); const command = input({ tagIds: [first] });
  await work(async (client, identity) => {
    await saveProduct(client, identity, command);
    await saveProduct(client, identity, { ...command, revision: 1, requestId: randomUUID(), tagIds: [second] });
  });
  assert.deepEqual((await work((client, identity) => loadProduct(client, identity, command.id, { atRevision: 1 }), viewer, true)).tagIds, [first]);
  assert.deepEqual((await work((client, identity) => loadProduct(client, identity, command.id), viewer, true)).tagIds, [second]);
  await assert.rejects(work(async (client, identity) => {
    const id = randomUUID(); await rawProduct(client, identity, id, 1);
    await client.query('UPDATE products SET tag_count=0,revision=revision+1,save_request_id=$3 WHERE organization_id=$1 AND id=$2', [identity.organization_id, id, randomUUID()]);
  }), { code: '23514' });
  await assert.rejects(work(async (client, identity) => {
    const saved = await saveProduct(client, identity, input({ tagIds: [first] }));
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('DELETE FROM product_tags WHERE organization_id=$1 AND product_id=$2', [identity.organization_id, saved.id]);
  }), { code: '23514' });
  await assert.rejects(work(async (client, identity) => {
    const saved = await saveProduct(client, identity, input());
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('INSERT INTO product_version_tags(organization_id,product_id,revision,tag_id,position) VALUES($1,$2,1,$3,0)', [identity.organization_id, saved.id, first]);
  }), { code: '23514' });
});

test('Product listing batches ordered relation labels, preserves literal and ordered-word searches, and matches any selected tag', async () => {
  const prefix = randomUUID(); const alpha = await tag(`Alpha_% ${prefix}`); const beta = await tag(`Beta ${prefix}`);
  const template = await work((client, identity) => createTemplate(client, identity, { name: `Summary_% ${prefix}`, kind: 'datasheet' }), author);
  const records = [];
  for (const [name, tagIds] of [['A', [beta, alpha]], ['B', [alpha]], ['C', [beta]], ['D', []]]) records.push(await work((client, identity) => saveProduct(client, identity,
    input({ name: `${prefix} ${name}`, tagIds, description: 'Exact_% middle match', jobTemplateId: name === 'A' ? template.templateId : null }))));
  const calls = [];
  const first = await work((client, identity) => listProducts({ query: (...args) => { calls.push(args[0]); return client.query(...args); } }, identity,
    { search: prefix, sort: { key: 'name', dir: 'asc' }, pageSize: 2 }), viewer, true);
  // One current-definition query, then the existing count and relation-label page queries.
  assert.equal(calls.length, 3); assert.equal(first.totalCount, 4); assert.deepEqual(first.rows.map((row) => row._id), records.slice(0, 2).map((row) => row.id));
  assert.equal(first.rows[0].tags, `Beta ${prefix}, Alpha_% ${prefix}`); assert.equal(first.rows[0].job_template_id, `Summary_% ${prefix}`);
  const second = await work((client, identity) => listProducts(client, identity, { search: prefix, sort: { key: 'name', dir: 'asc' }, pageSize: 2, page: 2 }), viewer, true);
  assert.deepEqual(second.rows.map((row) => row._id), records.slice(2).map((row) => row.id));
  const filtered = await work((client, identity) => listProducts(client, identity, { search: prefix, sort: { key: 'name', dir: 'asc' },
    filters: { tags: { type: 'relation', value: [alpha, beta], labels: { [alpha]: 'Ignored display label', [beta]: 'Beta' } }, description: { type: 'text', value: 'Exact_% match' } } }));
  assert.equal(filtered.totalCount, 3); assert.deepEqual(filtered.rows.map((row) => row._id), records.slice(0, 3).map((row) => row.id));
  assert.equal((await work((client, identity) => listProducts(client, identity, { search: 'Exact_% match', filters: { name: { type: 'text', value: prefix } } }))).totalCount, 0);
  assert.equal((await work((client, identity) => listProducts(client, identity, { search: `Alpha_% ${prefix}` }))).totalCount, 2);
  assert.equal((await work((client, identity) => listProducts(client, identity, { search: prefix, filters: { job_template_id: { type: 'text', value: 'Summary_%' } } }))).totalCount, 1);
  assert.equal((await work((client, identity) => listProducts(client, identity, { search: prefix }), outsider, true)).totalCount, 0);
  assert.equal((await work((client, identity) => listProducts(client, identity, { search: prefix, page: 100 }), viewer, true)).rows.length, 0);
  await work((client, identity) => retireProduct(client, identity, { id: records[0].id, revision: 1, requestId: randomUUID() }));
  assert.equal((await work((client, identity) => listProducts(client, identity, { search: prefix }))).totalCount, 3);
  for (const query of [null, { pageSize: 101 }, { search: '\0' }, { sort: { key: 'password_hash', dir: 'asc' } },
    { filters: { tags: { type: 'text', value: 'Alpha' } } }, { filters: { tags: { type: 'relation', value: [alpha, alpha] } } },
    { filters: { tags: { type: 'relation', value: [alpha], labels: { extra: 'Forged label' } } } }]) {
    await assert.rejects(work((client, identity) => listProducts(client, identity, query)), (error) => error.status === 400);
  }
});

test('Product tag and template lookups are bounded, literal, active and tenant scoped without exposing template definitions', async () => {
  const prefix = `Lookup_% ${randomUUID()}`;
  await owner.query(`INSERT INTO tags(organization_id,code,name) SELECT $1,gen_random_uuid()::text,$2||' '||position::text FROM generate_series(1,102) position`, [account.organizationId, prefix]);
  const templates = await work(async (client, identity) => {
    const rows = [];
    for (let position = 0; position < 102; position += 1) rows.push(await createTemplate(client, identity, { name: `${prefix} ${position}`, kind: position % 2 ? 'report' : 'datasheet' }));
    return rows;
  }, author);
  const tags = await work((client, identity) => productTags(client, identity, { search: prefix }), viewer, true);
  const labels = await work((client, identity) => productTemplates(client, identity, { search: prefix }), viewer, true);
  assert.equal(tags.rows.length, 100); assert.equal(tags.hasMore, true); assert.equal(labels.rows.length, 100); assert.equal(labels.hasMore, true);
  assert.deepEqual(Object.keys(labels.rows[0]), ['id', 'name']);
  await owner.query('UPDATE tags SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=ANY($2::uuid[])', [account.organizationId, tags.rows.slice(0, 2).map((row) => row.id)]);
  await owner.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=ANY($2::uuid[])', [account.organizationId, templates.slice(0, 2).map((row) => row.templateId)]);
  for (const lookup of [productTags, productTemplates]) {
    const remaining = await work((client, identity) => lookup(client, identity, { search: prefix }), viewer, true);
    assert.equal(remaining.rows.length, 100); assert.equal(remaining.hasMore, false);
    assert.equal((await work((client, identity) => lookup(client, identity, { search: prefix.replace('_%', 'XX') }), viewer, true)).rows.length, 0);
    assert.equal((await work((client, identity) => lookup(client, identity, { search: prefix }), outsider, true)).rows.length, 0);
    await assert.rejects(work((client, identity) => lookup(client, identity), noAccess, true), { code: 'forbidden' });
  }
});
