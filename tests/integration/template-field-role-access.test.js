import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { saveCapture, recalculateCapture } from '../../src/templates/capture.js';

const owner = ownerPool();
let author; let allocator; let analyst;
before(async () => {
  author = await createAccount(owner, { permissions: ['templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  Object.assign(author, await signIn({ identifier: author.username, password: author.password }));
  const users = [];
  for (const permissions of [['test_requests.allocate'], ['datasheets.execute']]) {
    const account = await createAccount(owner, { organizationId: author.organizationId, permissions });
    users.push({ ...account, ...await signIn({ identifier: account.username, password: account.password }) });
  }
  [allocator, analyst] = users;
});
after(async () => { await closePool(); await owner.end(); });
const work = (session, action, options = {}) => withSession(session.token, action, { csrfToken: session.csrfToken, ...options });

test('a field restricted to a role the assigned analyst lacks rejects their save and blanks their reads, until that role is granted', async () => {
  const fixture = await createLaboratoryFixture(owner, author);
  const field = fixture.template.records.fields.find((field) => field.alias === 'raw_0');
  const otherRoleId = randomUUID();
  await owner.query('INSERT INTO roles(organization_id, id, name) VALUES($1, $2, $3)', [author.organizationId, otherRoleId, `Synthetic gate role ${otherRoleId}`]);

  await assert.rejects(work(author, (client, identity) => editTemplate(client, identity, fixture.template.versionId, 1, {
    type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, label: field.label, required: field.required,
    editRoleIds: [randomUUID()],
  })), { code: 'invalid_role' });
  await work(author, (client, identity) => editTemplate(client, identity, fixture.template.versionId, 1, {
    type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, label: field.label, required: field.required,
    editRoleIds: [otherRoleId], viewRoleIds: [otherRoleId],
  }));

  const sample = await work(author, (client, identity) => registerSample(client, identity, fixture.registration));
  const requests = await work(allocator, (client, identity) => generateTestRequests(client, identity, sample.id));
  const requestId = requests.items[0].id;
  const allocated = await work(allocator, (client, identity) => allocateTestRequest(client, identity, requestId, { revision: 1, assignmentType: 'analyst', assignedUserId: analyst.userId }));
  const sheet = (await owner.query('SELECT * FROM datasheets WHERE organization_id=$1 AND id=$2', [author.organizationId, allocated.datasheetId])).rows[0];
  const occurrence = (await owner.query('SELECT id FROM template_occurrences WHERE organization_id=$1 AND instance_id=$2 AND group_id=$3 LIMIT 1',
    [author.organizationId, sheet.template_instance_id, field.repeatGroupId])).rows[0];

  // The assigned analyst has general write access to this datasheet, but not the specific role this field requires.
  await assert.rejects(work(analyst, (client, identity) => saveCapture(client, identity, sheet.template_instance_id, 1,
    [{ fieldId: field.id, occurrenceId: occurrence.id, state: 'present', value: '5' }])), { code: 'field_edit_forbidden', status: 403 });

  await owner.query('INSERT INTO membership_roles(organization_id, user_id, role_id) VALUES($1, $2, $3)', [author.organizationId, analyst.userId, otherRoleId]);
  const saved = await work(analyst, (client, identity) => saveCapture(client, identity, sheet.template_instance_id, 1,
    [{ fieldId: field.id, occurrenceId: occurrence.id, state: 'present', value: '5' }]));
  const savedValue = saved.values.find((value) => value.fieldId === field.id);
  assert.equal(savedValue.state, 'present'); assert.equal(savedValue.numberValue, '5');

  // Losing the role hides the value on read (server-side — the client never receives it) without losing the stored data.
  await owner.query('DELETE FROM membership_roles WHERE organization_id=$1 AND user_id=$2 AND role_id=$3', [author.organizationId, analyst.userId, otherRoleId]);
  const blanked = await work(analyst, (client, identity) => recalculateCapture(client, identity, sheet.template_instance_id, saved.revision));
  const blankedValue = blanked.values.find((value) => value.fieldId === field.id);
  assert.equal(blankedValue.state, 'absent'); assert.equal(blankedValue.origin, 'restricted'); assert.equal(blankedValue.numberValue, undefined);
  await assert.rejects(work(analyst, (client, identity) => saveCapture(client, identity, sheet.template_instance_id, blanked.revision,
    [{ fieldId: field.id, occurrenceId: occurrence.id, state: 'present', value: '9' }])), { code: 'field_edit_forbidden', status: 403 });

  await owner.query('INSERT INTO membership_roles(organization_id, user_id, role_id) VALUES($1, $2, $3)', [author.organizationId, analyst.userId, otherRoleId]);
  const restored = await work(analyst, (client, identity) => recalculateCapture(client, identity, sheet.template_instance_id, blanked.revision));
  const restoredValue = restored.values.find((value) => value.fieldId === field.id);
  assert.equal(restoredValue.state, 'present'); assert.equal(restoredValue.numberValue, '5');
});
