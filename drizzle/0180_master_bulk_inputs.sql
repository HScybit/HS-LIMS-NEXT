-- Uploaded input is provenance. The existing master/version tables remain the
-- authority for business records; an upload never stores a serialized command.
CREATE TABLE master_bulk_batches (
  organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL,
  resource text NOT NULL, file_name text NOT NULL, file_format text NOT NULL, source_sha256 text NOT NULL,
  time_zone text NOT NULL, header_row_number integer NOT NULL, sheet_name text, sheet_count integer, date_1904 boolean,
  column_count integer NOT NULL, row_count integer NOT NULL,
  saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT master_bulk_batch_pk PRIMARY KEY (organization_id,id),
  CONSTRAINT master_bulk_batch_actor_fk FOREIGN KEY (organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT master_bulk_batch_fields CHECK (resource IN ('products','test-parameters','methods')
    AND length(file_name) BETWEEN 1 AND 250 AND file_format IN ('csv','xlsx') AND source_sha256 ~ '^[a-f0-9]{64}$'
    AND length(time_zone) BETWEEN 1 AND 100 AND header_row_number>0
    AND column_count BETWEEN 1 AND 250 AND row_count BETWEEN 1 AND 2500
    AND ((file_format='csv' AND num_nonnulls(sheet_name,sheet_count,date_1904)=0)
      OR (file_format='xlsx' AND sheet_name IS NOT NULL AND length(sheet_name) BETWEEN 1 AND 100
        AND sheet_count IS NOT NULL AND sheet_count BETWEEN 1 AND 512 AND date_1904 IS NOT NULL)))
);
CREATE INDEX master_bulk_batch_list ON master_bulk_batches(organization_id,resource,saved_at DESC,id);

CREATE TABLE master_bulk_columns (
  organization_id uuid NOT NULL, batch_id uuid NOT NULL, column_number integer NOT NULL, source_header text NOT NULL,
  source_type text, formula text, has_result boolean, error_code text, hyperlink text, number_format text,
  CONSTRAINT master_bulk_column_pk PRIMARY KEY (organization_id,batch_id,column_number),
  CONSTRAINT master_bulk_column_batch_fk FOREIGN KEY (organization_id,batch_id) REFERENCES master_bulk_batches(organization_id,id),
  CONSTRAINT master_bulk_column_fields CHECK (column_number BETWEEN 1 AND 250 AND length(source_header)<=16000
    AND (source_type IS NULL OR source_type IN ('formula','error','hyperlink','rich_text','formatted'))
    AND (formula IS NULL OR length(formula)<=16000) AND (error_code IS NULL OR length(error_code)<=16000)
    AND (hyperlink IS NULL OR length(hyperlink)<=16000) AND (number_format IS NULL OR length(number_format)<=16000))
);

CREATE TABLE master_bulk_rows (
  organization_id uuid NOT NULL, batch_id uuid NOT NULL, id uuid NOT NULL, ordinal integer NOT NULL, source_row_number integer NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  CONSTRAINT master_bulk_row_pk PRIMARY KEY (organization_id,batch_id,id),
  CONSTRAINT master_bulk_row_batch_fk FOREIGN KEY (organization_id,batch_id) REFERENCES master_bulk_batches(organization_id,id),
  CONSTRAINT master_bulk_row_order UNIQUE (organization_id,batch_id,ordinal),
  CONSTRAINT master_bulk_row_source UNIQUE (organization_id,batch_id,source_row_number),
  CONSTRAINT master_bulk_row_fields CHECK (ordinal BETWEEN 1 AND 2500 AND source_row_number>0 AND revision>0)
);

CREATE TABLE master_bulk_row_versions (
  organization_id uuid NOT NULL, batch_id uuid NOT NULL, row_id uuid NOT NULL, revision integer NOT NULL, request_id uuid NOT NULL,
  saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT master_bulk_row_version_pk PRIMARY KEY (organization_id,batch_id,row_id,revision),
  CONSTRAINT master_bulk_row_version_request UNIQUE (organization_id,request_id),
  CONSTRAINT master_bulk_row_version_parent_fk FOREIGN KEY (organization_id,batch_id,row_id) REFERENCES master_bulk_rows(organization_id,batch_id,id),
  CONSTRAINT master_bulk_row_version_actor_fk FOREIGN KEY (organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT master_bulk_row_version_fields CHECK (revision>0)
);
ALTER TABLE master_bulk_rows ADD CONSTRAINT master_bulk_row_head_fk FOREIGN KEY (organization_id,batch_id,id,revision)
  REFERENCES master_bulk_row_versions(organization_id,batch_id,row_id,revision) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE master_bulk_cells (
  organization_id uuid NOT NULL, batch_id uuid NOT NULL, row_id uuid NOT NULL, revision integer NOT NULL, column_number integer NOT NULL,
  value_kind text NOT NULL, text_value text, number_value double precision, boolean_value boolean, date_value timestamptz,
  source_type text, formula text, has_result boolean, error_code text, hyperlink text, number_format text,
  CONSTRAINT master_bulk_cell_pk PRIMARY KEY (organization_id,batch_id,row_id,revision,column_number),
  CONSTRAINT master_bulk_cell_version_fk FOREIGN KEY (organization_id,batch_id,row_id,revision) REFERENCES master_bulk_row_versions(organization_id,batch_id,row_id,revision),
  CONSTRAINT master_bulk_cell_column_fk FOREIGN KEY (organization_id,batch_id,column_number) REFERENCES master_bulk_columns(organization_id,batch_id,column_number),
  CONSTRAINT master_bulk_cell_value CHECK (
    (value_kind='missing' AND num_nonnulls(text_value,number_value,boolean_value,date_value)=0)
    OR (num_nonnulls(text_value,number_value,boolean_value,date_value)=1 AND
      ((value_kind='text' AND text_value IS NOT NULL AND length(text_value)<=16000)
      OR (value_kind='number' AND number_value IS NOT NULL AND number_value BETWEEN '-1.7976931348623157e308'::double precision AND '1.7976931348623157e308'::double precision)
      OR (value_kind='boolean' AND boolean_value IS NOT NULL)
      OR (value_kind='date' AND date_value IS NOT NULL AND isfinite(date_value))))),
  CONSTRAINT master_bulk_cell_source CHECK ((source_type IS NULL OR source_type IN ('formula','error','hyperlink','rich_text','formatted'))
    AND (formula IS NULL OR length(formula)<=16000) AND (error_code IS NULL OR length(error_code)<=16000)
    AND (hyperlink IS NULL OR length(hyperlink)<=16000) AND (number_format IS NULL OR length(number_format)<=16000))
);

CREATE TABLE master_bulk_reviews (
  organization_id uuid NOT NULL, id uuid NOT NULL, batch_id uuid NOT NULL, row_id uuid NOT NULL, input_revision integer NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  valid boolean NOT NULL, candidate_id uuid, expected_revision integer, operation text, definitions_sha256 text, command_sha256 text,
  error_code text, error_message text,
  saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT master_bulk_review_pk PRIMARY KEY (organization_id,id),
  CONSTRAINT master_bulk_review_row_key UNIQUE (organization_id,batch_id,row_id,input_revision,id),
  CONSTRAINT master_bulk_review_input_fk FOREIGN KEY (organization_id,batch_id,row_id,input_revision) REFERENCES master_bulk_row_versions(organization_id,batch_id,row_id,revision),
  CONSTRAINT master_bulk_review_actor_fk FOREIGN KEY (organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT master_bulk_review_fields CHECK (
    (valid AND candidate_id IS NOT NULL AND expected_revision IS NOT NULL AND expected_revision>=0
      AND operation IS NOT NULL AND operation IN ('create','update','reactivate','update_retired')
      AND definitions_sha256 IS NOT NULL AND definitions_sha256 ~ '^[a-f0-9]{64}$'
      AND command_sha256 IS NOT NULL AND command_sha256 ~ '^[a-f0-9]{64}$' AND error_code IS NULL AND error_message IS NULL
      AND ((operation='create')=(expected_revision=0)))
    OR (NOT valid AND num_nonnulls(candidate_id,expected_revision,operation,definitions_sha256,command_sha256)=0
      AND error_code IS NOT NULL AND length(error_code) BETWEEN 1 AND 100 AND error_message IS NOT NULL AND length(error_message) BETWEEN 1 AND 2000))
);
CREATE INDEX master_bulk_review_latest ON master_bulk_reviews(organization_id,batch_id,row_id,input_revision,sequence DESC);

CREATE TABLE master_bulk_attempts (
  organization_id uuid NOT NULL, id uuid NOT NULL, batch_id uuid NOT NULL, row_id uuid NOT NULL, input_revision integer NOT NULL, review_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  committed boolean NOT NULL, product_id uuid, parameter_id uuid, method_id uuid, result_revision integer,
  error_code text, error_message text,
  saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT master_bulk_attempt_pk PRIMARY KEY (organization_id,id),
  CONSTRAINT master_bulk_attempt_review_fk FOREIGN KEY (organization_id,batch_id,row_id,input_revision,review_id)
    REFERENCES master_bulk_reviews(organization_id,batch_id,row_id,input_revision,id),
  CONSTRAINT master_bulk_attempt_actor_fk FOREIGN KEY (organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT master_bulk_attempt_product_fk FOREIGN KEY (organization_id,product_id,result_revision) REFERENCES product_versions(organization_id,product_id,revision),
  CONSTRAINT master_bulk_attempt_parameter_fk FOREIGN KEY (organization_id,parameter_id,result_revision) REFERENCES test_parameter_versions(organization_id,parameter_id,revision),
  CONSTRAINT master_bulk_attempt_method_fk FOREIGN KEY (organization_id,method_id,result_revision) REFERENCES method_versions(organization_id,method_id,revision),
  CONSTRAINT master_bulk_attempt_fields CHECK (
    (committed AND num_nonnulls(product_id,parameter_id,method_id)=1 AND result_revision IS NOT NULL AND result_revision>0 AND error_code IS NULL AND error_message IS NULL)
    OR (NOT committed AND num_nonnulls(product_id,parameter_id,method_id,result_revision)=0
      AND error_code IS NOT NULL AND length(error_code) BETWEEN 1 AND 100 AND error_message IS NOT NULL AND length(error_message) BETWEEN 1 AND 2000))
);
CREATE UNIQUE INDEX master_bulk_one_commit ON master_bulk_attempts(organization_id,batch_id,row_id) WHERE committed;
CREATE INDEX master_bulk_attempt_latest ON master_bulk_attempts(organization_id,batch_id,row_id,sequence DESC);

CREATE FUNCTION master_bulk_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  upload public.master_bulk_batches; current_row public.master_bulk_rows; reviewed public.master_bulk_reviews;
  parent_transaction xid8; actual_request uuid; actual_actor uuid; actual_transaction xid8;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bulk input and outcomes are retained' USING ERRCODE='55000'; END IF;
  IF NOT public.app_has_permission('masters.manage') OR actor IS NULL
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
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
  SELECT * INTO upload FROM public.master_bulk_batches WHERE organization_id=NEW.organization_id AND id=NEW.batch_id;
  IF upload.id IS NULL THEN RAISE EXCEPTION 'Upload was not found' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME IN ('master_bulk_columns','master_bulk_rows') THEN
    IF upload.created_transaction_id<>pg_current_xact_id() THEN RAISE EXCEPTION 'Original upload shape is immutable' USING ERRCODE='55000'; END IF;
    IF TG_TABLE_NAME='master_bulk_columns' THEN
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
      OR coalesce(NEW.product_id,NEW.parameter_id,NEW.method_id) IS DISTINCT FROM reviewed.candidate_id THEN
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
    END IF;
    IF actual_request IS DISTINCT FROM reviewed.id OR actual_actor IS DISTINCT FROM actor OR actual_transaction IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'Bulk success requires an actual master save in this transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION master_bulk_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER master_bulk_batch_complete AFTER INSERT ON master_bulk_batches DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION master_bulk_complete();
CREATE CONSTRAINT TRIGGER master_bulk_version_complete AFTER INSERT ON master_bulk_row_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION master_bulk_complete();

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['master_bulk_batches','master_bulk_columns','master_bulk_rows','master_bulk_row_versions','master_bulk_cells','master_bulk_reviews','master_bulk_attempts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY master_bulk_scope ON %I USING (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT public.app_has_permission(''masters.manage''))) WITH CHECK (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid AND (SELECT public.app_has_permission(''masters.manage'')))',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,sampleify_report_worker',relation);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO sampleify_app',relation);
    EXECUTE format('CREATE TRIGGER master_bulk_input_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION master_bulk_guard()',relation);
  END LOOP;
END $$;
GRANT UPDATE(revision) ON master_bulk_rows TO sampleify_app;
REVOKE ALL ON FUNCTION master_bulk_guard(),master_bulk_complete() FROM PUBLIC,sampleify_app,sampleify_report_worker;

-- The source MoA sheet identifies access users by email. This narrow projection
-- has the same tenant/master-management boundary as the bulk operation.
CREATE VIEW master_bulk_user_labels WITH (security_barrier=true) AS
  SELECT member.organization_id,person.id,person.username,person.email,person.display_name,
    (member.active AND person.active) AS active
  FROM memberships member JOIN users person ON person.id=member.user_id
  WHERE member.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT public.app_has_permission('masters.manage'));
REVOKE ALL ON master_bulk_user_labels FROM PUBLIC,sampleify_report_worker;
GRANT SELECT ON master_bulk_user_labels TO sampleify_app;
