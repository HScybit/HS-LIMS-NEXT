import { getTableName } from 'drizzle-orm';

export async function lockReferences(client, table, ids) {
  const selected = [...new Set(ids.filter(Boolean))].sort();
  if (selected.length) await client.query('SELECT laboratory_lock_references($1, $2::uuid[])', [getTableName(table), selected]);
}
