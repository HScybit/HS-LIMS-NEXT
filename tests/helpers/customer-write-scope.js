import { randomUUID } from 'node:crypto';

// One fixture per side permits the same SQL to exercise two authorized rows or
// an authorized first row followed by a change to a foreign organization.
export async function seedCustomerScopeRows(owner, organizationId) {
  const customerId = randomUUID(); const parentId = randomUUID(); const addressId = randomUUID(); const contactId = randomUUID();
  await owner.query("INSERT INTO customers(organization_id,id,code,name,legal_name) SELECT $1,id,id::text,'Synthetic scope customer','Synthetic legal name' FROM unnest($2::uuid[]) selected(id)", [organizationId, [customerId, parentId]]);
  await owner.query("INSERT INTO customer_addresses(organization_id,id,customer_id,address_type,freeform_address) VALUES($1,$2,$3,'shipping','Synthetic scope address')", [organizationId, addressId, parentId]);
  await owner.query("INSERT INTO customer_contacts(organization_id,id,customer_id,name,phone) VALUES($1,$2,$3,'Synthetic scope contact','123')", [organizationId, contactId, parentId]);
  return { organizationId, customerId, parentId, addressId, contactId };
}

export function customerScopeCommands(own, target) {
  const organization = "CASE WHEN position=1 THEN $1::uuid ELSE set_config('app.organization_id',$2,true)::uuid END";
  const parent = 'CASE WHEN position=1 THEN $3::uuid ELSE $4::uuid END';
  const values = [own.organizationId, target.organizationId, own.parentId, target.parentId];
  const inserts = [
    { name: 'customer insert', sql: `INSERT INTO customers(organization_id,id,code,name,legal_name)
      SELECT ${organization},gen_random_uuid(),$3||'-'||position,'Synthetic scope insert','Synthetic legal name'
      FROM generate_series(1,2) selected(position) RETURNING organization_id`, values: [...values.slice(0, 2), randomUUID()] },
    { name: 'address insert', sql: `INSERT INTO customer_addresses(organization_id,id,customer_id,address_type,freeform_address)
      SELECT ${organization},gen_random_uuid(),${parent},'billing','Synthetic scope insert'
      FROM generate_series(1,2) selected(position) RETURNING organization_id`, values },
    { name: 'contact insert', sql: `INSERT INTO customer_contacts(organization_id,id,customer_id,name,phone)
      SELECT ${organization},gen_random_uuid(),${parent},'Synthetic scope insert','123'
      FROM generate_series(1,2) selected(position) RETURNING organization_id`, values },
  ];
  return [...inserts, ...[
    ['customers', 'customerId', "name='Synthetic scope update',revision=revision+1"],
    ['customer_addresses', 'addressId', "freeform_address='Synthetic scope update'"],
    ['customer_contacts', 'contactId', "phone='456'"],
  ].flatMap(([table, key, changes]) => ['update', 'delete'].map(action => ({
    name: `${table} ${action}`, sql: `${action === 'update' ? `UPDATE ${table} SET ${changes}` : `DELETE FROM ${table}`}
      WHERE id=ANY($1::uuid[]) RETURNING organization_id,set_config('app.organization_id',$2,true) AS attempted_scope`,
    values: [[own[key], target[key]], target.organizationId],
  })))];
}
