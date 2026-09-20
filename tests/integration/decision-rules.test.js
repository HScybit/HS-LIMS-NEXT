import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveDecisionRule, loadDecisionRule, listDecisionRules, retireDecisionRule,
  decisionRuleProductOptions, decisionRuleParameterOptions, decisionRuleMethodOptions, decisionRuleCategoryOptions,
  decisionRuleInstrumentOptions, decisionRuleTemplateOptions, decisionRuleParentOptions } from '../../src/masters/decision-rules.js';

const owner = ownerPool();
const work = (actor, callback) => withSession(actor.token, callback, { csrfToken: actor.csrfToken });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function product(actor, name = 'Product') {
  return (await owner.query('INSERT INTO products(organization_id,id,code,name) VALUES($1,gen_random_uuid(),$2,$3) RETURNING id',
    [actor.organizationId, randomUUID(), name])).rows[0].id;
}
async function parameter(actor, name = 'Parameter') {
  return (await owner.query('INSERT INTO test_parameters(organization_id,id,code,name,master_key,scheme_abbreviation) VALUES($1,gen_random_uuid(),$2,$3,$4,$5) RETURNING id',
    [actor.organizationId, randomUUID(), name, randomUUID(), randomUUID().slice(0, 8)])).rows[0].id;
}
async function method(actor, name = 'Method') {
  return (await owner.query('INSERT INTO methods_of_analysis(organization_id,id,code,name,method_uuid) VALUES($1,gen_random_uuid(),$2,$3,$4) RETURNING id',
    [actor.organizationId, randomUUID(), name, randomUUID()])).rows[0].id;
}
async function category(actor, name = 'Category') {
  return (await owner.query(`INSERT INTO sample_categories(organization_id,id,code,name,abbreviation,estimated_time_in_days) VALUES($1,gen_random_uuid(),$2,$3,'C',0) RETURNING id`,
    [actor.organizationId, randomUUID(), name])).rows[0].id;
}
const command = (scope, changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, sampleCategoryIds: [], ...scope, ...changes });
const save = (actor, input) => work(actor, (client, identity) => saveDecisionRule(client, identity, input));
const load = (actor, id, options) => work(actor, (client, identity) => loadDecisionRule(client, identity, id, options));
const list = (actor, input) => work(actor, (client, identity) => listDecisionRules(client, identity, input));
const retire = (actor, input) => work(actor, (client, identity) => retireDecisionRule(client, identity, input));
after(async () => { await closePool(); await owner.end(); });

test('decision rule authoring records actual editors, preserves history and stores categories/limits/formula together', async () => {
  const actor = await account();
  const productId = await product(actor); const parameterId = await parameter(actor); const methodId = await method(actor);
  const categoryOne = await category(actor, 'Water'); const categoryTwo = await category(actor, 'Soil');
  const scope = { productId, testParameterId: parameterId, methodId };
  const input = command(scope, { sampleCategoryIds: [categoryOne], cutoffValue: 5, isNabl: true, discipline: 'Chemical', group: 'Group 1',
    hasFormula: true, formula: 'A+B', formulaVariables: [{ key: 'A', label: 'Value A' }, { key: 'B', label: 'Value B' }],
    limits: [{ lowerLimit: '0', upperLimit: '10', outcome: 'Pass' }, { lowerLimit: '10', outcome: 'Fail', lowerInclusive: false }] });
  const created = await save(actor, input);
  assert.equal(created.revision, 1); assert.deepEqual(created.sampleCategoryIds, [categoryOne]); assert.equal(Number(created.cutoffValue), 5);
  assert.equal(created.isNabl, true); assert.equal(created.discipline, 'Chemical'); assert.equal(created.group, 'Group 1');
  assert.deepEqual(created.formulaVariables, [{ key: 'A', label: 'Value A' }, { key: 'B', label: 'Value B' }]);
  assert.equal(created.limits.length, 2); assert.equal(created.limits[1].lowerInclusive, false); assert.equal(created.limits[1].upperLimit, null);
  const editor = await account({ organizationId: actor.organizationId });
  const edited = await save(editor, { ...input, requestId: randomUUID(), revision: 1, sampleCategoryIds: [categoryTwo], cutoffValue: 9 });
  assert.equal(edited.revision, 2); assert.deepEqual(edited.sampleCategoryIds, [categoryTwo]); assert.equal(Number(edited.cutoffValue), 9);
  const historical = await load(editor, created.id, { atRevision: 1 });
  assert.equal(historical.savedBy, actor.userId); assert.equal(historical.operation, 'create');
  const second = await load(editor, created.id, { atRevision: 2 });
  assert.equal(second.savedBy, editor.userId); assert.equal(second.previousRevision, 1);
});

test('decision rule active uniqueness ignores category but not method or parameter, and Q16 lets an inactive rule be superseded', async () => {
  const actor = await account();
  const productId = await product(actor); const parameterId = await parameter(actor); const methodId = await method(actor);
  const categoryOne = await category(actor); const categoryTwo = await category(actor);
  const scope = { productId, testParameterId: parameterId, methodId };
  const first = await save(actor, command(scope, { sampleCategoryIds: [categoryOne] }));
  await assert.rejects(save(actor, command(scope, { sampleCategoryIds: [categoryTwo] })), { code: 'duplicate_decision_rule' });
  const otherParameter = await parameter(actor, 'Other');
  const distinctParameter = await save(actor, command({ ...scope, testParameterId: otherParameter }));
  assert.notEqual(distinctParameter.id, first.id);
  const retired = await retire(actor, { id: first.id, requestId: randomUUID(), revision: first.revision });
  assert.equal(retired.revision, first.revision + 1);
  // Q16 (PERN behavior, confirmed 2026-09-18): an inactive rule does not reserve its combination.
  const reactivatedScope = await save(actor, command(scope, { sampleCategoryIds: [categoryOne] }));
  assert.notEqual(reactivatedScope.id, first.id); assert.equal(reactivatedScope.revision, 1);
});

test('decision rule test groups: a parent cannot be a child, and children must share the parent product and MoA', async () => {
  const actor = await account();
  const productId = await product(actor); const methodId = await method(actor);
  const parentParameter = await parameter(actor); const childParameter = await parameter(actor); const otherProduct = await product(actor);
  const parent = await save(actor, command({ productId, testParameterId: parentParameter, methodId },
    { isTestGroupParent: true, testGroupName: 'Group A', testGroupUid: `GROUP_${randomUUID().replace(/-/g, '')}` }));
  assert.equal(parent.isTestGroupParent, true); assert.equal(parent.name, 'Group A');
  const child = await save(actor, command({ productId, testParameterId: childParameter, methodId }, { parentDecisionRuleId: parent.id }));
  assert.equal(child.parentDecisionRuleId, parent.id);
  await assert.rejects(save(actor, command({ productId, testParameterId: randomUUID(), methodId },
    { parentDecisionRuleId: parent.id, isTestGroupParent: true, testGroupName: 'X', testGroupUid: 'X' })), { code: 'invalid_decision_rule_test_group' });
  await assert.rejects(save(actor, command({ productId: otherProduct, testParameterId: childParameter, methodId }, { parentDecisionRuleId: parent.id })),
    { code: 'invalid_decision_rule_test_group' });
  await assert.rejects(save(actor, command({ productId, testParameterId: await parameter(actor), methodId },
    { testGroupName: 'Missing UID flag' })), { code: 'invalid_decision_rule_test_group' });
});

test('decision rule references must be active in this organization, and retirement preserves the last settings', async () => {
  const actor = await account();
  const productId = await product(actor); const parameterId = await parameter(actor); const methodId = await method(actor);
  const scope = { productId, testParameterId: parameterId, methodId };
  await assert.rejects(save(actor, command(scope, { sampleCategoryIds: [randomUUID()] })), { code: 'invalid_decision_rule_references' });
  const outsider = await account();
  const foreignCategory = await category(outsider);
  await assert.rejects(save(actor, command(scope, { sampleCategoryIds: [foreignCategory] })), { code: 'invalid_decision_rule_references' });
  const created = await save(actor, command(scope));
  const retired = await retire(actor, { id: created.id, requestId: randomUUID(), revision: created.revision });
  const historical = await load(actor, created.id, { atRevision: retired.revision });
  assert.equal(historical.operation, 'retire'); assert.equal(historical.active, false);
  await assert.rejects(load(actor, created.id), { code: 'decision_rule_not_found' });
});

test('decision rule retries return the original version and reject a changed payload or actor', async () => {
  const actor = await account();
  const productId = await product(actor); const parameterId = await parameter(actor); const methodId = await method(actor);
  const input = command({ productId, testParameterId: parameterId, methodId });
  const created = await save(actor, input);
  const retried = await save(actor, { ...input, id: input.id.toUpperCase(), requestId: input.requestId.toUpperCase() });
  assert.equal(retried.revision, 1); assert.equal(Number(retried.cutoffValue), 0);
  await assert.rejects(save(actor, { ...input, cutoffValue: 99 }), { code: 'save_request_reused' });
  const other = await account({ organizationId: actor.organizationId });
  await assert.rejects(save(other, input), { code: 'save_request_reused' });
  assert.equal((await load(actor, created.id)).revision, 1);
});

test('decision rule listing excludes retired rules and supports search across the joined product, parameter and MoA names', async () => {
  const actor = await account();
  const productId = await product(actor, 'Findable Product'); const parameterId = await parameter(actor); const methodId = await method(actor);
  const kept = await save(actor, command({ productId, testParameterId: parameterId, methodId }));
  const goneProduct = await product(actor); const goneParameter = await parameter(actor);
  const gone = await save(actor, command({ productId: goneProduct, testParameterId: goneParameter, methodId }));
  await retire(actor, { id: gone.id, requestId: randomUUID(), revision: gone.revision });
  const all = await list(actor, {});
  assert.ok(all.rows.some((row) => row._id === kept.id)); assert.ok(!all.rows.some((row) => row._id === gone.id));
  const filtered = await list(actor, { search: 'Findable' });
  assert.equal(filtered.totalCount, 1); assert.equal(filtered.rows[0]._id, kept.id);
});

test('decision rule lookup endpoints are tenant scoped and filter appropriately', async () => {
  const actor = await account();
  const productId = await product(actor); const parameterId = await parameter(actor); const methodId = await method(actor); const categoryId = await category(actor);
  const parentUid = `GROUP_${randomUUID().replace(/-/g, '')}`;
  const parent = await save(actor, command({ productId, testParameterId: parameterId, methodId }, { isTestGroupParent: true, testGroupName: 'Lookup Group', testGroupUid: parentUid }));
  const outsider = await account();
  for (const [lookup, expectedId] of [[decisionRuleProductOptions, productId], [decisionRuleParameterOptions, parameterId], [decisionRuleMethodOptions, methodId], [decisionRuleCategoryOptions, categoryId]]) {
    const owned = await work(actor, (client, identity) => lookup(client, identity, { search: '' }));
    assert.ok(owned.rows.some((row) => row.id === expectedId));
    const foreign = await work(outsider, (client, identity) => lookup(client, identity, { search: '' }));
    assert.ok(!foreign.rows.some((row) => row.id === expectedId));
  }
  const instruments = await work(actor, (client, identity) => decisionRuleInstrumentOptions(client, identity, { search: '' }));
  assert.deepEqual(instruments, { rows: [], hasMore: false });
  const templates = await work(actor, (client, identity) => decisionRuleTemplateOptions(client, identity, { search: '' }));
  assert.deepEqual(templates, { rows: [], hasMore: false });
  const parents = await work(actor, (client, identity) => decisionRuleParentOptions(client, identity, { search: '' }));
  assert.ok(parents.rows.some((row) => row.id === parent.id && row.name === 'Lookup Group'));
  const parentsFiltered = await work(actor, (client, identity) => decisionRuleParentOptions(client, identity, { search: 'No Match' }));
  assert.deepEqual(parentsFiltered.rows, []);
});
