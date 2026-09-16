import { randomUUID } from 'node:crypto';
import { database } from '../../src/db/pool.js';
import { products, testParameters, methodsOfAnalysis, decisionRules } from '../../src/db/master-schema.js';

export async function createNablReferences(owner, actor, { parameterCount = 3 } = {}) {
  const client = await owner.connect(); const organizationId = actor.organizationId;
  const record = name => ({ organizationId, code: randomUUID(), name });
  try {
    await client.query('BEGIN'); const db = database(client);
    const productRows = await db.insert(products).values([record('Product A'), record('Product B')]).returning();
    const methodRows = await db.insert(methodsOfAnalysis).values(['Method A', 'Method B'].map(name => ({ ...record(name), methodUuid: randomUUID() }))).returning();
    const parameters = await db.insert(testParameters).values(Array.from({ length: parameterCount }, (_, index) => ({ ...record(`Parameter ${index + 1}`), masterKey: randomUUID(), schemeAbbreviation: `S${index + 1}`, displayOrder: index }))).returning();
    const rules = await db.insert(decisionRules).values(parameters.flatMap(parameter => productRows.map((product, index) => ({ ...record('Scope rule'), productId: product.id, testParameterId: parameter.id, methodId: methodRows[index].id })))).returning();
    await client.query('COMMIT'); return { parameters, products: productRows, methods: methodRows, rules };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export const nablCommand = (changes = {}) => ({ id: randomUUID(), revision: 0, requestId: randomUUID(), validFrom: '2024-02-29', validTo: '2026-09-16', scopeFileId: null, certificateFileId: null, scopes: [], ...changes });

// Deliberately bypass the public command's normalized arrays to exercise the
// deferred database boundary, with authentic synthetic actor/time observations.
export const nablCompletenessCases = [
  { name: 'empty certification', valid: true, scopes: [] },
  { name: 'empty selections', valid: true, scopes: [{}] },
  { name: 'one-sided and complete scopes', valid: true, scopes: [{ methods: [0, 1] }, { products: [0, 1], methods: [0] }] },
  { name: 'missing scope', scopeCount: 2, scopes: [{}] },
  { name: 'extra scope', scopeCount: 0, scopes: [{}] },
  { name: 'scope starts after zero', scopes: [{ position: 1 }] },
  { name: 'scope position gap', scopes: [{ position: 0 }, { position: 2 }] },
  { name: 'missing product', scopes: [{ productCount: 1 }] },
  { name: 'extra product', scopes: [{ productCount: 0, products: [0] }] },
  { name: 'product starts after zero', scopes: [{ products: [1] }] },
  { name: 'product position gap', scopes: [{ products: [0, 2] }] },
  { name: 'product counts belong to their parameter', scopes: [{ productCount: 1 }, { productCount: 0, products: [0] }] },
  { name: 'missing method', scopes: [{ methodCount: 1 }] },
  { name: 'extra method', scopes: [{ methodCount: 0, methods: [0] }] },
  { name: 'method starts after zero', scopes: [{ methods: [1] }] },
  { name: 'method position gap', scopes: [{ methods: [0, 2] }] },
  { name: 'method counts belong to their parameter', scopes: [{ methodCount: 1 }, { methodCount: 0, methods: [0] }] },
  { name: 'product and method counts are separate', scopes: [{ productCount: 1, methodCount: 0, methods: [0] }] },
];

export async function insertNablCompletenessFixture(client, actor, refs, id, input) {
  await client.query('INSERT INTO nabl_certifications(organization_id,id,created_by) VALUES($1,$2,$3)', [actor.organizationId, id, actor.userId]);
  await client.query(`INSERT INTO nabl_certificate_versions(organization_id,certification_id,revision,request_id,operation,valid_from,valid_to,scope_count,active,saved_by,saved_by_username,saved_by_name)
    SELECT $1,$2,1,$3,'create',DATE '2024-02-29',DATE '2026-09-16',$4,true,id,username,display_name FROM users WHERE id=$5`,
  [actor.organizationId, id, randomUUID(), input.scopeCount ?? input.scopes.length, actor.userId]);
  for (const [index, item] of input.scopes.entries()) {
    const parameter = refs.parameters[index];
    await client.query(`INSERT INTO nabl_scope_rows(organization_id,certification_id,revision,parameter_id,position,parameter_name,scheme_abbreviation,parameter_revision,product_count,method_count)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`, [actor.organizationId, id, parameter.id, item.position ?? index, parameter.name, parameter.schemeAbbreviation,
      parameter.revision, item.productCount ?? item.products?.length ?? 0, item.methodCount ?? item.methods?.length ?? 0]);
    for (const [kind, singular] of [['products', 'product'], ['methods', 'method']]) {
      for (const [referenceIndex, position] of (item[kind] ?? []).entries()) {
        const reference = refs[kind][referenceIndex];
        await client.query(`INSERT INTO nabl_scope_${kind}(organization_id,certification_id,revision,parameter_id,${singular}_id,position,${singular}_name,${singular}_revision)
          VALUES($1,$2,1,$3,$4,$5,$6,$7)`, [actor.organizationId, id, parameter.id, reference.id, position, reference.name, reference.revision]);
      }
    }
  }
}
