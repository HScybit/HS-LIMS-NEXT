import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(); const require = createRequire(import.meta.url);
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
const report = { status: 'running', checkedAt: new Date().toISOString(), routes: [] };
async function routeTraces(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await routeTraces(file));
    else if (entry.name === 'route.js.nft.json') files.push(file);
  }
  return files;
}
try {
  report.buildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
  const config = JSON.parse(await readFile('.next/required-server-files.json', 'utf8')).config;
  assert(!config.serverExternalPackages?.includes('react-select'), 'Rendered React Select controls must use Next’s normal React bundle.');
  const runtime = await nodeFileTrace([require.resolve('react-select')], { base: root, processCwd: root });
  assert.equal(runtime.warnings.size, 0, 'Resolve all runtime dependency tracing warnings before release.');
  report.runtimeFiles = runtime.fileList.size;
  const required = [...runtime.fileList].map(file => path.resolve(root, file));
  const routes = [...await routeTraces('.next/server/app/api/users'),
    ...['products', 'test-parameters'].map(resource => `.next/server/app/api/masters/${resource}/custom-field-users/route.js.nft.json`),
    '.next/server/app/api/organization-settings/module-access/options/route.js.nft.json'];
  for (const file of routes) {
    const trace = JSON.parse(await readFile(file, 'utf8')); const included = new Set(trace.files.map(entry => path.resolve(path.dirname(file), entry)));
    report.routes.push({ path: file, missing: required.filter(entry => !included.has(entry)).map(entry => path.relative(root, entry)) });
  }
  assert(report.routes.length > 2, 'Build the user and master API routes before checking their runtime files.');
  assert(report.routes.every(route => route.missing.length === 0), 'A user-choice API deployment trace is missing filter runtime files.');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
finally { await writeFile('.local/user-field-filter-runtime-verification.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, buildId: report.buildId, runtimeFiles: report.runtimeFiles, routes: report.routes.length, error: report.error })); }
