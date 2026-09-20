import { calculateSampleReportingDate } from './reporting-date.js';

export async function sampleReportingDate(client, organizationId, categoryId, products, tests, receivedAt) {
  const productIds = new Map(products.map(product => [product.id, product.productId]));
  const selectedProducts = tests.map(test => productIds.get(test.sampleProductId));
  const selectedParameters = tests.map(test => test.testParameterId);
  const selectedMethods = tests.map(test => test.methodId);
  const unique = values => [...new Set(values)];
  // The source queries the three sets, not only exact selected triples. Even
  // an unmatched rule in that cross-set query suppresses row-estimate fallback.
  // Reduce inside PostgreSQL so many category-specific rules and huge numeric
  // values cannot create an unbounded application result.
  const { rows: [estimate] } = await client.query(`WITH reporting_rules AS MATERIALIZED (
      SELECT product_id,test_parameter_id,method_id,active,updated_at,created_at,id,
        CASE WHEN estimated_time_in_days>0 AND pg_input_is_valid(estimated_time_in_days::text,'double precision')
          THEN estimated_time_in_days::double precision END AS days
      FROM decision_rules WHERE organization_id=$1 AND product_id=ANY($2::uuid[])
        AND test_parameter_id=ANY($3::uuid[]) AND method_id=ANY($4::uuid[])
    ), chosen AS (
      SELECT DISTINCT ON (product_id,test_parameter_id,method_id) product_id,test_parameter_id,method_id,days
      FROM reporting_rules ORDER BY product_id,test_parameter_id,method_id,(days IS NOT NULL) DESC,
        active DESC,updated_at DESC,created_at DESC,id DESC
    ) SELECT EXISTS(SELECT 1 FROM reporting_rules) AS "hasRules",
      (SELECT max(chosen.days) FROM chosen JOIN unnest($5::uuid[],$6::uuid[],$7::uuid[])
        AS selected(product_id,test_parameter_id,method_id) USING(product_id,test_parameter_id,method_id)) AS "parameterDays",
      (SELECT max(estimated_time_in_days) FROM sample_categories WHERE organization_id=$1 AND id=ANY($8::uuid[])) AS "categoryDays",
      CASE WHEN $9::timestamptz>='0001-01-01T00:00:00Z'::timestamptz AND $9::timestamptz<'10000-01-01T00:00:00Z'::timestamptz
        THEN to_char($9::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD') END AS "receivedDate"`,
  [organizationId, unique(selectedProducts), unique(selectedParameters), unique(selectedMethods), selectedProducts, selectedParameters,
    selectedMethods, unique([categoryId, ...products.map(product => product.sampleCategoryId)]), receivedAt]);
  const parameterDays = estimate.hasRules ? estimate.parameterDays
    : Math.max(0, ...tests.map(test => (test.estimatedDurationMinutes ?? 0) / 480));
  const days = parameterDays > 0 ? parameterDays : estimate.categoryDays > 0 ? estimate.categoryDays : null;
  // PostgreSQL rounds sub-microsecond inputs before storing them. Use that
  // canonical day, including rounding across midnight, in the same query.
  return calculateSampleReportingDate(estimate.receivedDate, days);
}
