-- Step 10i: Dynamic API management. An admin-authored, sandboxed HTTP
-- endpoint — genuinely unlike everything else in this migration, since it
-- lets an org admin execute their own JavaScript against this
-- organization's own data on every call. draft_code is what's edited;
-- live_code/published_at/published_by only change on an explicit publish,
-- so an in-progress edit never affects an already-published integration.
INSERT INTO permissions(code,description) VALUES
  ('dynamic_apis.read','View dynamic APIs, their code and invocation history'),
  ('dynamic_apis.manage','Author, publish and manage dynamic APIs and their tokens')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE dynamic_apis (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url_key text NOT NULL,
  http_method text NOT NULL,
  draft_code text NOT NULL,
  live_code text,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  published_by uuid,
  published_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT dynamic_apis_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT dynamic_api_created_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT dynamic_api_updated_actor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT dynamic_api_published_actor_fk FOREIGN KEY(organization_id,published_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT dynamic_api_route_key UNIQUE(organization_id,url_key,http_method),
  CONSTRAINT dynamic_api_fields CHECK (length(trim(name)) BETWEEN 1 AND 200
    AND url_key ~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'
    AND http_method IN ('GET','POST','PUT','PATCH','DELETE')
    AND length(draft_code) BETWEEN 1 AND 65536 AND (live_code IS NULL OR length(live_code) BETWEEN 1 AND 65536)
    AND (published_by IS NULL AND published_at IS NULL AND live_code IS NULL
      OR published_by IS NOT NULL AND published_at IS NOT NULL AND live_code IS NOT NULL)
    AND revision > 0)
);
CREATE INDEX dynamic_api_listing ON dynamic_apis(organization_id,name);
CREATE TABLE dynamic_api_tokens (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  api_id uuid NOT NULL,
  label text,
  token_hash text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT dynamic_api_tokens_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT dynamic_api_token_api_fk FOREIGN KEY(organization_id,api_id) REFERENCES dynamic_apis(organization_id,id),
  CONSTRAINT dynamic_api_token_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT dynamic_api_token_hash_key UNIQUE(token_hash),
  CONSTRAINT dynamic_api_token_fields CHECK ((label IS NULL OR length(trim(label)) BETWEEN 1 AND 200) AND length(token_hash)=64)
);
CREATE INDEX dynamic_api_token_listing ON dynamic_api_tokens(organization_id,api_id);
CREATE TABLE dynamic_api_invocations (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  api_id uuid NOT NULL,
  is_test_run boolean NOT NULL,
  status text NOT NULL,
  error_message text,
  log_output text,
  duration_ms integer NOT NULL,
  invoked_by uuid,
  invoked_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT dynamic_api_invocations_pkey PRIMARY KEY(organization_id,id),
  CONSTRAINT dynamic_api_invocation_api_fk FOREIGN KEY(organization_id,api_id) REFERENCES dynamic_apis(organization_id,id),
  CONSTRAINT dynamic_api_invocation_actor_fk FOREIGN KEY(organization_id,invoked_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT dynamic_api_invocation_fields CHECK (status IN ('succeeded','failed','timed_out')
    AND (log_output IS NULL OR length(log_output)<=20000) AND duration_ms >= 0
    AND (status = 'succeeded' OR error_message IS NOT NULL))
);
CREATE INDEX dynamic_api_invocation_listing ON dynamic_api_invocations(organization_id,api_id,invoked_at);
--> statement-breakpoint
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['dynamic_apis','dynamic_api_tokens','dynamic_api_invocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY dynamic_api_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''dynamic_apis.read'') OR app_has_permission(''dynamic_apis.manage'')))',relation);
    EXECUTE format('CREATE POLICY dynamic_api_write ON %I FOR ALL TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''dynamic_apis.manage'')))
      WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT app_has_permission(''dynamic_apis.manage'')))',relation);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO sampleify_app',relation);
  END LOOP;
END $$;
--> statement-breakpoint
-- A live call arrives with a bearer token, not a user session — there is no
-- app.organization_id/app.user_id to gate a normal RLS-scoped query with.
-- This SECURITY DEFINER function is the sole entry point that resolves a
-- token to its organization: it bypasses RLS internally (as its own
-- privileged operation) but returns nothing for an unknown/revoked token,
-- and every whitelisted read below takes that ALREADY-RESOLVED organization
-- id as an explicit parameter from trusted server code, never from the
-- sandboxed request itself.
CREATE FUNCTION dynamic_api_authenticate(p_token_hash text) RETURNS TABLE(
  organization_id uuid, api_id uuid, url_key text, http_method text, live_code text, enabled boolean
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE token public.dynamic_api_tokens;
BEGIN
  SELECT * INTO token FROM public.dynamic_api_tokens WHERE token_hash=p_token_hash AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  -- Bare "organization_id" here is ambiguous: the RETURNS TABLE's own
  -- organization_id OUT parameter is in scope as a PL/pgSQL variable for the
  -- whole function body, colliding with the table column of the same name
  -- (42702) unless the table is qualified via its alias.
  UPDATE public.dynamic_api_tokens t SET last_used_at=now() WHERE t.organization_id=token.organization_id AND t.id=token.id;
  RETURN QUERY SELECT api.organization_id, api.id, api.url_key, api.http_method, api.live_code, api.enabled
    FROM public.dynamic_apis api WHERE api.organization_id=token.organization_id AND api.id=token.api_id;
END $$;
REVOKE ALL ON FUNCTION dynamic_api_authenticate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dynamic_api_authenticate(text) TO sampleify_app;
--> statement-breakpoint
-- Whitelisted, read-only, explicitly-scoped queries a sandboxed dynamic API
-- may request via the trusted RPC bridge (never direct table access). Each
-- takes the caller's own already-resolved organization id as a parameter
-- (supplied by trusted server code, not by the sandboxed script) and caps
-- its own result size regardless of what the script asks for. This is a
-- deliberately small starting whitelist (Sample/Product/Customer/Test
-- Parameter) rather than every collection Meteor's own version exposed —
-- easy to extend later with one more function per resource.
CREATE FUNCTION dynamic_api_list_samples(p_organization_id uuid, p_status text, p_limit integer) RETURNS TABLE(
  id uuid, sample_number text, sample_type text, status text, customer_name text, received_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id, sample_number, sample_type, status, customer_name, received_at FROM public.samples
  WHERE organization_id=p_organization_id AND (p_status IS NULL OR status=p_status)
  ORDER BY received_at DESC, id LIMIT LEAST(coalesce(p_limit,20),200)
$$;
CREATE FUNCTION dynamic_api_list_products(p_organization_id uuid, p_search text, p_limit integer) RETURNS TABLE(
  id uuid, code text, name text, active boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id, code, name, active FROM public.products
  WHERE organization_id=p_organization_id AND (p_search IS NULL OR name ILIKE '%'||replace(replace(p_search,'\','\\'),'%','\%')||'%' ESCAPE '\')
  ORDER BY name LIMIT LEAST(coalesce(p_limit,20),200)
$$;
CREATE FUNCTION dynamic_api_list_customers(p_organization_id uuid, p_search text, p_limit integer) RETURNS TABLE(
  id uuid, code text, name text, active boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id, code, name, active FROM public.customers
  WHERE organization_id=p_organization_id AND (p_search IS NULL OR name ILIKE '%'||replace(replace(p_search,'\','\\'),'%','\%')||'%' ESCAPE '\')
  ORDER BY name LIMIT LEAST(coalesce(p_limit,20),200)
$$;
CREATE FUNCTION dynamic_api_list_test_parameters(p_organization_id uuid, p_search text, p_limit integer) RETURNS TABLE(
  id uuid, code text, name text, active boolean
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id, code, name, active FROM public.test_parameters
  WHERE organization_id=p_organization_id AND (p_search IS NULL OR name ILIKE '%'||replace(replace(p_search,'\','\\'),'%','\%')||'%' ESCAPE '\')
  ORDER BY name LIMIT LEAST(coalesce(p_limit,20),200)
$$;
DO $$ DECLARE routine text; BEGIN
  FOREACH routine IN ARRAY ARRAY['dynamic_api_list_samples(uuid,text,integer)','dynamic_api_list_products(uuid,text,integer)',
    'dynamic_api_list_customers(uuid,text,integer)','dynamic_api_list_test_parameters(uuid,text,integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO sampleify_app',routine);
  END LOOP;
END $$;
--> statement-breakpoint
-- Invocation history must survive even when the invocation itself failed —
-- but the service call that records a failure immediately re-throws, and
-- that throw rolls back the whole enclosing request transaction, including
-- anything inserted earlier in it. Recording through this SECURITY DEFINER
-- function on its own separate connection (never the request's own client)
-- is what lets the audit row commit independently of whether the request
-- that produced it ultimately succeeds or fails.
CREATE FUNCTION dynamic_api_record_invocation(p_organization_id uuid, p_api_id uuid, p_is_test_run boolean,
  p_status text, p_error_message text, p_log_output text, p_duration_ms integer, p_invoked_by uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.dynamic_api_invocations(organization_id, api_id, is_test_run, status, error_message, log_output, duration_ms, invoked_by)
  VALUES(p_organization_id, p_api_id, p_is_test_run, p_status, p_error_message, p_log_output, p_duration_ms, p_invoked_by)
$$;
REVOKE ALL ON FUNCTION dynamic_api_record_invocation(uuid,uuid,boolean,text,text,text,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dynamic_api_record_invocation(uuid,uuid,boolean,text,text,text,integer,uuid) TO sampleify_app;
