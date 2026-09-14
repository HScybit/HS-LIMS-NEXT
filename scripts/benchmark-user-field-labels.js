import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool } from '../src/db/pool.js';
import { loadUserFieldUserLabels } from '../src/users/custom-fields.js';

const owner = ownerPool(); const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, synthetic: true, cases: [],
  conditions: 'Run alone on dedicated synthetic PostgreSQL. One warmup/five samples,10000 actual member rows with160-character names and mixed identity/membership activity, explicit ANALYZE after setup. Authenticated users.read, read-only repeatable-read transaction, normalization, SQL/driver, assembly, commit and JSON serialization included. Setup, verification and socket/browser transfer excluded. No credentials or sign-in capability are created for bulk selected-user fixtures. Service queries exclude authentication queries whose time is included.' };
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
try {
  report.postgres = (await owner.query('SHOW server_version')).rows[0].server_version;
  const reader = await createAccount(owner, { permissions: ['users.read'] }); const session = await signIn({ identifier: reader.username, password: reader.password });
  const prefix = 'fieldlabels-' + randomUUID() + '-'; const at = performance.now();
  const people = (await owner.query(`INSERT INTO users(id,username,email,display_name,active)
    SELECT gen_random_uuid(),$1||lpad(n::text,5,'0'),$1||n||'@example.invalid',rpad('Selected_user_'||lpad(n::text,5,'0'),160,'x'),n%5<>0
    FROM generate_series(1,10000) n RETURNING id,username,display_name`, [prefix])).rows.sort((a,b) => a.username.localeCompare(b.username));
  await owner.query(`INSERT INTO memberships(organization_id,user_id,active)
    SELECT $1,id,position%3<>0 FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position)`, [reader.organizationId, people.map(person => person.id)]);
  const analyzeAt = performance.now(); await owner.query('ANALYZE users,memberships');
  report.fixture = { organizationId: reader.organizationId, members: people.length, nameCharacters: 160, setupMs: performance.now()-at, analyzeMs: performance.now()-analyzeAt };
  for (const [count, missing, budgetMs] of [[0,false,50],[100,false,100],[500,false,250],[5000,false,750],[5000,true,750]]) {
    const selected = people.slice(0,count).reverse(); const ids = missing ? selected.map(() => randomUUID()) : selected.map(person => person.id);
    const expected = missing ? [] : selected.map(person => ({ id: person.id, name: person.display_name }));
    const entry = { count, missing, budgetMs, samples: [] }; report.cases.push(entry);
    for (let index=0; index<6; index++) {
      let queries=0; let sqlMs=0; const started=performance.now();
      const result = await withSession(session.token, (client,identity) => loadUserFieldUserLabels({ async query(...args) {
        queries++; const at=performance.now(); const result=await client.query(...args); sqlMs+=performance.now()-at; return result;
      } },identity,{ids}), {readOnly:true});
      const body=JSON.stringify(result); const sample={totalMs:performance.now()-started,sqlMs,queries,bytes:Buffer.byteLength(body)};
      assert.deepEqual(result,{rows:expected}); assert.equal(queries,count ? 1 : 0);
      if(index)entry.samples.push(sample);else entry.warmup=sample;
    }
    entry.metrics=Object.fromEntries(['totalMs','sqlMs','queries','bytes'].map(key=>[key,p95(entry.samples.map(sample=>sample[key]))]));
    entry.passed=entry.metrics.totalMs<=budgetMs; console.log(JSON.stringify({count,missing,budgetMs,...entry.metrics,passed:entry.passed}));
  }
  report.status=report.cases.every(entry=>entry.passed)?'passed':'failed';if(report.status!=='passed')throw new Error('Selected user-label budgets failed. Preserve the report and diagnose.');
}catch(error){report.status='failed';report.error=error.message;throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile('.local/user-field-labels-performance.json',JSON.stringify(report,null,2)+'\n');await closePool();await owner.end();}
