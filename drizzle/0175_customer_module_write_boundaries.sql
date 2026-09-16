-- Module write checks must observe revocations after acquiring their locks.
CREATE OR REPLACE FUNCTION organization_require_module_access(requested_module text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.organization_module_scope(); actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF current_setting('transaction_isolation') IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'Module-authorized writes require statement snapshots'
      USING ERRCODE='25001',CONSTRAINT='module_access_write_isolation';
  END IF;
  IF org IS NULL THEN
    RAISE EXCEPTION 'Configured module access required' USING ERRCODE='42501',CONSTRAINT='organization_module_access_required';
  END IF;
  PERFORM 1 FROM public.users WHERE id=actor FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR SHARE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  IF org IS NULL OR public.organization_module_scope() IS DISTINCT FROM org OR NOT public.organization_has_module_access(requested_module) THEN
    RAISE EXCEPTION 'Configured module access required' USING ERRCODE='42501',CONSTRAINT='organization_module_access_required';
  END IF;
  RETURN actor;
END $$;
--> statement-breakpoint
CREATE FUNCTION masters_require_customer_write() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.masters_lock_field_writer();
  PERFORM public.organization_require_module_access('customer');
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION masters_require_customer_write() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_require_customer_write() TO sampleify_app;
--> statement-breakpoint
-- Restrictive policies add to the existing tenant/action checks. They do not
-- change scientific reference reads or the separately gated quick command.
CREATE POLICY customer_module_insert ON customers AS RESTRICTIVE FOR INSERT TO sampleify_app
  WITH CHECK((SELECT public.masters_require_customer_write()));
CREATE POLICY customer_module_update ON customers AS RESTRICTIVE FOR UPDATE TO sampleify_app
  USING((SELECT public.masters_require_customer_write())) WITH CHECK((SELECT public.masters_require_customer_write()));
CREATE POLICY customer_module_delete ON customers AS RESTRICTIVE FOR DELETE TO sampleify_app
  USING((SELECT public.masters_require_customer_write()));
CREATE POLICY customer_module_insert ON customer_addresses AS RESTRICTIVE FOR INSERT TO sampleify_app
  WITH CHECK((SELECT public.masters_require_customer_write()));
CREATE POLICY customer_module_update ON customer_addresses AS RESTRICTIVE FOR UPDATE TO sampleify_app
  USING((SELECT public.masters_require_customer_write())) WITH CHECK((SELECT public.masters_require_customer_write()));
CREATE POLICY customer_module_delete ON customer_addresses AS RESTRICTIVE FOR DELETE TO sampleify_app
  USING((SELECT public.masters_require_customer_write()));
CREATE POLICY customer_module_insert ON customer_contacts AS RESTRICTIVE FOR INSERT TO sampleify_app
  WITH CHECK((SELECT public.masters_require_customer_write()));
CREATE POLICY customer_module_update ON customer_contacts AS RESTRICTIVE FOR UPDATE TO sampleify_app
  USING((SELECT public.masters_require_customer_write())) WITH CHECK((SELECT public.masters_require_customer_write()));
CREATE POLICY customer_module_delete ON customer_contacts AS RESTRICTIVE FOR DELETE TO sampleify_app
  USING((SELECT public.masters_require_customer_write()));
