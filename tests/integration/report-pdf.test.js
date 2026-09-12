import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { renderReportPdf } from '../../src/reports/pdf.js';

const owner = ownerPool(); let account; let renderer; let stylesheet;
before(async () => {
  await import('../../scripts/build-report-renderer.js');
  const { rendererId } = JSON.parse(await readFile('.local/report-renderers/current.json', 'utf8'));
  assert.match(rendererId, /^[a-f0-9]{64}$/);
  const directory = path.resolve('.local/report-renderers', rendererId);
  renderer = await import(pathToFileURL(path.join(directory, 'renderer.mjs')));
  stylesheet = await readFile(path.join(directory, 'stylesheet.css'), 'utf8');
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

test('the shared frozen renderer produces a real PDF with repeated zero results and rejects uncaptured remote resources', async () => {
  const flow = await prepareReportFlow(owner, account, { finalSection: true });
  const work = (action, options) => withSession(account.token, action, { csrfToken: account.csrfToken, ...options });
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const data = await work((client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  const html = renderer.renderReportDocument(data, stylesheet);
  assert.match(html, /CERTIFICATE OF ANALYSIS/);
  assert.equal((html.match(/>0\.00</g) ?? []).length, 6);
  assert.equal(html.includes('<script'), false);
  const bytes = await renderReportPdf({ html, printConfig: data.printConfig, stylesheet });
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-'); assert.ok(bytes.length > 5000);
  await writeFile('.local/m03-pdf-renderer-preview.pdf', bytes);
  await assert.rejects(renderReportPdf({ html: '<html><body><img src="http://127.0.0.1:9/uncaptured.png"></body></html>', printConfig: data.printConfig, stylesheet: '' }), { code: 'report_external_resource' });
});
