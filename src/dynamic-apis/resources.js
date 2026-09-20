// The fixed whitelist a sandboxed dynamic API may query via api.query(name,
// args) — deliberately small (Sample/Product/Customer/Test Parameter)
// rather than every collection Meteor's own version exposed. Each entry's
// sql name matches a SECURITY DEFINER function (migration 0215) that takes
// the caller's own already-resolved organization id as its first
// parameter — supplied here by trusted server code, never by the sandboxed
// script itself — and caps its own result size regardless of what's asked.
// Adding a resource later means one more SQL function plus one more entry
// here, not a change to the sandbox or its RPC bridge.
const normalizeText = (value) => (typeof value === 'string' && value.length <= 200 ? value : null);
const normalizeLimit = (value) => (Number.isInteger(value) && value > 0 ? value : null);

export const dynamicApiResources = {
  samples: { sql: 'dynamic_api_list_samples', args: (args) => [normalizeText(args?.status), normalizeLimit(args?.limit)] },
  products: { sql: 'dynamic_api_list_products', args: (args) => [normalizeText(args?.search), normalizeLimit(args?.limit)] },
  customers: { sql: 'dynamic_api_list_customers', args: (args) => [normalizeText(args?.search), normalizeLimit(args?.limit)] },
  testParameters: { sql: 'dynamic_api_list_test_parameters', args: (args) => [normalizeText(args?.search), normalizeLimit(args?.limit)] },
};

export async function executeWhitelistedQuery(client, organizationId, resource, args) {
  const entry = dynamicApiResources[resource];
  if (!entry) throw new Error(`Unknown resource "${resource}". Available resources: ${Object.keys(dynamicApiResources).join(', ')}.`);
  const parameters = entry.args(typeof args === 'object' && args !== null ? args : {});
  const result = await client.query(`SELECT * FROM ${entry.sql}($1,$2,$3)`, [organizationId, ...parameters]);
  return result.rows;
}
