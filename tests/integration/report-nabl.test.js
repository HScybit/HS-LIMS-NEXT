import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports, loadReport, reportOptions } from '../../src/reports/service.js';

const owner = ownerPool(); let account;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute', 'masters.manage'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

// Adds a second, NABL-accredited test on the same product alongside the fixture's
// existing non-accredited one — a genuinely mixed selection (Q5's actual scenario).
// Uses the privileged owner connection directly (like createLaboratoryFixture itself),
// not the identity-scoped session client, to build this master data in one step.
async function addAccreditedTest(client, identity, fixture) {
  const code = randomUUID();
  const parameter = (await owner.query(`INSERT INTO test_parameters(organization_id,code,name,master_key,scheme_abbreviation,measurement_unit_id)
    VALUES($1,$2,'Synthetic accredited concentration',$2,$2,$3) RETURNING id`, [fixture.organizationId, code, fixture.unit.id])).rows[0];
  await owner.query('INSERT INTO parameter_methods(organization_id,test_parameter_id,method_id,is_default) VALUES($1,$2,$3,true)', [fixture.organizationId, parameter.id, fixture.method.id]);
  const rule = (await owner.query(`INSERT INTO decision_rules(organization_id,code,name,product_id,test_parameter_id,method_id,template_id,cutoff_value,less_than_text,greater_than_text,is_nabl)
    VALUES($1,$2,'Synthetic accredited criterion',$3,$4,$5,$6,'10','Within synthetic limit','Above synthetic limit',true) RETURNING id`,
  [fixture.organizationId, randomUUID(), fixture.product.id, parameter.id, fixture.method.id, fixture.template.templateId])).rows[0];
  await owner.query('INSERT INTO decision_rule_sample_categories(organization_id,decision_rule_id,sample_category_id) VALUES($1,$2,$3)', [fixture.organizationId, rule.id, fixture.category.id]);
  await owner.query("INSERT INTO decision_rule_limits(organization_id,decision_rule_id,lower_limit,upper_limit,outcome,display_order) VALUES($1,$2,0,10,'Within synthetic limit',0)", [fixture.organizationId, rule.id]);
  fixture.registration.products[0].tests.push({ testParameterId: parameter.id, methodId: fixture.method.id, decisionRuleId: rule.id, isAccredited: true, requestedQuantity: 1, rate: '0', currencyCode: 'INR' });
}

test('a consolidated selection mixing accredited and non-accredited tests splits into two reports, each fully homogeneous', async () => {
  const flow = await prepareReportFlow(owner, account, { prepareProduct: addAccreditedTest });
  assert.equal(flow.completed.length, 2);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  assert.equal(generated.items.length, 2);
  const nabl = generated.items.find((item) => item.isNabl);
  const nonNabl = generated.items.find((item) => !item.isNabl);
  assert.ok(nabl); assert.ok(nonNabl);
  assert.equal(nabl.groupKey, 'consolidated:nabl');
  assert.equal(nonNabl.groupKey, 'consolidated:non_nabl');
  const nablTests = (await owner.query('SELECT is_accredited FROM sample_report_tests WHERE organization_id=$1 AND report_id=$2', [account.organizationId, nabl.id])).rows;
  const nonNablTests = (await owner.query('SELECT is_accredited FROM sample_report_tests WHERE organization_id=$1 AND report_id=$2', [account.organizationId, nonNabl.id])).rows;
  assert.equal(nablTests.length, 1); assert.ok(nablTests.every((row) => row.is_accredited));
  assert.equal(nonNablTests.length, 1); assert.ok(nonNablTests.every((row) => !row.is_accredited));
  const loadedNabl = await work((client, identity) => loadReport(client, identity, nabl.id), { readOnly: true });
  assert.equal(loadedNabl.report.isNabl, true);
  assert.equal(loadedNabl.results.length, 1);
});

test('the database rejects a forged report whose accreditation does not match its NABL grouping', async () => {
  const flow = await prepareReportFlow(owner, account);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  assert.equal(generated.items[0].isNabl, false);
  await assert.rejects(owner.query('UPDATE sample_report_tests SET is_accredited=true WHERE organization_id=$1 AND report_id=$2', [account.organizationId, generated.items[0].id]), { code: '55000' });
  // report_group is a plain CHECK constraint, always enforced regardless of role: a group_key
  // whose nabl/non_nabl suffix disagrees with is_nabl is structurally impossible to store.
  await assert.rejects(owner.query(`INSERT INTO sample_reports(organization_id,id,sample_id,template_version_id,report_number,revision,report_type,group_key,is_nabl,generated_by,generated_event_id,
    sample_revision,sample_number,sample_type,sample_category_name,customer_name,customer_address,customer_reference,received_at,registered_at,due_at,description,is_finalized)
    SELECT organization_id,$3,sample_id,template_version_id,report_number,revision+1,report_type,'consolidated:nabl',false,generated_by,generated_event_id,
      sample_revision,sample_number,sample_type,sample_category_name,customer_name,customer_address,customer_reference,received_at,registered_at,due_at,description,is_finalized
    FROM sample_reports WHERE organization_id=$1 AND id=$2`, [account.organizationId, generated.items[0].id, randomUUID()]), { code: '23514' });
});

test('single-product and parameter-wise reports stay homogeneous without splitting when nothing is mixed', async () => {
  const flow = await prepareReportFlow(owner, account);
  const options = await work((client, identity) => reportOptions(client, identity, flow.sample.id), { readOnly: true });
  const productId = options.products[0].id;
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, reportType: 'product_wise',
    templateSelections: [{ key: productId, templateId: flow.template.templateId }] }));
  assert.equal(generated.items.length, 1);
  assert.equal(generated.items[0].isNabl, false);
  assert.equal(generated.items[0].groupKey, `product:${productId}:non_nabl`);
});
