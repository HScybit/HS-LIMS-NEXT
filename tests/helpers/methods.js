import { randomUUID } from 'node:crypto';

export async function createAlternateMethod(owner, account, fixture, { name = 'Synthetic alternate method', applicable = true, active = true } = {}) {
  const method = (await owner.query(`INSERT INTO methods_of_analysis(organization_id,code,name,method_uuid,decimal_scale,parse_number,active)
    VALUES($1,$2,$3,$2,3,false,$4) RETURNING *`, [account.organizationId, randomUUID(), name, active])).rows[0];
  if (applicable) await owner.query('INSERT INTO parameter_methods(organization_id,test_parameter_id,method_id) VALUES($1,$2,$3)',
    [account.organizationId, fixture.parameter.id, method.id]);
  return method;
}
