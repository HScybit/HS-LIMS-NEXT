import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAccount } from './database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { saveNablCertification } from '../../src/compliance/nabl.js';

export async function createNablPerformanceFixture(owner, count, scopeCount) {
  assert.match(process.env.SAMPLEIFY_TEST_DATABASE_NAME ?? '', /^sampleify_verify_[a-f0-9]{32}$/);
  assert([100, 10000].includes(count)); assert(scopeCount > 0 && scopeCount <= count && scopeCount <= 2000);
  const actor = await createAccount(owner, { permissions: ['compliance.manage'] });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  const client = await owner.connect(); let parameters; let products; let methods; let certifications;
  try {
    await client.query('BEGIN'); await client.query('SELECT * FROM auth_session_context($1)', [hashToken(actor.token)]);
    parameters = (await client.query(`INSERT INTO test_parameters(organization_id,code,name,master_key,scheme_abbreviation,display_order)
      SELECT $1,'PARAM-'||number,rpad('Parameter '||lpad(number::text,5,'0')||' ',250,'P'),'KEY-'||number,'SCHEME-'||number,number
      FROM generate_series(1,$2::integer) number RETURNING id,display_order`, [actor.organizationId, count])).rows.sort((a, b) => a.display_order - b.display_order).map(row => row.id);
    products = (await client.query(`INSERT INTO products(organization_id,code,name)
      SELECT $1,'PRODUCT-'||number,rpad('Product '||lpad(number::text,5,'0')||' ',250,'P') FROM generate_series(1,$2::integer) number RETURNING id,code`, [actor.organizationId, count])).rows.sort((a, b) => Number(a.code.slice(8)) - Number(b.code.slice(8))).map(row => row.id);
    methods = (await client.query(`INSERT INTO methods_of_analysis(organization_id,code,name,method_uuid)
      SELECT $1,'METHOD-'||number,rpad('Method '||lpad(number::text,5,'0')||' ',250,'M'),gen_random_uuid()::text FROM generate_series(1,$2::integer) number RETURNING id,code`, [actor.organizationId, count])).rows.sort((a, b) => Number(a.code.slice(7)) - Number(b.code.slice(7))).map(row => row.id);
    await client.query(`INSERT INTO decision_rules(organization_id,code,name,test_parameter_id,product_id,method_id)
      SELECT $1,gen_random_uuid()::text,'Performance scope rule',$2,item.product_id,item.method_id FROM unnest($3::uuid[],$4::uuid[]) item(product_id,method_id)`, [actor.organizationId, parameters[0], products, methods]);
    await client.query(`INSERT INTO decision_rules(organization_id,code,name,test_parameter_id,product_id,method_id)
      SELECT $1,gen_random_uuid()::text,'Performance scope rule',parameter_id,item.product_id,item.method_id
      FROM unnest($2::uuid[]) parameter_id CROSS JOIN unnest($3::uuid[],$4::uuid[]) item(product_id,method_id)`,
    [actor.organizationId, parameters.slice(1, scopeCount), products.slice(0, 2), methods.slice(0, 2)]);
    // These are actual synthetic creates in this transaction, with authentic
    // actor/time guards and complete empty first versions. No triggers are disabled.
    certifications = (await client.query(`INSERT INTO nabl_certifications(organization_id,id,created_by)
      SELECT $1,gen_random_uuid(),$2 FROM generate_series(1,$3::integer) RETURNING id`, [actor.organizationId, actor.userId, count])).rows.map(row => row.id);
    await client.query(`INSERT INTO nabl_certificate_versions(organization_id,certification_id,revision,request_id,operation,valid_from,valid_to,scope_count,active,saved_by,saved_by_username,saved_by_name)
      SELECT $1,certificate.id,1,gen_random_uuid(),'create',DATE '2024-02-29',DATE '2026-09-16',0,true,$2,actor.username,actor.display_name
      FROM unnest($3::uuid[]) certificate(id) CROSS JOIN users actor WHERE actor.id=$2`, [actor.organizationId, actor.userId, certifications]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const command = { id: certifications[0], revision: 1, requestId: randomUUID(), validFrom: '2024-02-29', validTo: '2026-09-16', scopeFileId: null, certificateFileId: null,
    scopes: parameters.slice(0, scopeCount).map(parameterId => ({ parameterId, productIds: products.slice(0, 2), methodIds: methods.slice(0, 2) })) };
  const original = await withSession(actor.token, (client, identity) => saveNablCertification(client, identity, command), { csrfToken: actor.csrfToken });
  assert.equal(original.scopes.length, scopeCount); assert(original.scopes.every(row => row.parameterName.length === 250 && row.products.length === 2 && row.methods.length === 2));
  for (const table of ['nabl_certifications', 'nabl_certificate_versions', 'nabl_scope_rows', 'nabl_scope_products', 'nabl_scope_methods', 'test_parameters', 'products', 'methods_of_analysis', 'decision_rules']) await owner.query(`ANALYZE ${table}`);
  return { actor, command, original, count, scopeCount, firstParameterId: parameters[0] };
}
