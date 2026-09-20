-- User uploads share typed bulk provenance, with a separate private credential
-- child. Existing cell foreign keys and native account creation remain intact.
ALTER TABLE master_bulk_batches ADD COLUMN source_hmac_sha256 text;
ALTER TABLE master_bulk_batches ALTER COLUMN source_sha256 DROP NOT NULL;
ALTER TABLE master_bulk_batches DROP CONSTRAINT master_bulk_batch_fields;
ALTER TABLE master_bulk_batches ADD CONSTRAINT master_bulk_batch_fields CHECK (
  resource IN ('products','test-parameters','methods','users')
  AND length(file_name) BETWEEN 1 AND 250 AND file_format IN ('csv','xlsx')
  AND ((resource='users' AND source_sha256 IS NULL AND source_hmac_sha256 IS NOT NULL AND source_hmac_sha256 ~ '^[a-f0-9]{64}$')
    OR (resource<>'users' AND source_hmac_sha256 IS NULL AND source_sha256 IS NOT NULL AND source_sha256 ~ '^[a-f0-9]{64}$'))
  AND length(time_zone) BETWEEN 1 AND 100 AND header_row_number>0
  AND column_count BETWEEN 1 AND 250 AND row_count BETWEEN 1 AND 2500
  AND ((file_format='csv' AND num_nonnulls(sheet_name,sheet_count,date_1904)=0)
    OR (file_format='xlsx' AND sheet_name IS NOT NULL AND length(sheet_name) BETWEEN 1 AND 100
      AND sheet_count IS NOT NULL AND sheet_count BETWEEN 1 AND 512 AND date_1904 IS NOT NULL)));

ALTER TABLE master_bulk_attempts ADD COLUMN user_id uuid;
ALTER TABLE master_bulk_attempts ADD CONSTRAINT master_bulk_attempt_user_fk
  FOREIGN KEY (organization_id,user_id,result_revision) REFERENCES user_profile_versions(organization_id,user_id,revision);
ALTER TABLE master_bulk_attempts DROP CONSTRAINT master_bulk_attempt_fields;
ALTER TABLE master_bulk_attempts ADD CONSTRAINT master_bulk_attempt_fields CHECK (
  (committed AND num_nonnulls(product_id,parameter_id,method_id,user_id)=1 AND result_revision IS NOT NULL AND result_revision>0 AND error_code IS NULL AND error_message IS NULL)
  OR (NOT committed AND num_nonnulls(product_id,parameter_id,method_id,user_id,result_revision)=0
    AND error_code IS NOT NULL AND length(error_code) BETWEEN 1 AND 100 AND error_message IS NOT NULL AND length(error_message) BETWEEN 1 AND 2000));

CREATE TABLE master_bulk_user_credentials (
  organization_id uuid NOT NULL, batch_id uuid NOT NULL, row_id uuid NOT NULL, input_revision integer NOT NULL,
  state text NOT NULL, fingerprint bytea NOT NULL, password_hash text,
  saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT master_bulk_user_credential_pk PRIMARY KEY (organization_id,batch_id,row_id,input_revision),
  CONSTRAINT master_bulk_user_credential_input_fk FOREIGN KEY (organization_id,batch_id,row_id,input_revision)
    REFERENCES master_bulk_row_versions(organization_id,batch_id,row_id,revision),
  CONSTRAINT master_bulk_user_credential_actor_fk FOREIGN KEY (organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT master_bulk_user_credential_fields CHECK (octet_length(fingerprint)=32
    AND ((state='valid' AND password_hash IS NOT NULL AND password_hash ~ '^scrypt[$]1[$]32768[$]8[$]1[$][A-Za-z0-9_-]{22}[$][A-Za-z0-9_-]{86}$')
      OR (state IN ('missing','invalid') AND password_hash IS NULL)))
);
ALTER TABLE master_bulk_user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_bulk_user_credentials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON master_bulk_user_credentials FROM PUBLIC,sampleify_app,sampleify_report_worker;

CREATE FUNCTION master_bulk_has_permission(resource text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT CASE WHEN resource='users' THEN public.app_has_permission('users.manage')
    WHEN resource IN ('products','test-parameters','methods') THEN public.app_has_permission('masters.manage') ELSE false END
$$;
REVOKE ALL ON FUNCTION master_bulk_has_permission(text) FROM PUBLIC,sampleify_app,sampleify_report_worker;

DROP POLICY master_bulk_scope ON master_bulk_batches;
CREATE POLICY master_bulk_scope ON master_bulk_batches USING (
  organization_id IS NOT DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
  AND ((resource='users' AND (SELECT public.app_has_permission('users.manage')))
    OR (resource IN ('products','test-parameters','methods') AND (SELECT public.app_has_permission('masters.manage')))))
WITH CHECK (
  organization_id IS NOT DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
  AND ((resource='users' AND (SELECT public.app_has_permission('users.manage')))
    OR (resource IN ('products','test-parameters','methods') AND (SELECT public.app_has_permission('masters.manage')))));
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['master_bulk_columns','master_bulk_rows','master_bulk_row_versions','master_bulk_cells','master_bulk_reviews','master_bulk_attempts'] LOOP
    EXECUTE format('DROP POLICY master_bulk_scope ON %I',relation);
    -- The uncorrelated authorized batch set avoids per-cell permission queries.
    EXECUTE format('CREATE POLICY master_bulk_scope ON %I USING (
      organization_id IS NOT DISTINCT FROM nullif(current_setting(''app.organization_id'',true),'''')::uuid
      AND batch_id IN (SELECT id FROM public.master_bulk_batches)) WITH CHECK (
      organization_id IS NOT DISTINCT FROM nullif(current_setting(''app.organization_id'',true),'''')::uuid
      AND batch_id IN (SELECT id FROM public.master_bulk_batches))',relation);
  END LOOP;
END $$;

CREATE FUNCTION master_bulk_guard_user_credential() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; parent public.master_bulk_row_versions; resource text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Bulk credential history is immutable' USING ERRCODE='55000'; END IF;
  actor:=public.users_require_manager();
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.saved_by IS DISTINCT FROM actor OR NEW.saved_at IS DISTINCT FROM transaction_timestamp()
    OR NEW.created_transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'Record the actual User upload actor and transaction' USING ERRCODE='23514';
  END IF;
  SELECT * INTO parent FROM public.master_bulk_row_versions WHERE organization_id=NEW.organization_id AND batch_id=NEW.batch_id
    AND row_id=NEW.row_id AND revision=NEW.input_revision;
  SELECT batch.resource INTO resource FROM public.master_bulk_batches batch WHERE organization_id=NEW.organization_id AND id=NEW.batch_id;
  IF parent.created_transaction_id IS DISTINCT FROM pg_current_xact_id() OR parent.saved_by IS DISTINCT FROM actor OR resource IS DISTINCT FROM 'users' THEN
    RAISE EXCEPTION 'Credentials require a current User input revision' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER master_bulk_user_credential_guard BEFORE INSERT OR UPDATE OR DELETE ON master_bulk_user_credentials
  FOR EACH ROW EXECUTE FUNCTION master_bulk_guard_user_credential();
REVOKE ALL ON FUNCTION master_bulk_guard_user_credential() FROM PUBLIC,sampleify_app,sampleify_report_worker;

CREATE VIEW master_bulk_user_credential_states WITH (security_barrier=true) AS
  SELECT organization_id,batch_id,row_id,input_revision,state,encode(fingerprint,'hex') AS fingerprint
  FROM master_bulk_user_credentials
  WHERE organization_id IS NOT DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('users.manage'));
REVOKE ALL ON master_bulk_user_credential_states FROM PUBLIC,sampleify_report_worker;
GRANT SELECT ON master_bulk_user_credential_states TO sampleify_app;

CREATE FUNCTION master_bulk_store_user_credential(batch uuid,row_identity uuid,revision integer,requested_state text,requested_fingerprint bytea,requested_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.users_require_manager(); org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  INSERT INTO public.master_bulk_user_credentials(organization_id,batch_id,row_id,input_revision,state,fingerprint,password_hash,saved_by)
    VALUES(org,batch,row_identity,revision,requested_state,requested_fingerprint,requested_hash,actor);
END $$;
CREATE FUNCTION master_bulk_copy_user_credential(batch uuid,row_identity uuid,revision integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.users_require_manager(); org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  INSERT INTO public.master_bulk_user_credentials(organization_id,batch_id,row_id,input_revision,state,fingerprint,password_hash,saved_by)
    SELECT org,batch,row_identity,revision,state,fingerprint,password_hash,actor FROM public.master_bulk_user_credentials
    WHERE organization_id=org AND batch_id=batch AND row_id=row_identity AND input_revision=revision-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'The previous User credential is unavailable' USING ERRCODE='23503'; END IF;
END $$;
CREATE FUNCTION master_bulk_user_aliases(requested text[]) RETURNS TABLE(alias text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.users_require_manager();
  IF requested IS NULL OR (cardinality(requested)>0 AND array_ndims(requested) IS DISTINCT FROM 1) OR cardinality(requested)>5000
    OR EXISTS (SELECT 1 FROM unnest(requested) value WHERE value IS NULL OR length(value) NOT BETWEEN 1 AND 320) THEN
    RAISE EXCEPTION 'Provide bounded sign-in identifiers' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT DISTINCT lower(value) FROM unnest(requested) value
    WHERE EXISTS (SELECT 1 FROM public.users person WHERE lower(person.username)=lower(value) OR lower(person.email)=lower(value));
END $$;

CREATE FUNCTION master_bulk_create_user(batch uuid,row_identity uuid,requested_revision integer,review_identity uuid,
  requested_username text,requested_email text,requested_name text,phone text,designation text,unit uuid,default_role uuid,laboratory uuid)
RETURNS TABLE(id uuid,profile_revision integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.users_require_manager(); org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  reviewed public.master_bulk_reviews; credential public.master_bulk_user_credentials; saved_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('custom-field-definitions:'||org::text,0));
  PERFORM 1 FROM public.master_bulk_rows WHERE organization_id=org AND batch_id=batch AND master_bulk_rows.id=row_identity AND master_bulk_rows.revision=requested_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The User input revision changed' USING ERRCODE='23514',CONSTRAINT='master_bulk_user_review'; END IF;
  actor:=public.users_require_manager();
  SELECT * INTO reviewed FROM public.master_bulk_reviews WHERE organization_id=org AND master_bulk_reviews.id=review_identity
    AND batch_id=batch AND row_id=row_identity AND input_revision=requested_revision;
  SELECT * INTO credential FROM public.master_bulk_user_credentials WHERE organization_id=org AND batch_id=batch
    AND row_id=row_identity AND input_revision=requested_revision;
  IF reviewed.id IS NULL OR NOT reviewed.valid OR reviewed.operation<>'create' OR reviewed.expected_revision<>0
    OR credential.state IS DISTINCT FROM 'valid' THEN
    RAISE EXCEPTION 'Validate the User row and its password before creation' USING ERRCODE='23514',CONSTRAINT='master_bulk_user_review';
  END IF;
  saved_revision:=public.users_create_account(reviewed.candidate_id,reviewed.id,decode(reviewed.command_sha256,'hex'),requested_username,requested_email,requested_name,
    credential.password_hash,NULL,false,phone,true,designation,true,false,true,unit,true,default_role,laboratory,NULL,false,NULL);
  RETURN QUERY SELECT reviewed.candidate_id,saved_revision;
END $$;
REVOKE ALL ON FUNCTION master_bulk_store_user_credential(uuid,uuid,integer,text,bytea,text),master_bulk_copy_user_credential(uuid,uuid,integer),
  master_bulk_user_aliases(text[]),master_bulk_create_user(uuid,uuid,integer,uuid,text,text,text,text,text,uuid,uuid,uuid) FROM PUBLIC,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION master_bulk_store_user_credential(uuid,uuid,integer,text,bytea,text),master_bulk_copy_user_credential(uuid,uuid,integer),
  master_bulk_user_aliases(text[]),master_bulk_create_user(uuid,uuid,integer,uuid,text,text,text,text,text,uuid,uuid,uuid) TO sampleify_app;

CREATE OR REPLACE FUNCTION master_bulk_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  upload public.master_bulk_batches; current_row public.master_bulk_rows; reviewed public.master_bulk_reviews;
  parent_transaction xid8; actual_request uuid; actual_actor uuid; actual_transaction xid8;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bulk input and outcomes are retained' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='master_bulk_batches' THEN upload:=NEW;
  ELSE SELECT * INTO upload FROM public.master_bulk_batches WHERE organization_id=NEW.organization_id AND id=NEW.batch_id; END IF;
  IF NOT public.master_bulk_has_permission(upload.resource) OR actor IS NULL
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Bulk resource management permission required' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='master_bulk_rows' AND TG_OP='UPDATE' THEN
    IF (NEW.organization_id,NEW.batch_id,NEW.id,NEW.ordinal,NEW.source_row_number) IS DISTINCT FROM
      (OLD.organization_id,OLD.batch_id,OLD.id,OLD.ordinal,OLD.source_row_number) OR NEW.revision<>OLD.revision+1
      OR EXISTS (SELECT 1 FROM public.master_bulk_attempts WHERE organization_id=OLD.organization_id AND batch_id=OLD.batch_id AND row_id=OLD.id AND committed) THEN
      RAISE EXCEPTION 'Advance an uncommitted input revision without changing its source identity' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Bulk history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME NOT IN ('master_bulk_columns','master_bulk_rows','master_bulk_cells') THEN
    IF NEW.saved_by IS DISTINCT FROM actor OR NEW.saved_at IS DISTINCT FROM transaction_timestamp()
      OR NEW.created_transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'Record the actual bulk actor and transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME='master_bulk_batches' THEN RETURN NEW; END IF;
  IF upload.id IS NULL THEN RAISE EXCEPTION 'Upload was not found' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME IN ('master_bulk_columns','master_bulk_rows') THEN
    IF upload.created_transaction_id<>pg_current_xact_id() THEN RAISE EXCEPTION 'Original upload shape is immutable' USING ERRCODE='55000'; END IF;
    IF TG_TABLE_NAME='master_bulk_columns' THEN
      IF upload.resource='users' AND (trim(NEW.source_header) NOT IN ('','name','email','phone','username','designation','unit_name','role_name','password','lab_name')
        OR (trim(NEW.source_header)='password' AND num_nonnulls(NEW.source_type,NEW.formula,NEW.has_result,NEW.error_code,NEW.hyperlink,NEW.number_format)<>0)) THEN
        RAISE EXCEPTION 'Use redacted User upload headers' USING ERRCODE='23514';
      END IF;
      IF NEW.column_number>upload.column_count THEN RAISE EXCEPTION 'Column exceeds upload shape' USING ERRCODE='23514'; END IF;
    ELSE
      IF NEW.ordinal>upload.row_count OR NEW.source_row_number<=upload.header_row_number OR NEW.revision<>1 THEN
        RAISE EXCEPTION 'Invalid original source row' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='master_bulk_cells' THEN
    SELECT created_transaction_id INTO parent_transaction FROM public.master_bulk_row_versions
      WHERE organization_id=NEW.organization_id AND batch_id=NEW.batch_id AND row_id=NEW.row_id AND revision=NEW.revision;
    IF parent_transaction IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Input cells are immutable after their revision commits' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO current_row FROM public.master_bulk_rows WHERE organization_id=NEW.organization_id AND batch_id=NEW.batch_id AND id=NEW.row_id FOR UPDATE;
  IF current_row.id IS NULL OR EXISTS (SELECT 1 FROM public.master_bulk_attempts
    WHERE organization_id=NEW.organization_id AND batch_id=NEW.batch_id AND row_id=NEW.row_id AND committed) THEN
    RAISE EXCEPTION 'This upload row is missing or already committed' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='master_bulk_row_versions' THEN
    IF NEW.revision<>current_row.revision THEN RAISE EXCEPTION 'Input revision must match the current row' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.input_revision<>current_row.revision THEN RAISE EXCEPTION 'Input changed before review or processing' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='master_bulk_reviews' THEN RETURN NEW; END IF;
  SELECT * INTO reviewed FROM public.master_bulk_reviews WHERE organization_id=NEW.organization_id AND id=NEW.review_id;
  IF NEW.committed THEN
    IF NOT reviewed.valid OR NEW.result_revision<>reviewed.expected_revision+1
      OR coalesce(NEW.product_id,NEW.parameter_id,NEW.method_id,NEW.user_id) IS DISTINCT FROM reviewed.candidate_id THEN
      RAISE EXCEPTION 'Bulk outcome does not match its reviewed command' USING ERRCODE='23514';
    END IF;
    IF upload.resource='products' AND NEW.product_id IS NOT NULL THEN
      SELECT request_id,saved_by,created_transaction_id INTO actual_request,actual_actor,actual_transaction FROM public.product_versions
        WHERE organization_id=NEW.organization_id AND product_id=NEW.product_id AND revision=NEW.result_revision;
    ELSIF upload.resource='test-parameters' AND NEW.parameter_id IS NOT NULL THEN
      SELECT request_id,saved_by,created_transaction_id INTO actual_request,actual_actor,actual_transaction FROM public.test_parameter_versions
        WHERE organization_id=NEW.organization_id AND parameter_id=NEW.parameter_id AND revision=NEW.result_revision;
    ELSIF upload.resource='methods' AND NEW.method_id IS NOT NULL THEN
      SELECT request_id,saved_by,created_transaction_id INTO actual_request,actual_actor,actual_transaction FROM public.method_versions
        WHERE organization_id=NEW.organization_id AND method_id=NEW.method_id AND revision=NEW.result_revision;
    ELSIF upload.resource='users' AND NEW.user_id IS NOT NULL AND reviewed.operation='create' AND reviewed.expected_revision=0 AND NEW.result_revision=1 THEN
      SELECT request_id,created_by,created_transaction_id INTO actual_request,actual_actor,actual_transaction FROM public.user_creation_commands
        WHERE organization_id=NEW.organization_id AND user_id=NEW.user_id AND profile_revision=NEW.result_revision;
    END IF;
    IF actual_request IS DISTINCT FROM reviewed.id OR actual_actor IS DISTINCT FROM actor OR actual_transaction IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'Bulk success requires an actual master save in this transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION master_bulk_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected_columns integer;
BEGIN
  IF TG_TABLE_NAME='master_bulk_batches' THEN
    IF NEW.column_count<>(SELECT count(*) FROM public.master_bulk_columns WHERE organization_id=NEW.organization_id AND batch_id=NEW.id)
      OR NEW.row_count<>(SELECT count(*) FROM public.master_bulk_rows WHERE organization_id=NEW.organization_id AND batch_id=NEW.id) THEN
      RAISE EXCEPTION 'Complete the uploaded row and column shape' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT column_count INTO expected_columns FROM public.master_bulk_batches WHERE organization_id=NEW.organization_id AND id=NEW.batch_id;
    IF expected_columns<>(SELECT count(*) FROM public.master_bulk_cells
      WHERE organization_id=NEW.organization_id AND batch_id=NEW.batch_id AND row_id=NEW.row_id AND revision=NEW.revision) THEN
      RAISE EXCEPTION 'Complete every input cell, including missing cells' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.master_bulk_batches WHERE organization_id=NEW.organization_id AND id=NEW.batch_id AND resource='users')
      AND NOT EXISTS (SELECT 1 FROM public.master_bulk_user_credentials WHERE organization_id=NEW.organization_id AND batch_id=NEW.batch_id
        AND row_id=NEW.row_id AND input_revision=NEW.revision) THEN
      RAISE EXCEPTION 'Complete the protected User credential state' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION master_bulk_guard_inserted_cells() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF actor IS NULL OR org IS NULL
    OR EXISTS (SELECT 1 FROM inserted_master_bulk_cells WHERE organization_id IS DISTINCT FROM org) THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT DISTINCT organization_id,batch_id FROM inserted_master_bulk_cells) inserted
    LEFT JOIN public.master_bulk_batches batch ON batch.organization_id=inserted.organization_id AND batch.id=inserted.batch_id
    WHERE NOT public.master_bulk_has_permission(batch.resource)) THEN
    RAISE EXCEPTION 'Bulk resource management permission required' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM inserted_master_bulk_cells cell
    JOIN public.master_bulk_batches batch ON batch.organization_id=cell.organization_id AND batch.id=cell.batch_id AND batch.resource='users'
    JOIN public.master_bulk_columns column_header ON column_header.organization_id=cell.organization_id AND column_header.batch_id=cell.batch_id
      AND column_header.column_number=cell.column_number AND trim(column_header.source_header)='password'
    WHERE cell.value_kind<>'text' OR cell.text_value IS DISTINCT FROM ''
      OR num_nonnulls(cell.source_type,cell.formula,cell.has_result,cell.error_code,cell.hyperlink,cell.number_format)<>0) THEN
    RAISE EXCEPTION 'Password values and provenance must be redacted' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT organization_id,batch_id,row_id,revision FROM inserted_master_bulk_cells) inserted
    LEFT JOIN public.master_bulk_row_versions parent ON parent.organization_id=inserted.organization_id AND parent.batch_id=inserted.batch_id
      AND parent.row_id=inserted.row_id AND parent.revision=inserted.revision
    WHERE parent.created_transaction_id IS DISTINCT FROM pg_current_xact_id() OR parent.saved_by IS DISTINCT FROM actor
  ) THEN RAISE EXCEPTION 'Input cells require the actual actor and an uncommitted input revision' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
