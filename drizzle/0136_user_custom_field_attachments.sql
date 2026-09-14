-- Existing master attachment policies remain limited to Product/Parameter versions.
-- User files share the immutable byte store but have a separate command and read boundary.
CREATE OR REPLACE FUNCTION custom_field_guard_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE definition public.custom_field_definitions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Custom Field attachment bytes are immutable' USING ERRCODE='55000'; END IF;
  IF session_user='sampleify_app' AND current_user='sampleify_app' AND (
    NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() OR NOT public.app_has_permission('masters.manage')
  ) THEN RAISE EXCEPTION 'Attachment upload requires its actual tenant, actor and time' USING ERRCODE='42501'; END IF;
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=NEW.organization_id AND id=NEW.field_id FOR SHARE;
  IF definition.id IS NULL OR NOT definition.active OR definition.field_type<>'attachment'
    OR definition.associated_with NOT IN ('product','parameter','users') OR definition.revision<>NEW.field_revision THEN
    RAISE EXCEPTION 'Attachment upload requires a current active supported field' USING ERRCODE='23514',CONSTRAINT='custom_field_attachment_current_definition';
  END IF;
  IF definition.associated_with='users' THEN
    IF current_user='sampleify_app' THEN RAISE EXCEPTION 'User attachments require their upload command' USING ERRCODE='42501'; END IF;
    IF NEW.uploaded_by IS DISTINCT FROM public.users_require_manager()
      OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'User attachment requires the actual tenant, editor and transaction time' USING ERRCODE='42501';
    END IF;
  ELSIF session_user='sampleify_app' AND (
    NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.uploaded_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() OR NOT public.app_has_permission('masters.manage')
  ) THEN RAISE EXCEPTION 'Attachment upload requires its actual tenant, actor and time' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION users_upload_field_attachment(requested_id uuid,target_field uuid,expected_revision integer,
  requested_name text,requested_type text,requested_content bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid; prior record;
  definition public.custom_field_definitions; requested_sha256 text; requested_length integer;
BEGIN
  actor:=public.users_require_manager();
  IF requested_id IS NULL OR target_field IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 1 AND 2147483647
    OR requested_name IS NULL OR requested_type IS NULL OR requested_content IS NULL OR octet_length(requested_content)>20971520 THEN
    RAISE EXCEPTION 'Invalid user field attachment' USING ERRCODE='23514',CONSTRAINT='user_field_attachment_invalid_input';
  END IF;
  PERFORM 1 FROM public.users WHERE id=actor FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('custom-field-upload:'||org::text||':'||requested_id::text,0));
  actor:=public.users_require_manager();
  requested_sha256:=encode(sha256(requested_content),'hex'); requested_length:=octet_length(requested_content);
  -- Compare the actual digest without selecting an old binary payload. Retry precedes current-field checks.
  SELECT file.field_id,file.field_revision,file.original_name,file.media_type,file.byte_length,file.sha256,file.uploaded_by,
    version.associated_with INTO prior FROM public.custom_field_attachments file JOIN public.custom_field_versions version
      ON version.organization_id=file.organization_id AND version.field_id=file.field_id AND version.revision=file.field_revision
    WHERE file.organization_id=org AND file.id=requested_id;
  IF FOUND THEN
    IF prior.associated_with<>'users' OR
      (prior.field_id,prior.field_revision,prior.original_name,prior.media_type,prior.byte_length,prior.sha256,prior.uploaded_by)
        IS DISTINCT FROM (target_field,expected_revision,requested_name,requested_type,requested_length,requested_sha256,actor) THEN
      RAISE EXCEPTION 'Upload request already used with different details' USING ERRCODE='23514',CONSTRAINT='user_field_attachment_request_reused';
    END IF;
    RETURN true;
  END IF;
  SELECT * INTO definition FROM public.custom_field_definitions WHERE organization_id=org AND id=target_field FOR SHARE;
  actor:=public.users_require_manager();
  IF definition.id IS NULL OR NOT definition.active OR definition.associated_with<>'users' OR definition.field_type<>'attachment' THEN
    RAISE EXCEPTION 'User attachment field was not found' USING ERRCODE='P0002',CONSTRAINT='user_field_attachment_field_missing';
  END IF;
  IF definition.revision<>expected_revision THEN
    RAISE EXCEPTION 'Custom Field changed; reload before uploading' USING ERRCODE='23514',CONSTRAINT='user_field_attachment_stale';
  END IF;
  INSERT INTO public.custom_field_attachments(organization_id,id,field_id,field_revision,original_name,media_type,content,byte_length,sha256,uploaded_by)
    VALUES(org,requested_id,target_field,expected_revision,requested_name,requested_type,requested_content,requested_length,requested_sha256,actor);
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION users_upload_field_attachment(uuid,uuid,integer,text,text,bytea) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION users_upload_field_attachment(uuid,uuid,integer,text,text,bytea) TO sampleify_app;
--> statement-breakpoint
CREATE VIEW user_custom_field_attachments WITH (security_barrier=true,security_invoker=false) AS
  SELECT file.organization_id,file.id,file.field_id,file.field_revision,file.original_name,file.media_type,file.byte_length,file.sha256,
    file.uploaded_by,file.uploaded_at,file.content
  FROM public.custom_field_attachments file JOIN public.custom_field_versions version
    ON version.organization_id=file.organization_id AND version.field_id=file.field_id AND version.revision=file.field_revision
  WHERE file.organization_id=(SELECT public.users_directory_organization()) AND version.associated_with='users' AND version.field_type='attachment';
REVOKE ALL ON user_custom_field_attachments FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON user_custom_field_attachments TO sampleify_app;
