-- Create-only Vendor uploads retain typed provenance and every existing cell FK.
ALTER TABLE master_bulk_batches DROP CONSTRAINT master_bulk_batch_fields;
ALTER TABLE master_bulk_batches ADD CONSTRAINT master_bulk_batch_fields CHECK (
  resource IN ('products','test-parameters','methods','users','customers','vendors')
  AND length(file_name) BETWEEN 1 AND 250 AND file_format IN ('csv','xlsx')
  AND ((resource='users' AND source_sha256 IS NULL AND source_hmac_sha256 IS NOT NULL AND source_hmac_sha256 ~ '^[a-f0-9]{64}$')
    OR (resource<>'users' AND source_hmac_sha256 IS NULL AND source_sha256 IS NOT NULL AND source_sha256 ~ '^[a-f0-9]{64}$'))
  AND length(time_zone) BETWEEN 1 AND 100 AND header_row_number>0
  AND column_count BETWEEN 1 AND 250 AND row_count BETWEEN 1 AND 2500
  AND ((file_format='csv' AND num_nonnulls(sheet_name,sheet_count,date_1904)=0)
    OR (file_format='xlsx' AND sheet_name IS NOT NULL AND length(sheet_name) BETWEEN 1 AND 100
      AND sheet_count IS NOT NULL AND sheet_count BETWEEN 1 AND 512 AND date_1904 IS NOT NULL)));

ALTER TABLE master_bulk_attempts ADD COLUMN vendor_id uuid;
ALTER TABLE master_bulk_attempts ADD CONSTRAINT master_bulk_attempt_vendor_fk
  FOREIGN KEY (organization_id,vendor_id,result_revision) REFERENCES vendor_versions(organization_id,vendor_id,revision);
ALTER TABLE master_bulk_attempts DROP CONSTRAINT master_bulk_attempt_fields;
ALTER TABLE master_bulk_attempts ADD CONSTRAINT master_bulk_attempt_fields CHECK (
  (committed AND num_nonnulls(product_id,parameter_id,method_id,user_id,customer_id,vendor_id)=1 AND result_revision IS NOT NULL AND result_revision>0 AND error_code IS NULL AND error_message IS NULL)
  OR (NOT committed AND num_nonnulls(product_id,parameter_id,method_id,user_id,customer_id,vendor_id,result_revision)=0
    AND error_code IS NOT NULL AND length(error_code) BETWEEN 1 AND 100 AND error_message IS NOT NULL AND length(error_message) BETWEEN 1 AND 2000));

CREATE OR REPLACE FUNCTION master_bulk_has_permission(resource text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT CASE WHEN resource='users' THEN public.app_has_permission('users.manage')
    WHEN resource='customers' THEN public.app_has_permission('masters.manage') AND public.organization_has_module_access('customer')
    WHEN resource='vendors' THEN public.app_has_permission('masters.manage') AND public.organization_has_module_access('vendor')
    WHEN resource IN ('products','test-parameters','methods') THEN public.app_has_permission('masters.manage') ELSE false END
$$;
REVOKE ALL ON FUNCTION master_bulk_has_permission(text) FROM PUBLIC,sampleify_app,sampleify_report_worker;

DROP POLICY master_bulk_scope ON master_bulk_batches;
CREATE POLICY master_bulk_scope ON master_bulk_batches USING (
  organization_id IS NOT DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
  AND ((resource='users' AND (SELECT public.app_has_permission('users.manage')))
    OR (resource='customers' AND (SELECT public.app_has_permission('masters.manage')) AND (SELECT public.organization_has_module_access('customer')))
    OR (resource='vendors' AND (SELECT public.app_has_permission('masters.manage')) AND (SELECT public.organization_has_module_access('vendor')))
    OR (resource IN ('products','test-parameters','methods') AND (SELECT public.app_has_permission('masters.manage')))))
WITH CHECK (
  organization_id IS NOT DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
  AND ((resource='users' AND (SELECT public.app_has_permission('users.manage')))
    OR (resource='customers' AND (SELECT public.app_has_permission('masters.manage')) AND (SELECT public.organization_has_module_access('customer')))
    OR (resource='vendors' AND (SELECT public.app_has_permission('masters.manage')) AND (SELECT public.organization_has_module_access('vendor')))
    OR (resource IN ('products','test-parameters','methods') AND (SELECT public.app_has_permission('masters.manage')))));
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
  -- Initial children require this transaction's batch; corrections advance its row.
  -- Hold the same authorization locks as native party saves for each mutation.
  IF upload.resource IN ('customers','vendors') AND (TG_TABLE_NAME IN ('master_bulk_batches','master_bulk_reviews','master_bulk_attempts') OR TG_OP='UPDATE') THEN
    IF upload.resource='vendors' THEN PERFORM public.masters_require_vendor_write();
    ELSE PERFORM public.masters_require_customer_write(); END IF;
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
  IF TG_TABLE_NAME='master_bulk_reviews' THEN
    IF upload.resource IN ('customers','vendors') AND NEW.valid AND (NEW.operation IS DISTINCT FROM 'create' OR NEW.expected_revision IS DISTINCT FROM 0) THEN
      RAISE EXCEPTION 'Party master uploads create records only' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO reviewed FROM public.master_bulk_reviews WHERE organization_id=NEW.organization_id AND id=NEW.review_id;
  IF NEW.committed THEN
    IF NOT reviewed.valid OR NEW.result_revision<>reviewed.expected_revision+1
      OR coalesce(NEW.product_id,NEW.parameter_id,NEW.method_id,NEW.user_id,NEW.customer_id,NEW.vendor_id) IS DISTINCT FROM reviewed.candidate_id THEN
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
    ELSIF upload.resource='customers' AND NEW.customer_id IS NOT NULL AND reviewed.operation='create' AND reviewed.expected_revision=0 AND NEW.result_revision=1 THEN
      SELECT request_id,saved_by,created_transaction_id INTO actual_request,actual_actor,actual_transaction FROM public.customer_versions
        WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id AND revision=NEW.result_revision AND operation='create' AND save_source='master';
    ELSIF upload.resource='vendors' AND NEW.vendor_id IS NOT NULL AND reviewed.operation='create' AND reviewed.expected_revision=0 AND NEW.result_revision=1 THEN
      SELECT request_id,saved_by,created_transaction_id INTO actual_request,actual_actor,actual_transaction FROM public.vendor_versions
        WHERE organization_id=NEW.organization_id AND vendor_id=NEW.vendor_id AND revision=NEW.result_revision AND operation='create';
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
