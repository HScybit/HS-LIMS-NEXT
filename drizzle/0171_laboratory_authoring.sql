-- Lab range inputs are source text. Existing absent values and prior rows are not backfilled.
ALTER TABLE laboratories ADD COLUMN description text;
ALTER TABLE laboratories ADD COLUMN abbreviation text;
ALTER TABLE laboratories ADD COLUMN business_unit_id uuid;
ALTER TABLE laboratories ADD COLUMN head_user_id uuid;
ALTER TABLE laboratories ADD COLUMN delegate_user_id uuid;
ALTER TABLE laboratories ADD COLUMN minimum_temperature_text text;
ALTER TABLE laboratories ADD COLUMN maximum_temperature_text text;
ALTER TABLE laboratories ADD COLUMN minimum_humidity_text text;
ALTER TABLE laboratories ADD COLUMN maximum_humidity_text text;
ALTER TABLE laboratories ADD CONSTRAINT laboratory_unit_fk FOREIGN KEY(organization_id,business_unit_id) REFERENCES business_units(organization_id,id);
ALTER TABLE laboratories ADD CONSTRAINT laboratory_head_user_fk FOREIGN KEY(organization_id,head_user_id) REFERENCES memberships(organization_id,user_id);
ALTER TABLE laboratories ADD CONSTRAINT laboratory_delegate_user_fk FOREIGN KEY(organization_id,delegate_user_id) REFERENCES memberships(organization_id,user_id);
--> statement-breakpoint
CREATE TABLE laboratory_versions (
  organization_id uuid NOT NULL,
  laboratory_id uuid NOT NULL,
  revision integer NOT NULL,
  previous_revision integer,
  request_id uuid NOT NULL,
  operation text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  abbreviation text,
  business_unit_id uuid,
  head_user_id uuid,
  delegate_user_id uuid,
  minimum_temperature_text text,
  maximum_temperature_text text,
  minimum_humidity_text text,
  maximum_humidity_text text,
  active boolean NOT NULL,
  business_unit_code text,
  business_unit_name text,
  head_username text,
  head_user_name text,
  delegate_username text,
  delegate_user_name text,
  saved_by uuid NOT NULL,
  saved_by_username text NOT NULL,
  saved_by_name text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT laboratory_version_pk PRIMARY KEY(organization_id,laboratory_id,revision),
  CONSTRAINT laboratory_request_key UNIQUE(organization_id,request_id),
  CONSTRAINT laboratory_version_head_fk FOREIGN KEY(organization_id,laboratory_id) REFERENCES laboratories(organization_id,id),
  CONSTRAINT laboratory_version_unit_fk FOREIGN KEY(organization_id,business_unit_id) REFERENCES business_units(organization_id,id),
  CONSTRAINT laboratory_version_head_user_fk FOREIGN KEY(organization_id,head_user_id) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT laboratory_version_delegate_user_fk FOREIGN KEY(organization_id,delegate_user_id) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT laboratory_version_actor_fk FOREIGN KEY(organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT laboratory_version_revision CHECK ((operation='create' AND previous_revision IS NULL AND revision=1)
    OR (operation IN ('update','retire') AND previous_revision IS NOT NULL AND previous_revision>0 AND revision=previous_revision+1)),
  CONSTRAINT laboratory_version_fields CHECK (length(trim(code)) BETWEEN 1 AND 64 AND length(trim(name)) BETWEEN 1 AND 250 AND (operation<>'retire' OR NOT active)),
  CONSTRAINT laboratory_version_labels CHECK (((business_unit_id IS NULL AND business_unit_code IS NULL AND business_unit_name IS NULL) OR (business_unit_id IS NOT NULL AND business_unit_code IS NOT NULL AND business_unit_name IS NOT NULL)) AND ((head_user_id IS NULL AND head_username IS NULL AND head_user_name IS NULL) OR (head_user_id IS NOT NULL AND head_username IS NOT NULL AND head_user_name IS NOT NULL)) AND ((delegate_user_id IS NULL AND delegate_username IS NULL AND delegate_user_name IS NULL) OR (delegate_user_id IS NOT NULL AND delegate_username IS NOT NULL AND delegate_user_name IS NOT NULL)))
);
ALTER TABLE laboratory_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON laboratory_versions FROM PUBLIC,sampleify_app,sampleify_report_worker;
--> statement-breakpoint
CREATE FUNCTION users_guard_laboratory_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Laboratory history is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.organization_id IS DISTINCT FROM public.users_directory_organization()
    OR NEW.saved_by IS DISTINCT FROM public.users_require_manager()
    OR NEW.saved_at IS DISTINCT FROM transaction_timestamp() OR NEW.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS (SELECT 1 FROM public.laboratories lab
      JOIN public.users editor ON editor.id=NEW.saved_by
      LEFT JOIN public.business_units unit ON unit.organization_id=lab.organization_id AND unit.id=lab.business_unit_id
      LEFT JOIN public.users hod ON hod.id=lab.head_user_id
      LEFT JOIN public.users delegate ON delegate.id=lab.delegate_user_id
      WHERE lab.organization_id=NEW.organization_id AND lab.id=NEW.laboratory_id AND lab.revision=NEW.revision AND lab.updated_at=transaction_timestamp()
      AND (lab.code, lab.name, lab.description, lab.abbreviation, lab.business_unit_id, lab.head_user_id, lab.delegate_user_id, lab.minimum_temperature_text, lab.maximum_temperature_text, lab.minimum_humidity_text, lab.maximum_humidity_text, lab.active,unit.code,unit.name,hod.username,hod.display_name,delegate.username,delegate.display_name,editor.username,editor.display_name)
        IS NOT DISTINCT FROM (NEW.code, NEW.name, NEW.description, NEW.abbreviation, NEW.business_unit_id, NEW.head_user_id, NEW.delegate_user_id, NEW.minimum_temperature_text, NEW.maximum_temperature_text, NEW.minimum_humidity_text, NEW.maximum_humidity_text, NEW.active,NEW.business_unit_code, NEW.business_unit_name, NEW.head_username, NEW.head_user_name, NEW.delegate_username, NEW.delegate_user_name,NEW.saved_by_username,NEW.saved_by_name)) THEN
    RAISE EXCEPTION 'History must describe the actual current Lab save' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER laboratory_history_guard BEFORE INSERT OR UPDATE OR DELETE ON laboratory_versions
  FOR EACH ROW EXECUTE FUNCTION users_guard_laboratory_history();

CREATE FUNCTION users_check_laboratory_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Synthetic/imported support rows can predate authoring; only actual later saves create history.
  IF EXISTS (SELECT 1 FROM public.laboratory_versions WHERE organization_id=NEW.organization_id AND laboratory_id=NEW.id)
    AND NOT EXISTS (SELECT 1 FROM public.laboratories lab JOIN public.laboratory_versions version
      ON version.organization_id=lab.organization_id AND version.laboratory_id=lab.id AND version.revision=lab.revision
      WHERE lab.organization_id=NEW.organization_id AND lab.id=NEW.id AND version.created_transaction_id=pg_current_xact_id()
      AND (lab.code, lab.name, lab.description, lab.abbreviation, lab.business_unit_id, lab.head_user_id, lab.delegate_user_id, lab.minimum_temperature_text, lab.maximum_temperature_text, lab.minimum_humidity_text, lab.maximum_humidity_text, lab.active,lab.updated_at) IS NOT DISTINCT FROM (version.code, version.name, version.description, version.abbreviation, version.business_unit_id, version.head_user_id, version.delegate_user_id, version.minimum_temperature_text, version.maximum_temperature_text, version.minimum_humidity_text, version.maximum_humidity_text, version.active,version.saved_at)) THEN
    RAISE EXCEPTION 'Lab changes require complete save history' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER laboratory_history_complete AFTER INSERT OR UPDATE ON laboratories
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users_check_laboratory_history();
--> statement-breakpoint
CREATE FUNCTION users_write_laboratory(requested_operation text,target uuid,expected_revision integer,requested_id uuid,requested_code text, requested_name text, requested_description text, requested_abbreviation text, requested_business_unit_id uuid, requested_head_user_id uuid, requested_delegate_user_id uuid, requested_minimum_temperature_text text, requested_maximum_temperature_text text, requested_minimum_humidity_text text, requested_maximum_humidity_text text, requested_active boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid;
  head public.laboratories; next_lab public.laboratories; prior public.laboratory_versions;
  observed_head uuid; observed_delegate uuid; operation_value text;
BEGIN
  actor:=public.users_require_manager();
  IF requested_operation IS NULL OR requested_operation NOT IN ('save','retire') OR target IS NULL OR requested_id IS NULL
    OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646
    OR (requested_operation='retire' AND (expected_revision=0 OR ROW(requested_code, requested_name, requested_description, requested_abbreviation, requested_business_unit_id, requested_head_user_id, requested_delegate_user_id, requested_minimum_temperature_text, requested_maximum_temperature_text, requested_minimum_humidity_text, requested_maximum_humidity_text, requested_active) IS DISTINCT FROM ROW(NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::boolean)))
    OR (requested_operation='save' AND (requested_code IS NULL OR requested_name IS NULL OR requested_active IS NULL)) THEN
    RAISE EXCEPTION 'Invalid Lab command' USING ERRCODE='23514',CONSTRAINT='laboratory_invalid_input';
  END IF;
  operation_value:=CASE WHEN requested_operation='retire' THEN 'retire' WHEN expected_revision=0 THEN 'create' ELSE 'update' END;
  IF requested_operation='retire' THEN
    SELECT head_user_id,delegate_user_id INTO observed_head,observed_delegate FROM public.laboratories WHERE organization_id=org AND id=target;
  ELSE observed_head:=requested_head_user_id; observed_delegate:=requested_delegate_user_id; END IF;
  -- Match identity administration: all observed people first, in a stable order, then the organization mutex.
  PERFORM 1 FROM public.users person WHERE person.id=ANY(ARRAY[actor,observed_head,observed_delegate])
    AND EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=person.id) ORDER BY person.id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR NO KEY UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=ANY(ARRAY[actor,observed_head,observed_delegate]) ORDER BY user_id FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  SELECT * INTO prior FROM public.laboratory_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF (prior.laboratory_id,coalesce(prior.previous_revision,0),prior.saved_by,prior.operation) IS DISTINCT FROM (target,expected_revision,actor,operation_value)
      OR (requested_operation='save' AND (prior.code, prior.name, prior.description, prior.abbreviation, prior.business_unit_id, prior.head_user_id, prior.delegate_user_id, prior.minimum_temperature_text, prior.maximum_temperature_text, prior.minimum_humidity_text, prior.maximum_humidity_text, prior.active) IS DISTINCT FROM (requested_code, requested_name, requested_description, requested_abbreviation, requested_business_unit_id, requested_head_user_id, requested_delegate_user_id, requested_minimum_temperature_text, requested_maximum_temperature_text, requested_minimum_humidity_text, requested_maximum_humidity_text, requested_active)) THEN
      RAISE EXCEPTION 'Save request already used for another Lab change' USING ERRCODE='23514',CONSTRAINT='laboratory_request_reused';
    END IF;
    RETURN prior.revision;
  END IF;
  SELECT * INTO head FROM public.laboratories WHERE organization_id=org AND id=target FOR UPDATE;
  IF head.id IS NULL AND expected_revision>0 THEN RAISE EXCEPTION 'Lab was not found' USING ERRCODE='P0002',CONSTRAINT='laboratory_not_found'; END IF;
  IF coalesce(head.revision,0)<>expected_revision THEN RAISE EXCEPTION 'Lab changed' USING ERRCODE='23514',CONSTRAINT='laboratory_stale'; END IF;
  next_lab:=head;
  IF requested_operation='retire' THEN
    IF NOT head.active THEN RAISE EXCEPTION 'Lab is already retired' USING ERRCODE='23514',CONSTRAINT='laboratory_stale'; END IF;
    next_lab.active:=false;
  ELSE
    -- Preserve exact, unchanged older values. New/changed values use the source authoring bounds.
    IF ((head.id IS NULL OR requested_code IS DISTINCT FROM head.code) AND (length(requested_code) NOT BETWEEN 1 AND 64 OR requested_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'))
      OR ((head.id IS NULL OR requested_name IS DISTINCT FROM head.name) AND length(trim(requested_name)) NOT BETWEEN 1 AND 200)
      OR ((head.id IS NULL OR requested_description IS DISTINCT FROM head.description) AND (requested_description IS NOT NULL AND length(requested_description)>2000))
      OR ((head.id IS NULL OR requested_abbreviation IS DISTINCT FROM head.abbreviation) AND (requested_abbreviation IS NOT NULL AND length(requested_abbreviation)>20))
      OR ((head.id IS NULL OR requested_minimum_temperature_text IS DISTINCT FROM head.minimum_temperature_text) AND (requested_minimum_temperature_text IS NULL OR requested_minimum_temperature_text='' OR length(requested_minimum_temperature_text)>2000))
      OR ((head.id IS NULL OR requested_maximum_temperature_text IS DISTINCT FROM head.maximum_temperature_text) AND (requested_maximum_temperature_text IS NULL OR requested_maximum_temperature_text='' OR length(requested_maximum_temperature_text)>2000))
      OR ((head.id IS NULL OR requested_minimum_humidity_text IS DISTINCT FROM head.minimum_humidity_text) AND (requested_minimum_humidity_text IS NULL OR requested_minimum_humidity_text='' OR length(requested_minimum_humidity_text)>2000))
      OR ((head.id IS NULL OR requested_maximum_humidity_text IS DISTINCT FROM head.maximum_humidity_text) AND (requested_maximum_humidity_text IS NULL OR requested_maximum_humidity_text='' OR length(requested_maximum_humidity_text)>2000)) THEN
      RAISE EXCEPTION 'Lab details are invalid' USING ERRCODE='23514',CONSTRAINT='laboratory_invalid_input';
    END IF;
    next_lab.code := requested_code;
    next_lab.name := requested_name;
    next_lab.description := requested_description;
    next_lab.abbreviation := requested_abbreviation;
    next_lab.business_unit_id := requested_business_unit_id;
    next_lab.head_user_id := requested_head_user_id;
    next_lab.delegate_user_id := requested_delegate_user_id;
    next_lab.minimum_temperature_text := requested_minimum_temperature_text;
    next_lab.maximum_temperature_text := requested_maximum_temperature_text;
    next_lab.minimum_humidity_text := requested_minimum_humidity_text;
    next_lab.maximum_humidity_text := requested_maximum_humidity_text;
    next_lab.active := requested_active;
  END IF;
  IF (next_lab.head_user_id,next_lab.delegate_user_id) IS DISTINCT FROM (observed_head,observed_delegate) THEN
    RAISE EXCEPTION 'Lab references changed' USING ERRCODE='23514',CONSTRAINT='laboratory_stale';
  END IF;
  IF (next_lab.head_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=next_lab.head_user_id))
    OR (next_lab.delegate_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=next_lab.delegate_user_id)) THEN
    RAISE EXCEPTION 'Select a user in this organization' USING ERRCODE='23514',CONSTRAINT='laboratory_user_unavailable';
  END IF;
  IF next_lab.business_unit_id IS NOT NULL THEN
    PERFORM 1 FROM public.business_units WHERE organization_id=org AND id=next_lab.business_unit_id
      AND (active OR (head.id IS NOT NULL AND head.business_unit_id=next_lab.business_unit_id)) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Business unit is unavailable' USING ERRCODE='23514',CONSTRAINT='laboratory_unit_unavailable'; END IF;
  END IF;
  IF expected_revision=0 THEN
    INSERT INTO public.laboratories(organization_id,id,code, name, description, abbreviation, business_unit_id, head_user_id, delegate_user_id, minimum_temperature_text, maximum_temperature_text, minimum_humidity_text, maximum_humidity_text, active) VALUES(org,target,next_lab.code, next_lab.name, next_lab.description, next_lab.abbreviation, next_lab.business_unit_id, next_lab.head_user_id, next_lab.delegate_user_id, next_lab.minimum_temperature_text, next_lab.maximum_temperature_text, next_lab.minimum_humidity_text, next_lab.maximum_humidity_text, next_lab.active);
  ELSE
    UPDATE public.laboratories SET code=next_lab.code, name=next_lab.name, description=next_lab.description, abbreviation=next_lab.abbreviation, business_unit_id=next_lab.business_unit_id, head_user_id=next_lab.head_user_id, delegate_user_id=next_lab.delegate_user_id, minimum_temperature_text=next_lab.minimum_temperature_text, maximum_temperature_text=next_lab.maximum_temperature_text, minimum_humidity_text=next_lab.minimum_humidity_text, maximum_humidity_text=next_lab.maximum_humidity_text, active=next_lab.active,revision=revision+1
      WHERE organization_id=org AND id=target;
  END IF;
  INSERT INTO public.laboratory_versions(organization_id,laboratory_id,revision,previous_revision,request_id,operation,code, name, description, abbreviation, business_unit_id, head_user_id, delegate_user_id, minimum_temperature_text, maximum_temperature_text, minimum_humidity_text, maximum_humidity_text, active,business_unit_code, business_unit_name, head_username, head_user_name, delegate_username, delegate_user_name,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,expected_revision+1,nullif(expected_revision,0),requested_id,operation_value,next_lab.code, next_lab.name, next_lab.description, next_lab.abbreviation, next_lab.business_unit_id, next_lab.head_user_id, next_lab.delegate_user_id, next_lab.minimum_temperature_text, next_lab.maximum_temperature_text, next_lab.minimum_humidity_text, next_lab.maximum_humidity_text, next_lab.active,unit.code,unit.name,hod.username,hod.display_name,delegate.username,delegate.display_name,actor,editor.username,editor.display_name
      FROM public.users editor
      LEFT JOIN public.business_units unit ON unit.organization_id=org AND unit.id=next_lab.business_unit_id
      LEFT JOIN public.users hod ON hod.id=next_lab.head_user_id
      LEFT JOIN public.users delegate ON delegate.id=next_lab.delegate_user_id WHERE editor.id=actor;
  RETURN expected_revision+1;
END $$;
REVOKE ALL ON FUNCTION users_guard_laboratory_history(),users_check_laboratory_history(),users_write_laboratory(text,uuid,integer,uuid,text,text,text,text,uuid,uuid,uuid,text,text,text,text,boolean) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION users_write_laboratory(text,uuid,integer,uuid,text,text,text,text,uuid,uuid,uuid,text,text,text,text,boolean) TO sampleify_app;
REVOKE INSERT,UPDATE,DELETE ON laboratories FROM sampleify_app;
--> statement-breakpoint
CREATE VIEW laboratory_directory WITH (security_barrier=true,security_invoker=false) AS
  SELECT lab.*,unit.code AS business_unit_code,unit.name AS business_unit_name,hod.username AS head_username,hod.display_name AS head_user_name,
    delegate.username AS delegate_username,delegate.display_name AS delegate_user_name
  FROM public.laboratories lab LEFT JOIN public.business_units unit ON unit.organization_id=lab.organization_id AND unit.id=lab.business_unit_id
    LEFT JOIN public.users hod ON hod.id=lab.head_user_id LEFT JOIN public.users delegate ON delegate.id=lab.delegate_user_id
  WHERE lab.organization_id=(SELECT public.users_directory_organization());
CREATE VIEW laboratory_history WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,laboratory_id,revision,previous_revision,request_id,operation,code, name, description, abbreviation, business_unit_id, head_user_id, delegate_user_id, minimum_temperature_text, maximum_temperature_text, minimum_humidity_text, maximum_humidity_text, active,business_unit_code, business_unit_name, head_username, head_user_name, delegate_username, delegate_user_name,saved_by,saved_by_username,saved_by_name,saved_at
  FROM public.laboratory_versions WHERE organization_id=(SELECT public.users_directory_organization());
REVOKE ALL ON laboratory_directory,laboratory_history FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON laboratory_directory,laboratory_history TO sampleify_app;
