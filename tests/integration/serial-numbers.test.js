import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { addSerialColumns } from '../helpers/serial-numbers.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });

test('submitted final sections number their own repeated rows independently of the report parameter number', async () => {
  const account = await createAccount(owner, { permissions: ['templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const user = { ...account, ...await signIn({ identifier: account.username, password: account.password }) };
  const work = (action) => withSession(user.token, action, { csrfToken: user.csrfToken });
  let serials;
  const flow = await prepareReportFlow(owner, user, { finalSection: true, productLines: 2,
    prepareDatasheet: async (client, identity, template) => { serials = await addSerialColumns(client, identity, template); } });
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const report = await work((client, identity) => loadReport(client, identity, generated.items[0].id));
  const renderer = await loadReportRenderer();
  const html = renderer.renderReportDocument(report, renderer.stylesheet);
  const document = new DOMParser().parseFromString(html, 'text/html');
  const text = (fieldId) => Array.from(document.getElementsByTagName('div')).filter((element) => element.getAttribute('data-field-id') === fieldId).map((element) => element.textContent.trim());
  assert.deepEqual(text(serials.fieldIds[0]), ['01', '02', '01', '02']);
  assert.deepEqual(text(serials.fieldIds[1]), ['03', '03']);
  const reportSerial = Object.values(report.model.fieldsById).find((field) => field.widget === 'sno_widget');
  assert.deepEqual(text(reportSerial.id), ['01', '02']);
  assert.equal(renderer.renderReportDocument(await work((client, identity) => loadReport(client, identity, report.report.id)), renderer.stylesheet), html);
});
