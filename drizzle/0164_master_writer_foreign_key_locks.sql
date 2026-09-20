-- Keep account/organization changes excluded while allowing concurrent job foreign-key checks.
CREATE OR REPLACE FUNCTION masters_lock_field_writer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||org::text,0));
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
  ) OR NOT public.app_has_permission('masters.manage') THEN
    RAISE EXCEPTION 'Active master management session required' USING ERRCODE='42501',CONSTRAINT='master_field_session_required';
  END IF;
  RETURN actor;
END $$;
REVOKE ALL ON FUNCTION masters_lock_field_writer() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_lock_field_writer() TO sampleify_app;
