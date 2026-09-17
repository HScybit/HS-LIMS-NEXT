import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd(); const require = createRequire(import.meta.url);
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
const report = { status: 'running', checkedAt: new Date().toISOString(), routes: [] }; let temporary;
try {
  report.buildId = (await readFile('.next/BUILD_ID', 'utf8')).trim();
  const entries = ['bulk-xlsx-worker.js', 'bulk-xlsx-runner.js', 'bulk-xlsx-export-worker.js', 'bulk-xlsx-export.js'].map(name => `src/masters/${name}`);
  const runtime = await nodeFileTrace(entries, { base: root, processCwd: root });
  report.warnings = [...runtime.warnings].map(error => error.message);
  assert.equal(runtime.warnings.size, 0, 'Review every workbook worker tracing warning.');
  const required = [...runtime.fileList]; report.runtimeFiles = required.length;
  for (const route of ['', '/sample', '/[batchId]/original', '/[batchId]/rejected']) {
    const file = `.next/server/app/api/master-bulk${route}/route.js.nft.json`;
    const trace = JSON.parse(await readFile(file, 'utf8')); const included = new Set(trace.files.map(entry => path.resolve(path.dirname(file), entry)));
    const missing = required.filter(entry => !included.has(path.resolve(root, entry)));
    report.routes.push({ path: file, missing });
    assert.equal(missing.length, 0, `${file} is missing workbook runtime files.`);
  }
  // Exercise the packaged workers with no access to the project's node_modules.
  temporary = await mkdtemp(path.join(tmpdir(), 'sampleify-bulk-runtime-'));
  for (const file of required) {
    assert(!file.startsWith('..') && !path.isAbsolute(file) && !/(^|\/)\.env(?:\.|$)/.test(file), 'Runtime files must be safe relative source/dependency paths.');
    const target = path.join(temporary, file); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(root, file), target);
  }
  process.chdir(temporary);
  const { writeMasterXlsx } = await import(pathToFileURL(path.join(temporary, 'src/masters/bulk-xlsx-export.js')));
  const { readMasterXlsx } = await import(pathToFileURL(path.join(temporary, 'src/masters/bulk-xlsx-runner.js')));
  const rows = [['=literal', 0, false, new Date('2026-09-17T00:00:00.000Z')]];
  const bytes = await writeMasterXlsx(['text', 'number', 'boolean', 'date'], rows);
  const decoded = await readMasterXlsx(bytes);
  assert.deepEqual(decoded.rows.map(row => row.values), rows);
  assert.equal(decoded.rows[0].cellMetadata.some(cell => cell.type === 'formula'), false);
  report.exportedBytes = bytes.length; report.isolatedRoundTrip = true; report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; if (temporary) report.retainedRuntime = temporary; throw error;
} finally {
  process.chdir(root);
  if (temporary && report.status === 'passed') await rm(temporary, { recursive: true, force: true });
  await mkdir('.local', { recursive: true });
  await writeFile(process.argv[2] ?? '.local/master-bulk-runtime.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ status: report.status, buildId: report.buildId, runtimeFiles: report.runtimeFiles, routes: report.routes.length, isolatedRoundTrip: report.isolatedRoundTrip }));
