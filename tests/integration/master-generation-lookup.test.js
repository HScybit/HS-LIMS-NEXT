import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { generateProductCustomFields } from '../../src/masters/product-custom-field-generation.js';
import { generateParameterCustomFields } from '../../src/masters/parameter-custom-field-generation.js';
import { generateMethodCustomFields } from '../../src/masters/method-custom-field-generation.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}

for (const [kind, association, generate] of [['product', 'product', generateProductCustomFields],
  ['parameter', 'parameter', generateParameterCustomFields], ['method', 'method_of_analysis', generateMethodCustomFields]]) {
  test(`${kind} schemes resolve current lookup labels, ordered generated selections and source zero/false/unknown displays`, async () => {
    const actor = await account();
    const sourceInput = { id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: randomUUID(), name: 'Generation choices',
      lines: [{ id: 'A', label: 'Alpha' }, { id: 'B', label: 'Beta' }, { id: '0', label: 0 }, { id: 'false', label: false }] };
    const source = await work(actor, (client, identity) => saveLookupSourceObservation(client, identity, sourceInput));
    const fields = [];
    for (const [index, command] of [{ key: 'choice', fieldType: 'lookup', allowsMultiple: true, lookupSourceId: source.id, scheme: 'B' },
      { key: 'output', fieldType: 'text', scheme: '{{choice}}' }].entries()) {
      fields.push(await work(actor, (client, identity) => saveCustomField(client, identity, { ...command,
        id: randomUUID(), requestId: randomUUID(), revision: 0, label: command.key, associatedWith: association, displayOrder: index, generatedAt: 'on_submit' })));
    }
    const input = value => ({ [kind]: {}, customFields: fields.map((field, index) => ({ fieldId: field.id, fieldRevision: 1, value: index ? '' : value })) });
    const run = (value, user = actor) => work(user, (client, identity) => generate(client, identity, input(value)), true);
    assert.deepEqual((await run('A')).values, [{ fieldId: fields[1].id, value: 'Alpha' }]);
    assert.deepEqual((await run('')).values, [{ fieldId: fields[0].id, value: 'B' }, { fieldId: fields[1].id, value: 'Beta' }]);
    assert.deepEqual((await run(['A', 0, false, 'missing'])).values, [{ fieldId: fields[1].id, value: 'Alpha, missing' }]);
    for (const value of [0, false]) assert.equal((await run(value)).values[0].value, String(value));
    await work(actor, (client, identity) => saveLookupSourceObservation(client, identity, { ...sourceInput, revision: 1, requestId: randomUUID(), lines: [{ id: 'A', label: 'Current Alpha' }] }));
    assert.equal((await run('A')).values[0].value, 'Current Alpha');
    assert.deepEqual((await run('')).values, [{ fieldId: fields[0].id, value: 'B' }, { fieldId: fields[1].id, value: 'B' }]);
    const foreign = await account(); await assert.rejects(run('A', foreign), { code: `${kind}_custom_fields_changed` });
    const reader = await account({ organizationId: actor.organizationId, permissions: ['masters.read'] });
    await assert.rejects(run('A', reader), { code: 'forbidden' });
  });
}
