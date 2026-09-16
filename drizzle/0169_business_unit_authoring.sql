CREATE TABLE business_unit_versions (
  organization_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  revision integer NOT NULL,
  previous_revision integer,
  request_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  active boolean NOT NULL,
  saved_by uuid NOT NULL,
  saved_by_username text NOT NULL,
  saved_by_name text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT business_unit_version_pk PRIMARY KEY(organization_id,unit_id,revision),
  CONSTRAINT business_unit_request_key UNIQUE(organization_id,request_id),
  CONSTRAINT business_unit_version_head_fk FOREIGN KEY(organization_id,unit_id) REFERENCES business_units(organization_id,id),
  CONSTRAINT business_unit_version_actor_fk FOREIGN KEY(organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT business_unit_version_revision CHECK ((previous_revision IS NULL AND revision=1)
    OR (previous_revision IS NOT NULL AND previous_revision>0 AND revision=previous_revision+1)),
  CONSTRAINT business_unit_version_fields CHECK (length(code) BETWEEN 1 AND 64 AND code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND length(trim(name)) BETWEEN 1 AND 200 AND (description IS NULL OR length(description)<=2000))
);
ALTER TABLE business_unit_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON business_unit_versions FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE FUNCTION users_guard_business_unit_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Business unit history is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.organization_id IS DISTINCT FROM public.users_directory_organization()
    OR NEW.saved_by IS DISTINCT FROM public.users_require_manager()
    OR NEW.saved_at IS DISTINCT FROM transaction_timestamp()
    OR NEW.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS (SELECT 1 FROM public.business_units unit JOIN public.users editor ON editor.id=NEW.saved_by
      WHERE unit.organization_id=NEW.organization_id AND unit.id=NEW.unit_id AND unit.revision=NEW.revision
      AND unit.updated_at=transaction_timestamp()
      AND (unit.code,unit.name,unit.description,unit.active,editor.username,editor.display_name)
        IS NOT DISTINCT FROM (NEW.code,NEW.name,NEW.description,NEW.active,NEW.saved_by_username,NEW.saved_by_name)) THEN
    RAISE EXCEPTION 'History must describe the actual current unit save' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_unit_history_guard BEFORE INSERT OR UPDATE OR DELETE ON business_unit_versions
  FOR EACH ROW EXECUTE FUNCTION users_guard_business_unit_history();

CREATE FUNCTION users_check_business_unit_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Preexisting support rows have no invented history. Once authored, every change must retain its actual version.
  IF EXISTS (SELECT 1 FROM public.business_unit_versions WHERE organization_id=NEW.organization_id AND unit_id=NEW.id)
    AND NOT EXISTS (SELECT 1 FROM public.business_units unit JOIN public.business_unit_versions version
      ON version.organization_id=unit.organization_id AND version.unit_id=unit.id AND version.revision=unit.revision
      WHERE unit.organization_id=NEW.organization_id AND unit.id=NEW.id
      AND version.created_transaction_id=pg_current_xact_id()
      AND (unit.code,unit.name,unit.description,unit.active,unit.updated_at)
        IS NOT DISTINCT FROM (version.code,version.name,version.description,version.active,version.saved_at)) THEN
    RAISE EXCEPTION 'Business unit changes require complete save history' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER business_unit_history_complete AFTER INSERT OR UPDATE ON business_units
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users_check_business_unit_history();
--> statement-breakpoint
CREATE FUNCTION users_write_business_unit(target uuid,expected_revision integer,requested_id uuid,
  requested_code text,requested_name text,requested_description text,requested_active boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid;
  head public.business_units; prior public.business_unit_versions;
BEGIN
  actor:=public.users_require_manager();
  IF target IS NULL OR requested_id IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646
    OR requested_code IS NULL OR length(requested_code) NOT BETWEEN 1 AND 64 OR requested_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    OR requested_name IS NULL OR length(requested_name) NOT BETWEEN 1 AND 200 OR requested_name<>trim(requested_name) OR trim(requested_name)=''
    OR (requested_description IS NOT NULL AND (length(requested_description)>2000 OR requested_description<>trim(requested_description) OR requested_description=''))
    OR requested_active IS NULL THEN
    RAISE EXCEPTION 'Invalid business unit command' USING ERRCODE='23514',CONSTRAINT='business_unit_invalid_input';
  END IF;
  -- Match existing identity administration's user-before-organization lock order and recheck the live session after waiting.
  PERFORM 1 FROM public.users WHERE id=actor FOR NO KEY UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR NO KEY UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  SELECT * INTO prior FROM public.business_unit_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF (prior.unit_id,coalesce(prior.previous_revision,0),prior.saved_by,prior.code,prior.name,prior.description,prior.active)
      IS DISTINCT FROM (target,expected_revision,actor,requested_code,requested_name,requested_description,requested_active) THEN
      RAISE EXCEPTION 'Save request already used for another unit change' USING ERRCODE='23514',CONSTRAINT='business_unit_request_reused';
    END IF;
    RETURN prior.revision;
  END IF;
  SELECT * INTO head FROM public.business_units WHERE organization_id=org AND id=target FOR UPDATE;
  IF head.id IS NULL AND expected_revision>0 THEN
    RAISE EXCEPTION 'Unit was not found' USING ERRCODE='P0002',CONSTRAINT='business_unit_not_found';
  END IF;
  IF coalesce(head.revision,0)<>expected_revision THEN
    RAISE EXCEPTION 'Unit changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='business_unit_stale';
  END IF;
  IF expected_revision=0 THEN
    INSERT INTO public.business_units(organization_id,id,code,name,description,active)
      VALUES(org,target,requested_code,requested_name,requested_description,requested_active);
  ELSE
    UPDATE public.business_units SET code=requested_code,name=requested_name,description=requested_description,active=requested_active,revision=revision+1
      WHERE organization_id=org AND id=target;
  END IF;
  INSERT INTO public.business_unit_versions(organization_id,unit_id,revision,previous_revision,request_id,code,name,description,active,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,expected_revision+1,nullif(expected_revision,0),requested_id,requested_code,requested_name,requested_description,requested_active,
      actor,username,display_name FROM public.users WHERE id=actor;
  RETURN expected_revision+1;
END $$;
REVOKE ALL ON FUNCTION users_guard_business_unit_history(),users_check_business_unit_history(),users_write_business_unit(uuid,integer,uuid,text,text,text,boolean)
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION users_write_business_unit(uuid,integer,uuid,text,text,text,boolean) TO sampleify_app;
--> statement-breakpoint
CREATE VIEW business_unit_directory WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,code,name,description,active,revision,created_at,updated_at FROM public.business_units
  WHERE organization_id=(SELECT public.users_directory_organization());
CREATE VIEW business_unit_history WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,unit_id,revision,previous_revision,request_id,code,name,description,active,saved_by,saved_by_username,saved_by_name,saved_at
  FROM public.business_unit_versions WHERE organization_id=(SELECT public.users_directory_organization());
REVOKE ALL ON business_unit_directory,business_unit_history FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON business_unit_directory,business_unit_history TO sampleify_app;
