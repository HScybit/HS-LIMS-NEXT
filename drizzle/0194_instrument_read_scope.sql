-- Reuse the existing record predicate once per Instrument, rather than once for
-- every captured field, value, service and history row. The set is computed from
-- the current authenticated statement; it is never persisted or client supplied.
CREATE FUNCTION instruments_readable_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT item.id FROM public.instruments item
  WHERE item.organization_id=(SELECT public.organization_module_scope())
    AND public.instruments_can_read(item.id);
$$;
REVOKE ALL ON FUNCTION instruments_readable_ids() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION instruments_readable_ids() TO sampleify_app;
--> statement-breakpoint
DO $$ DECLARE relation text; id_column text; policy_name text; BEGIN
  FOREACH relation IN ARRAY ARRAY['instruments','instrument_versions','instrument_version_users',
    'instrument_version_services','instrument_version_service_roles','instrument_version_custom_fields',
    'instrument_version_custom_field_values'] LOOP
    id_column:=CASE WHEN relation='instruments' THEN 'id' ELSE 'instrument_id' END;
    policy_name:=CASE WHEN relation IN ('instrument_version_custom_fields','instrument_version_custom_field_values')
      THEN 'instrument_custom_field_read' ELSE 'instrument_read' END;
    EXECUTE format('ALTER POLICY %I ON %I USING
      (organization_id=(SELECT public.organization_module_scope())
        AND %I IN (SELECT permitted.id FROM public.instruments_readable_ids() AS permitted(id)))',
      policy_name,relation,id_column);
  END LOOP;
END $$;
