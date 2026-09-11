import { HttpError } from '../auth/errors.js';

export function customerAddressText(address) {
  return address.freeformAddress ?? [address.attentionTo, address.line1, address.line2, address.city, address.state, address.postalCode, address.countryCode].filter(Boolean).join(', ');
}

export async function sampleRegistrationOptions(client, identity) {
  if (!['samples.read', 'samples.create'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot load sample registration choices.');
  }
  const rows = async (query) => (await client.query(query, [identity.organization_id])).rows;
  // Ten fixed SELECTs. Relationships are batched and assembled once, never
  // fetched per product, parameter, customer or rendered control.
  const sampleCategories = await rows(`SELECT id, code, name, estimated_time_in_days AS "estimatedTimeInDays"
    FROM sample_categories WHERE organization_id=$1 AND active ORDER BY lower(name), id`);
  const customers = await rows(`SELECT id, code, name, legal_name AS "legalName" FROM customers WHERE organization_id=$1 AND active ORDER BY lower(name), id`);
  const addresses = await rows(`SELECT address.id, address.customer_id AS "customerId", address.address_type AS "addressType", address.attention_to AS "attentionTo",
    address.line_1 AS "line1", address.line_2 AS "line2", address.city, address.state, address.postal_code AS "postalCode", address.country_code AS "countryCode",
    address.freeform_address AS "freeformAddress", address.is_default AS "isDefault" FROM customer_addresses address JOIN customers customer
    ON customer.organization_id=address.organization_id AND customer.id=address.customer_id
    WHERE address.organization_id=$1 AND customer.active ORDER BY address.customer_id, address.is_default DESC, address.address_type, address.id`);
  const quotations = await rows(`SELECT quotation.id, quotation.customer_id AS "customerId", quotation.quotation_number AS "quotationNumber",
    quotation.quotation_date::text AS "quotationDate", quotation.currency_code AS "currencyCode", quotation.total_amount AS "totalAmount"
    FROM customer_quotations quotation JOIN customers customer ON customer.organization_id=quotation.organization_id AND customer.id=quotation.customer_id
    WHERE quotation.organization_id=$1 AND customer.active AND quotation.status='approved' AND (quotation.valid_until IS NULL OR quotation.valid_until>=current_date)
    ORDER BY quotation.customer_id, quotation.quotation_date DESC, quotation.quotation_number, quotation.id`);
  const products = await rows(`SELECT product.id, product.code, product.name, product.description,
    array_agg(DISTINCT category.sample_category_id ORDER BY category.sample_category_id) AS "sampleCategoryIds",
    coalesce(array_agg(DISTINCT tag.tag_id ORDER BY tag.tag_id) FILTER (WHERE tag.tag_id IS NOT NULL), '{}') AS "tagIds"
    FROM products product JOIN product_sample_categories category ON category.organization_id=product.organization_id AND category.product_id=product.id
    LEFT JOIN product_tags tag ON tag.organization_id=product.organization_id AND tag.product_id=product.id
    WHERE product.organization_id=$1 AND product.active GROUP BY product.id, product.code, product.name, product.description ORDER BY lower(product.name), product.id`);
  const tags = await rows(`SELECT id, name FROM tags WHERE organization_id=$1 AND active ORDER BY lower(name), id`);
  const measurementUnits = await rows(`SELECT id, code, name, symbol FROM measurement_units WHERE organization_id=$1 AND active ORDER BY lower(name), id`);
  const parameterRows = await rows(`SELECT parameter.id, parameter.code, parameter.name, parameter.measurement_unit_id AS "measurementUnitId",
    method.id AS "methodId", method.code AS "methodCode", method.name AS "methodName", mapping.is_default AS "isDefault"
    FROM test_parameters parameter LEFT JOIN parameter_methods mapping ON mapping.organization_id=parameter.organization_id AND mapping.test_parameter_id=parameter.id
    LEFT JOIN methods_of_analysis method ON method.organization_id=mapping.organization_id AND method.id=mapping.method_id AND method.active
    WHERE parameter.organization_id=$1 AND parameter.active
    ORDER BY parameter.display_order, lower(parameter.name), parameter.id, mapping.is_default DESC, lower(method.name), method.id`);
  const decisionRules = await rows(`SELECT rule.id, rule.name, rule.product_id AS "productId", rule.test_parameter_id AS "testParameterId", rule.method_id AS "methodId",
    rule.sample_category_id AS "sampleCategoryId", rule.is_nabl AS "isNabl", rule.minimum_size AS "minimumSize",
    rule.estimated_time_in_days AS "estimatedTimeInDays", rule.estimated_charges AS "estimatedCharges"
    FROM decision_rules rule JOIN products product ON product.organization_id=rule.organization_id AND product.id=rule.product_id AND product.active
    JOIN test_parameters parameter ON parameter.organization_id=rule.organization_id AND parameter.id=rule.test_parameter_id AND parameter.active
    WHERE rule.organization_id=$1 AND rule.active ORDER BY lower(rule.name), rule.id`);
  const laboratories = await rows(`SELECT id, code, name FROM laboratories WHERE organization_id=$1 AND active ORDER BY lower(name), id`);
  const customerById = new Map(customers.map((customer) => [customer.id, { ...customer, addresses: [], quotations: [] }]));
  for (const address of addresses) customerById.get(address.customerId)?.addresses.push({ id: address.id, addressType: address.addressType, isDefault: address.isDefault, text: customerAddressText(address) });
  for (const quotation of quotations) customerById.get(quotation.customerId)?.quotations.push(quotation);
  const parameters = new Map();
  for (const row of parameterRows) {
    if (!parameters.has(row.id)) parameters.set(row.id, { id: row.id, code: row.code, name: row.name, measurementUnitId: row.measurementUnitId, methods: [] });
    if (row.methodId) parameters.get(row.id).methods.push({ id: row.methodId, code: row.methodCode, name: row.methodName, isDefault: row.isDefault });
  }
  return { sampleCategories, customers: [...customerById.values()], products, tags, measurementUnits, testParameters: [...parameters.values()], decisionRules, laboratories };
}
