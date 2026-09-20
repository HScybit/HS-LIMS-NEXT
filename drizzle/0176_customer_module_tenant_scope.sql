-- Keep this row check separate from equality conditions on the mutable legacy
-- organization setting: those can become a one-time filter during planning.
-- organization_id is NOT NULL, so an absent authenticated scope still denies.
ALTER POLICY customer_module_insert ON customers
  WITH CHECK(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
ALTER POLICY customer_module_update ON customers
  USING(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()))
  WITH CHECK(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
ALTER POLICY customer_module_delete ON customers
  USING(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
ALTER POLICY customer_module_insert ON customer_addresses
  WITH CHECK(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
ALTER POLICY customer_module_update ON customer_addresses
  USING(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()))
  WITH CHECK(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
ALTER POLICY customer_module_delete ON customer_addresses
  USING(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
ALTER POLICY customer_module_insert ON customer_contacts
  WITH CHECK(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
ALTER POLICY customer_module_update ON customer_contacts
  USING(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()))
  WITH CHECK(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
ALTER POLICY customer_module_delete ON customer_contacts
  USING(organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope()) AND (SELECT public.masters_require_customer_write()));
