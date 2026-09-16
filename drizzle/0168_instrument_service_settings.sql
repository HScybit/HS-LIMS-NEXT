CREATE TABLE organization_instrument_service_versions (
  organization_id uuid NOT NULL, revision integer NOT NULL, row_count integer NOT NULL,
  saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT organization_instrument_service_version_pk PRIMARY KEY(organization_id,revision),
  CONSTRAINT organization_instrument_service_settings_fk FOREIGN KEY(organization_id) REFERENCES organization_laboratory_settings(organization_id),
  CONSTRAINT organization_instrument_service_actor_fk FOREIGN KEY(organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT organization_instrument_service_version_bounds CHECK(revision>0 AND row_count BETWEEN 0 AND 100)
);
CREATE TABLE organization_instrument_service_entries (
  organization_id uuid NOT NULL, revision integer NOT NULL, id uuid NOT NULL, position integer NOT NULL,
  service_code text NOT NULL, display_label text NOT NULL, active boolean NOT NULL,
  CONSTRAINT organization_instrument_service_entry_pk PRIMARY KEY(organization_id,revision,id),
  CONSTRAINT organization_instrument_service_entry_version_fk FOREIGN KEY(organization_id,revision)
    REFERENCES organization_instrument_service_versions(organization_id,revision),
  CONSTRAINT organization_instrument_service_position UNIQUE(organization_id,revision,position),
  CONSTRAINT organization_instrument_service_entry_fields CHECK(position BETWEEN 0 AND 99
    AND length(service_code) BETWEEN 1 AND 64 AND service_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND length(display_label) BETWEEN 1 AND 150 AND display_label=trim(display_label))
);
CREATE UNIQUE INDEX organization_instrument_service_code ON organization_instrument_service_entries(organization_id,revision,lower(service_code));
--> statement-breakpoint
ALTER TABLE organization_instrument_service_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_instrument_service_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_instrument_service_versions_read ON organization_instrument_service_versions FOR SELECT TO sampleify_app USING(
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('settings.read') OR app_has_permission('settings.manage')));
CREATE POLICY organization_instrument_service_entries_read ON organization_instrument_service_entries FOR SELECT TO sampleify_app USING(
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('settings.read') OR app_has_permission('settings.manage')));
REVOKE ALL ON organization_instrument_service_versions,organization_instrument_service_entries FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON organization_instrument_service_versions,organization_instrument_service_entries TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION organization_lock_settings_writer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  PERFORM 1 FROM public.users WHERE id=actor FOR NO KEY UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR NO KEY UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM public.sessions session
    JOIN public.users person ON person.id=session.user_id AND person.active AND NOT person.must_change_password
    JOIN public.credentials credential ON credential.user_id=person.id AND credential.revision=session.credential_revision
    JOIN public.memberships membership ON membership.organization_id=session.organization_id AND membership.user_id=person.id AND membership.active
    JOIN public.organizations organization ON organization.id=session.organization_id AND organization.active
    WHERE session.id=nullif(current_setting('app.session_id',true),'')::uuid AND session.user_id=actor AND session.organization_id=org
      AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
  ) OR NOT public.app_has_permission('settings.manage') THEN
    RAISE EXCEPTION 'Active settings management session required' USING ERRCODE='42501',CONSTRAINT='organization_settings_session_required';
  END IF;
  RETURN actor;
END $$;
--> statement-breakpoint
CREATE FUNCTION organization_guard_instrument_service_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'Instrument service definition history is immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER organization_instrument_service_versions_immutable BEFORE UPDATE OR DELETE ON organization_instrument_service_versions
  FOR EACH ROW EXECUTE FUNCTION organization_guard_instrument_service_history();
CREATE TRIGGER organization_instrument_service_entries_immutable BEFORE UPDATE OR DELETE ON organization_instrument_service_entries
  FOR EACH ROW EXECUTE FUNCTION organization_guard_instrument_service_history();
--> statement-breakpoint
CREATE FUNCTION organization_save_instrument_services(p_revision integer,p_ids uuid[],p_codes text[],p_labels text[],p_active boolean[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.organization_lock_settings_writer();
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  head public.organization_laboratory_settings; item_count integer:=cardinality(p_ids);
BEGIN
  SELECT * INTO head FROM public.organization_laboratory_settings WHERE organization_id=org FOR UPDATE;
  IF head.organization_id IS NULL OR head.revision IS DISTINCT FROM p_revision
    OR head.updated_by IS DISTINCT FROM actor OR head.updated_at IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'Service definitions require this transaction''s settings save' USING ERRCODE='23514',CONSTRAINT='instrument_services_current_settings';
  END IF;
  IF item_count IS NULL OR item_count>100 OR cardinality(p_codes) IS DISTINCT FROM item_count
    OR cardinality(p_labels) IS DISTINCT FROM item_count OR cardinality(p_active) IS DISTINCT FROM item_count
    OR (item_count>0 AND (array_ndims(p_ids)<>1 OR array_ndims(p_codes)<>1 OR array_ndims(p_labels)<>1 OR array_ndims(p_active)<>1)) THEN
    RAISE EXCEPTION 'Service definition arrays must be aligned and bounded' USING ERRCODE='23514',CONSTRAINT='instrument_services_input';
  END IF;
  INSERT INTO public.organization_instrument_service_versions(organization_id,revision,row_count,saved_by)
    VALUES(org,p_revision,item_count,actor);
  INSERT INTO public.organization_instrument_service_entries(organization_id,revision,id,position,service_code,display_label,active)
    SELECT org,p_revision,entry.id,entry.ordinality-1,entry.code,entry.label,entry.active
    FROM unnest(p_ids,p_codes,p_labels,p_active) WITH ORDINALITY entry(id,code,label,active,ordinality);
END $$;
REVOKE ALL ON FUNCTION organization_lock_settings_writer(),organization_guard_instrument_service_history(),organization_save_instrument_services(integer,uuid[],text[],text[],boolean[])
  FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION organization_lock_settings_writer(),organization_save_instrument_services(integer,uuid[],text[],text[],boolean[]) TO sampleify_app;
