-- Configured party access protects the complete master record. Laboratory
-- consumers use the explicit scientific projections below.
CREATE FUNCTION masters_can_read_party(requested_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT requested_module IN ('customer','vendor')
    AND (public.app_has_permission('masters.read') OR public.app_has_permission('masters.manage'))
    AND public.organization_has_module_access(requested_module)
$$;
CREATE FUNCTION laboratory_can_read_customer_reference() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT public.laboratory_can_read() OR public.app_has_permission('samples.create')
    OR public.masters_can_read_party('customer')
$$;
REVOKE ALL ON FUNCTION masters_can_read_party(text),laboratory_can_read_customer_reference()
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_can_read_party(text),laboratory_can_read_customer_reference() TO sampleify_app;
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['customers','customer_addresses','customer_contacts'] LOOP
    EXECUTE format('CREATE POLICY customer_module_read ON %I AS RESTRICTIVE FOR SELECT TO sampleify_app USING
      (organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope())
        AND (SELECT public.masters_can_read_party(''customer'')))',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE VIEW laboratory_customer_references WITH (security_barrier=true,security_invoker=false) AS
  SELECT customer.organization_id,customer.id,customer.code,customer.name,customer.legal_name,customer.active
  FROM public.customers customer
  WHERE customer.organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope())
    AND (SELECT public.laboratory_can_read_customer_reference());
CREATE VIEW laboratory_customer_address_references WITH (security_barrier=true,security_invoker=false) AS
  SELECT address.organization_id,address.id,address.customer_id,address.address_type,address.attention_to,
    address.line_1,address.line_2,address.city,address.state,address.postal_code,address.country_code,
    address.freeform_address,address.is_default
  FROM public.customer_addresses address
  WHERE address.organization_id IS NOT DISTINCT FROM (SELECT public.organization_module_scope())
    AND (SELECT public.laboratory_can_read_customer_reference());
REVOKE ALL ON laboratory_customer_references,laboratory_customer_address_references FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON laboratory_customer_references,laboratory_customer_address_references TO sampleify_app;
