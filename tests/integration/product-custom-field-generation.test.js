import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveProduct } from '../../src/masters/products.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { generateProductCustomFields } from '../../src/masters/product-custom-field-generation.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions: ['masters.manage','settings.manage'], ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
async function setup() {
  const user = await account(); const commands = [
    { key: 'serial', label: 'Serial', scheme: '{{product_abbr}}/{{scheme_counter}}/{{current_year}}', paddedNumber: 2, splitter: '/', validateUniqueness: true, generatedAt: 'on_init' },
    { key: 'copied', label: 'Copied', scheme: '{{serial}}/copy', generatedAt: 'on_submit' },
  ].map((command, displayOrder) => ({ ...command, displayOrder, id: randomUUID(), requestId: randomUUID(), revision: 0, fieldType: 'text', associatedWith: 'product' }));
  const fields = [];
  for (const command of commands) fields.push(await work(user, (client, identity) => saveCustomField(client, identity, command)));
  const input = { product: { name: 'Synthetic generated Product', description: '', key: 'generated', abbreviation: 'W', jobTemplateId: null, tagIds: [] },
    customFields: fields.map((field) => ({ fieldId: field.id, fieldRevision: field.revision, value: '' })) };
  return { user, commands, fields, input };
}
const settingsInput = { revision: 0, autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null,
  schemeCurrentYearDigits: '2', schemeNextYearDigits: '2', schemeSeparator: '/', schemeMonthFormat: 'short', schemeNonNablStartNumber: '9tail' };
const saveInput = (input, generated) => ({ ...input.product, id: randomUUID(), revision: 0, requestId: randomUUID(), key: randomUUID(),
  customFields: input.customFields.map((field) => ({ ...field, value: generated.values.find((item) => item.fieldId === field.fieldId).value })) });

test('Product generation previews preserve source settings and field order, use current history and exclude the Product being edited', async () => {
  const { user, fields, input } = await setup();
  await work(user, (client, identity) => saveLaboratorySettings(client, identity, settingsInput));
  const sqlCalls = [];
  const generated = await work(user, (client, identity) => generateProductCustomFields({ query: (sql,args) => { sqlCalls.push(sql); return client.query(sql,args); } }, identity,input),true);
  const year = String(new Date().getFullYear()).slice(-2);
  assert.deepEqual(generated.values.map((field) => field.value), [`W/001/${year}`,`W/001/${year}/copy`]);
  assert.equal(sqlCalls.length,3, 'one definition batch, one context query and one history page');
  assert.equal((await owner.query('SELECT count(*) FROM products WHERE organization_id=$1',[user.organizationId])).rows[0].count,'0');
  const saved = await work(user,(client,identity) => saveProduct(client,identity,saveInput(input,generated)));
  const next = await work(user,(client,identity) => generateProductCustomFields(client,identity,input),true);
  assert.equal(next.values[0].value,`W/002/${year}`);
  const same = await work(user,(client,identity) => generateProductCustomFields(client,identity,{ ...input,productId:saved.id,fieldId:fields[0].id }),true);
  assert.deepEqual(same.values,[{fieldId:fields[0].id,value:`W/001/${year}`}]);
  const onEdit = await work(user,(client,identity) => generateProductCustomFields(client,identity,{ ...input,productId:saved.id }),true);
  assert.deepEqual(onEdit.values,[{fieldId:fields[1].id,value:'/copy'}]);
});

test('simultaneous generation previews do not reserve numbers and configured uniqueness still protects the actual Product saves', async () => {
  const { user,input } = await setup();
  const previews = await Promise.all([1,2].map(() => work(user,(client,identity) => generateProductCustomFields(client,identity,input),true)));
  assert.deepEqual(previews[0],previews[1]);
  const saves = await Promise.allSettled(previews.map((preview) => work(user,(client,identity) => saveProduct(client,identity,saveInput(input,preview)))));
  assert.equal(saves.filter((result) => result.status==='fulfilled').length,1);
  assert.equal(saves.find((result) => result.status==='rejected').reason.code,'duplicate_product_custom_field');
});

test('scheme settings retain omission, validate permissions and expose only authorized tenant generation context', async () => {
  const { user,input } = await setup();
  const viewer = await account({ organizationId:user.organizationId,permissions:['masters.read','settings.read'] });
  const foreign = await account();
  await work(user,(client,identity) => saveLaboratorySettings(client,identity,settingsInput));
  await work(user,(client,identity) => saveLaboratorySettings(client,identity,{ revision:1,autoCreateJobs:false,resultSummaryTemplateId:null,jobWorkflowId:null }));
  const settings = await work(viewer,loadLaboratorySettings,true);
  assert.equal(settings.settings.revision,2); assert.equal(settings.settings.schemeNonNablStartNumber,'9tail');
  await assert.rejects(work(viewer,(client,identity) => saveLaboratorySettings(client,identity,{...settingsInput,revision:2})),{code:'forbidden'});
  await assert.rejects(work(viewer,(client,identity) => generateProductCustomFields(client,identity,input),true),{code:'forbidden'});
  await assert.rejects(work(viewer,(client) => client.query('SELECT * FROM masters_product_scheme_context(true,true)'),true),{code:'42501'});
  await assert.rejects(work(foreign,(client,identity) => generateProductCustomFields(client,identity,input),true),{code:'product_custom_fields_changed'});
  const otherContext = await work(foreign,(client) => client.query('SELECT * FROM masters_product_scheme_context(true,true)'),true);
  assert.equal(otherContext.rows[0].nonNablStartNumber,null); assert.equal(otherContext.rows[0].productCount,0);
  assert.deepEqual(Object.keys(otherContext.rows[0]).sort(),['currentYearDigits','nextYearDigits','separator','currentMonthFormat','nonNablStartNumber','productCount','sampleCount'].sort());
});
