INSERT INTO permissions(code,description) VALUES
  ('compliance.read','View NABL certification records'),('compliance.manage','Manage NABL certification records')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE nabl_files (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  original_name text NOT NULL,
  media_type text NOT NULL,
  content bytea NOT NULL,
  byte_length integer NOT NULL,
  sha256 text NOT NULL,
  uploaded_by uuid NOT NULL,
  uploaded_by_username text NOT NULL,
  uploaded_by_name text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT nabl_file_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT nabl_file_actor_fk FOREIGN KEY(organization_id,uploaded_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT nabl_file_fields CHECK (length(original_name) BETWEEN 1 AND 500 AND original_name=trim(original_name)
    AND original_name !~ '[[:cntrl:]]' AND position('/' IN original_name)=0 AND position(chr(92) IN original_name)=0
    AND length(media_type) BETWEEN 1 AND 255 AND media_type=lower(media_type)
    AND media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
    AND byte_length BETWEEN 0 AND 26214400 AND byte_length=octet_length(content) AND sha256=encode(sha256(content),'hex'))
);
CREATE TABLE nabl_certifications (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT nabl_certification_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT nabl_certification_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT nabl_certification_revision CHECK (revision>0)
);
CREATE INDEX nabl_certification_listing ON nabl_certifications(organization_id,created_at,id) WHERE active;
CREATE TABLE nabl_certificate_versions (
  organization_id uuid NOT NULL,
  certification_id uuid NOT NULL,
  revision integer NOT NULL,
  previous_revision integer,
  request_id uuid NOT NULL,
  operation text NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  scope_file_id uuid,
  certificate_file_id uuid,
  scope_count integer NOT NULL,
  active boolean NOT NULL,
  saved_by uuid NOT NULL,
  saved_by_username text NOT NULL,
  saved_by_name text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT nabl_version_pk PRIMARY KEY(organization_id,certification_id,revision),
  CONSTRAINT nabl_request_key UNIQUE(organization_id,request_id),
  CONSTRAINT nabl_version_parent_fk FOREIGN KEY(organization_id,certification_id) REFERENCES nabl_certifications(organization_id,id),
  CONSTRAINT nabl_version_actor_fk FOREIGN KEY(organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT nabl_scope_file_fk FOREIGN KEY(organization_id,scope_file_id) REFERENCES nabl_files(organization_id,id),
  CONSTRAINT nabl_certificate_file_fk FOREIGN KEY(organization_id,certificate_file_id) REFERENCES nabl_files(organization_id,id),
  CONSTRAINT nabl_version_revision CHECK ((operation='create' AND previous_revision IS NULL AND revision=1 AND active)
    OR (operation IN ('update','retire') AND previous_revision IS NOT NULL AND previous_revision>0 AND revision=previous_revision+1 AND active=(operation='update'))),
  CONSTRAINT nabl_version_fields CHECK (valid_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    AND valid_to BETWEEN valid_from AND DATE '9999-12-31' AND scope_count>=0)
);
CREATE TABLE nabl_scope_rows (
  organization_id uuid NOT NULL,
  certification_id uuid NOT NULL,
  revision integer NOT NULL,
  parameter_id uuid NOT NULL,
  position integer NOT NULL,
  parameter_name text NOT NULL,
  scheme_abbreviation text NOT NULL,
  parameter_revision integer NOT NULL,
  product_count integer NOT NULL,
  method_count integer NOT NULL,
  CONSTRAINT nabl_scope_pk PRIMARY KEY(organization_id,certification_id,revision,parameter_id),
  CONSTRAINT nabl_scope_position UNIQUE(organization_id,certification_id,revision,position),
  CONSTRAINT nabl_scope_version_fk FOREIGN KEY(organization_id,certification_id,revision) REFERENCES nabl_certificate_versions(organization_id,certification_id,revision),
  CONSTRAINT nabl_scope_parameter_fk FOREIGN KEY(organization_id,parameter_id) REFERENCES test_parameters(organization_id,id),
  CONSTRAINT nabl_scope_fields CHECK (position>=0 AND parameter_revision>0 AND product_count>=0 AND method_count>=0)
);
CREATE TABLE nabl_scope_products (
  organization_id uuid NOT NULL,
  certification_id uuid NOT NULL,
  revision integer NOT NULL,
  parameter_id uuid NOT NULL,
  product_id uuid NOT NULL,
  position integer NOT NULL,
  product_name text NOT NULL,
  product_revision integer NOT NULL,
  CONSTRAINT nabl_scope_product_pk PRIMARY KEY(organization_id,certification_id,revision,parameter_id,product_id),
  CONSTRAINT nabl_scope_product_position UNIQUE(organization_id,certification_id,revision,parameter_id,position),
  CONSTRAINT nabl_scope_product_parent_fk FOREIGN KEY(organization_id,certification_id,revision,parameter_id) REFERENCES nabl_scope_rows(organization_id,certification_id,revision,parameter_id),
  CONSTRAINT nabl_scope_product_reference_fk FOREIGN KEY(organization_id,product_id) REFERENCES products(organization_id,id),
  CONSTRAINT nabl_scope_product_fields CHECK (position>=0 AND product_revision>0)
);
CREATE TABLE nabl_scope_methods (
  organization_id uuid NOT NULL,
  certification_id uuid NOT NULL,
  revision integer NOT NULL,
  parameter_id uuid NOT NULL,
  method_id uuid NOT NULL,
  position integer NOT NULL,
  method_name text NOT NULL,
  method_revision integer NOT NULL,
  CONSTRAINT nabl_scope_method_pk PRIMARY KEY(organization_id,certification_id,revision,parameter_id,method_id),
  CONSTRAINT nabl_scope_method_position UNIQUE(organization_id,certification_id,revision,parameter_id,position),
  CONSTRAINT nabl_scope_method_parent_fk FOREIGN KEY(organization_id,certification_id,revision,parameter_id) REFERENCES nabl_scope_rows(organization_id,certification_id,revision,parameter_id),
  CONSTRAINT nabl_scope_method_reference_fk FOREIGN KEY(organization_id,method_id) REFERENCES methods_of_analysis(organization_id,id),
  CONSTRAINT nabl_scope_method_fields CHECK (position>=0 AND method_revision>0)
);
--> statement-breakpoint
CREATE FUNCTION nabl_scope_organization() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT session.organization_id FROM public.sessions session
  JOIN public.users person ON person.id=session.user_id AND person.active AND NOT person.must_change_password
  JOIN public.credentials credential ON credential.user_id=person.id AND credential.revision=session.credential_revision
  JOIN public.memberships membership ON membership.organization_id=session.organization_id AND membership.user_id=person.id AND membership.active
  JOIN public.organizations organization ON organization.id=session.organization_id AND organization.active
  WHERE session.id=nullif(current_setting('app.session_id',true),'')::uuid
    AND session.user_id=nullif(current_setting('app.user_id',true),'')::uuid
    AND session.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
    AND (public.app_has_permission('compliance.read') OR public.app_has_permission('compliance.manage'))
$$;
CREATE FUNCTION nabl_lock_writer() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF actor IS NULL OR org IS NULL OR public.nabl_scope_organization() IS DISTINCT FROM org OR NOT public.app_has_permission('compliance.manage') THEN
    RAISE EXCEPTION 'Active compliance management session required' USING ERRCODE='42501',CONSTRAINT='nabl_session_required';
  END IF;
  -- Observations do not modify identity. SHARE also remains compatible with
  -- Method access-history user locks acquired after the method head.
  PERFORM 1 FROM public.users WHERE id=actor FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR SHARE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=actor FOR SHARE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  IF public.nabl_scope_organization() IS DISTINCT FROM org OR NOT public.app_has_permission('compliance.manage') THEN
    RAISE EXCEPTION 'Active compliance management session required' USING ERRCODE='42501',CONSTRAINT='nabl_session_required';
  END IF;
  RETURN actor;
END $$;
CREATE FUNCTION nabl_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'NABL history and original files are immutable' USING ERRCODE='55000'; END $$;
CREATE FUNCTION nabl_guard_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM public.nabl_scope_organization()
    OR NEW.uploaded_by IS DISTINCT FROM public.nabl_lock_writer()
    OR NEW.uploaded_at IS DISTINCT FROM transaction_timestamp() OR NEW.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS (SELECT 1 FROM public.users WHERE id=NEW.uploaded_by AND username=NEW.uploaded_by_username AND display_name=NEW.uploaded_by_name) THEN
    RAISE EXCEPTION 'File provenance must describe the actual upload' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nabl_file_provenance BEFORE INSERT ON nabl_files FOR EACH ROW EXECUTE FUNCTION nabl_guard_file();
CREATE FUNCTION nabl_guard_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM public.nabl_scope_organization()
    OR NEW.saved_by IS DISTINCT FROM public.nabl_lock_writer()
    OR NEW.saved_at IS DISTINCT FROM transaction_timestamp() OR NEW.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS (SELECT 1 FROM public.nabl_certifications head JOIN public.users actor ON actor.id=NEW.saved_by
      WHERE head.organization_id=NEW.organization_id AND head.id=NEW.certification_id
        AND head.revision=NEW.revision AND head.active=NEW.active AND head.updated_at=NEW.saved_at
        AND actor.username=NEW.saved_by_username AND actor.display_name=NEW.saved_by_name) THEN
    RAISE EXCEPTION 'Version provenance must describe the actual certification save' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nabl_version_provenance BEFORE INSERT ON nabl_certificate_versions FOR EACH ROW EXECUTE FUNCTION nabl_guard_version();
--> statement-breakpoint
-- Validate each inserted batch once; no per-scope identity or reference query.
CREATE FUNCTION nabl_guard_scope_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inserted_scopes item LEFT JOIN public.nabl_certificate_versions version
    ON version.organization_id=item.organization_id AND version.certification_id=item.certification_id AND version.revision=item.revision
    WHERE version.created_transaction_id IS DISTINCT FROM pg_current_xact_id()
      OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR item.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid) THEN
    RAISE EXCEPTION 'Scope rows belong to the actual new version transaction' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='nabl_scope_rows' THEN
    IF EXISTS (SELECT 1 FROM inserted_scopes item JOIN public.test_parameters reference
      ON reference.organization_id=item.organization_id AND reference.id=item.parameter_id
      WHERE (item.parameter_name,item.scheme_abbreviation,item.parameter_revision) IS DISTINCT FROM (reference.name,reference.scheme_abbreviation,reference.revision)) THEN
      RAISE EXCEPTION 'Parameter observations must describe the selected reference' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='nabl_scope_products' THEN
    IF EXISTS (SELECT 1 FROM inserted_scopes item JOIN public.products reference
      ON reference.organization_id=item.organization_id AND reference.id=item.product_id
      WHERE (item.product_name,item.product_revision) IS DISTINCT FROM (reference.name,reference.revision)) THEN
      RAISE EXCEPTION 'Product observations must describe the selected reference' USING ERRCODE='23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM inserted_scopes item JOIN public.methods_of_analysis reference
      ON reference.organization_id=item.organization_id AND reference.id=item.method_id
      WHERE (item.method_name,item.method_revision) IS DISTINCT FROM (reference.name,reference.revision)) THEN
      RAISE EXCEPTION 'Method observations must describe the selected reference' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER nabl_scope_batch AFTER INSERT ON nabl_scope_rows REFERENCING NEW TABLE AS inserted_scopes
  FOR EACH STATEMENT EXECUTE FUNCTION nabl_guard_scope_batch();
CREATE TRIGGER nabl_product_batch AFTER INSERT ON nabl_scope_products REFERENCING NEW TABLE AS inserted_scopes
  FOR EACH STATEMENT EXECUTE FUNCTION nabl_guard_scope_batch();
CREATE TRIGGER nabl_method_batch AFTER INSERT ON nabl_scope_methods REFERENCING NEW TABLE AS inserted_scopes
  FOR EACH STATEMENT EXECUTE FUNCTION nabl_guard_scope_batch();
CREATE FUNCTION nabl_check_scope_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE invalid boolean;
BEGIN
  WITH scoped AS (SELECT * FROM public.nabl_scope_rows WHERE organization_id=NEW.organization_id AND certification_id=NEW.certification_id AND revision=NEW.revision),
  product_counts AS (SELECT parameter_id,count(*) AS count,min(position) AS first,max(position) AS last FROM public.nabl_scope_products
    WHERE organization_id=NEW.organization_id AND certification_id=NEW.certification_id AND revision=NEW.revision GROUP BY parameter_id),
  method_counts AS (SELECT parameter_id,count(*) AS count,min(position) AS first,max(position) AS last FROM public.nabl_scope_methods
    WHERE organization_id=NEW.organization_id AND certification_id=NEW.certification_id AND revision=NEW.revision GROUP BY parameter_id)
  SELECT (SELECT count(*) FROM scoped)<>NEW.scope_count
    OR (NEW.scope_count>0 AND ((SELECT min(position) FROM scoped)<>0 OR (SELECT max(position) FROM scoped)<>NEW.scope_count-1))
    OR EXISTS (SELECT 1 FROM scoped item LEFT JOIN product_counts product USING(parameter_id) LEFT JOIN method_counts method USING(parameter_id)
      WHERE item.product_count<>coalesce(product.count,0) OR item.method_count<>coalesce(method.count,0)
        OR (item.product_count>0 AND (product.first<>0 OR product.last<>item.product_count-1))
        OR (item.method_count>0 AND (method.first<>0 OR method.last<>item.method_count-1))) INTO invalid;
  IF invalid THEN RAISE EXCEPTION 'Certification history requires complete ordered scope rows' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER nabl_scope_complete AFTER INSERT ON nabl_certificate_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nabl_check_scope_complete();
CREATE FUNCTION nabl_guard_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Certifications are retired with history' USING ERRCODE='55000'; END IF;
  IF NEW.organization_id IS DISTINCT FROM public.nabl_scope_organization() OR NOT public.app_has_permission('compliance.manage')
    OR NEW.updated_at IS DISTINCT FROM transaction_timestamp()
    OR (TG_OP='INSERT' AND (NEW.revision<>1 OR NOT NEW.active OR NEW.created_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid OR NEW.created_at<>transaction_timestamp())) THEN
    RAISE EXCEPTION 'Certification identity requires its actual authoring transaction' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NOT OLD.active OR NEW.revision<>OLD.revision+1
    OR (NEW.organization_id,NEW.id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_by,OLD.created_at)) THEN
    RAISE EXCEPTION 'Certification changes preserve identity and advance the active revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nabl_head_guard BEFORE INSERT OR UPDATE OR DELETE ON nabl_certifications FOR EACH ROW EXECUTE FUNCTION nabl_guard_head();
CREATE FUNCTION nabl_check_head_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.nabl_certifications head JOIN public.nabl_certificate_versions version
    ON version.organization_id=head.organization_id AND version.certification_id=head.id AND version.revision=head.revision
    WHERE head.organization_id=NEW.organization_id AND head.id=NEW.id AND version.active=head.active
      AND version.saved_at=head.updated_at AND version.created_transaction_id=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Certification changes require their complete current version' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER nabl_head_complete AFTER INSERT OR UPDATE ON nabl_certifications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nabl_check_head_complete();
--> statement-breakpoint
CREATE FUNCTION nabl_upload_file(requested_id uuid,requested_name text,requested_type text,requested_content bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.nabl_lock_writer(); org uuid:=public.nabl_scope_organization(); stored public.nabl_files%ROWTYPE;
BEGIN
  IF requested_id IS NULL OR requested_content IS NULL OR octet_length(requested_content)>26214400 THEN
    RAISE EXCEPTION 'Invalid NABL attachment' USING ERRCODE='23514',CONSTRAINT='nabl_invalid_file';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('nabl-file:'||org::text||':'||requested_id::text,0));
  PERFORM public.nabl_lock_writer();
  SELECT * INTO stored FROM public.nabl_files WHERE organization_id=org AND id=requested_id;
  IF FOUND THEN
    IF (stored.uploaded_by,stored.original_name,stored.media_type,stored.content)
      IS DISTINCT FROM (actor,requested_name,requested_type,requested_content) THEN
      RAISE EXCEPTION 'Upload request already used' USING ERRCODE='23514',CONSTRAINT='nabl_file_request_reused';
    END IF;
    RETURN true;
  END IF;
  INSERT INTO public.nabl_files(organization_id,id,original_name,media_type,content,byte_length,sha256,uploaded_by,uploaded_by_username,uploaded_by_name)
    SELECT org,requested_id,requested_name,requested_type,requested_content,octet_length(requested_content),encode(sha256(requested_content),'hex'),actor,username,display_name
      FROM public.users WHERE id=actor;
  RETURN false;
END $$;
CREATE FUNCTION nabl_write_certificate(requested_operation text,target uuid,expected_revision integer,requested_id uuid,
  requested_from date,requested_to date,requested_scope_file uuid,requested_certificate_file uuid,
  requested_parameters uuid[],requested_product_parameters uuid[],requested_products uuid[],requested_method_parameters uuid[],requested_methods uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.nabl_lock_writer(); org uuid:=public.nabl_scope_organization();
  head public.nabl_certifications%ROWTYPE; stored public.nabl_certificate_versions%ROWTYPE;
  operation_value text; invalid boolean; parameters uuid[]; product_parameters uuid[]; selected_products uuid[]; method_parameters uuid[]; selected_methods uuid[];
BEGIN
  IF requested_operation IS NULL OR requested_operation NOT IN ('save','retire') OR target IS NULL OR requested_id IS NULL
    OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646
    OR (requested_operation='retire' AND (expected_revision=0 OR requested_from IS NOT NULL OR requested_to IS NOT NULL
      OR requested_scope_file IS NOT NULL OR requested_certificate_file IS NOT NULL OR requested_parameters IS NOT NULL
      OR requested_product_parameters IS NOT NULL OR requested_products IS NOT NULL OR requested_method_parameters IS NOT NULL OR requested_methods IS NOT NULL)) THEN
    RAISE EXCEPTION 'Invalid certification command' USING ERRCODE='23514',CONSTRAINT='nabl_invalid_input';
  END IF;
  operation_value:=CASE WHEN requested_operation='retire' THEN 'retire' WHEN expected_revision=0 THEN 'create' ELSE 'update' END;
  IF requested_operation='save' THEN
    IF requested_from IS NULL OR requested_to IS NULL OR requested_from NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      OR requested_to NOT BETWEEN requested_from AND DATE '9999-12-31'
      OR requested_parameters IS NULL OR requested_product_parameters IS NULL OR requested_products IS NULL OR requested_method_parameters IS NULL OR requested_methods IS NULL
      OR coalesce(array_ndims(requested_parameters),1)<>1 OR coalesce(array_lower(requested_parameters,1),1)<>1
      OR coalesce(array_ndims(requested_products),1)<>1 OR coalesce(array_lower(requested_products,1),1)<>1
      OR coalesce(array_ndims(requested_product_parameters),1)<>1 OR coalesce(array_lower(requested_product_parameters,1),1)<>1
      OR coalesce(array_ndims(requested_methods),1)<>1 OR coalesce(array_lower(requested_methods,1),1)<>1
      OR coalesce(array_ndims(requested_method_parameters),1)<>1 OR coalesce(array_lower(requested_method_parameters,1),1)<>1
      OR cardinality(requested_parameters)>2000 OR cardinality(requested_products)<>cardinality(requested_product_parameters)
      OR cardinality(requested_methods)<>cardinality(requested_method_parameters)
      OR array_position(requested_parameters,NULL) IS NOT NULL OR array_position(requested_products,NULL) IS NOT NULL
      OR array_position(requested_methods,NULL) IS NOT NULL OR array_position(requested_product_parameters,NULL) IS NOT NULL
      OR array_position(requested_method_parameters,NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid certification fields' USING ERRCODE='23514',CONSTRAINT='nabl_invalid_input';
    END IF;
    IF (SELECT count(DISTINCT id) FROM unnest(requested_parameters) id)<>cardinality(requested_parameters)
      OR EXISTS (SELECT 1 FROM unnest(requested_product_parameters,requested_products) item(parameter_id,id)
        GROUP BY parameter_id HAVING count(*)>500 OR count(DISTINCT id)<>count(*) OR NOT parameter_id=ANY(requested_parameters))
      OR EXISTS (SELECT 1 FROM unnest(requested_method_parameters,requested_methods) item(parameter_id,id)
        GROUP BY parameter_id HAVING count(*)>500 OR count(DISTINCT id)<>count(*) OR NOT parameter_id=ANY(requested_parameters)) THEN
      RAISE EXCEPTION 'Invalid or duplicate scope selections' USING ERRCODE='23514',CONSTRAINT='nabl_invalid_input';
    END IF;
    -- Canonical grouping preserves the authored order within each parameter.
    parameters:=requested_parameters;
    SELECT coalesce(array_agg(item.parameter_id ORDER BY array_position(parameters,item.parameter_id),item.position),'{}'::uuid[]),
      coalesce(array_agg(item.id ORDER BY array_position(parameters,item.parameter_id),item.position),'{}'::uuid[])
      INTO product_parameters,selected_products FROM unnest(requested_product_parameters,requested_products) WITH ORDINALITY item(parameter_id,id,position);
    SELECT coalesce(array_agg(item.parameter_id ORDER BY array_position(parameters,item.parameter_id),item.position),'{}'::uuid[]),
      coalesce(array_agg(item.id ORDER BY array_position(parameters,item.parameter_id),item.position),'{}'::uuid[])
      INTO method_parameters,selected_methods FROM unnest(requested_method_parameters,requested_methods) WITH ORDINALITY item(parameter_id,id,position);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('nabl-request:'||org::text||':'||requested_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('nabl-certificate:'||org::text||':'||target::text,0));
  PERFORM public.nabl_lock_writer();
  SELECT * INTO stored FROM public.nabl_certificate_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF (stored.certification_id,coalesce(stored.previous_revision,0),stored.operation,stored.saved_by)
      IS DISTINCT FROM (target,expected_revision,operation_value,actor) THEN
      RAISE EXCEPTION 'Save request already used' USING ERRCODE='23514',CONSTRAINT='nabl_request_reused';
    END IF;
    IF requested_operation='save' AND (
      (stored.valid_from,stored.valid_to,stored.scope_file_id,stored.certificate_file_id) IS DISTINCT FROM (requested_from,requested_to,requested_scope_file,requested_certificate_file)
      OR parameters IS DISTINCT FROM ARRAY(SELECT parameter_id FROM public.nabl_scope_rows WHERE organization_id=org AND certification_id=target AND revision=stored.revision ORDER BY position)
      OR product_parameters IS DISTINCT FROM ARRAY(SELECT item.parameter_id FROM public.nabl_scope_products item JOIN public.nabl_scope_rows scope USING(organization_id,certification_id,revision,parameter_id)
        WHERE item.organization_id=org AND item.certification_id=target AND item.revision=stored.revision ORDER BY scope.position,item.position)
      OR selected_products IS DISTINCT FROM ARRAY(SELECT item.product_id FROM public.nabl_scope_products item JOIN public.nabl_scope_rows scope USING(organization_id,certification_id,revision,parameter_id)
        WHERE item.organization_id=org AND item.certification_id=target AND item.revision=stored.revision ORDER BY scope.position,item.position)
      OR method_parameters IS DISTINCT FROM ARRAY(SELECT item.parameter_id FROM public.nabl_scope_methods item JOIN public.nabl_scope_rows scope USING(organization_id,certification_id,revision,parameter_id)
        WHERE item.organization_id=org AND item.certification_id=target AND item.revision=stored.revision ORDER BY scope.position,item.position)
      OR selected_methods IS DISTINCT FROM ARRAY(SELECT item.method_id FROM public.nabl_scope_methods item JOIN public.nabl_scope_rows scope USING(organization_id,certification_id,revision,parameter_id)
        WHERE item.organization_id=org AND item.certification_id=target AND item.revision=stored.revision ORDER BY scope.position,item.position)) THEN
      RAISE EXCEPTION 'Save request already used' USING ERRCODE='23514',CONSTRAINT='nabl_request_reused';
    END IF;
    RETURN stored.revision;
  END IF;
  SELECT * INTO head FROM public.nabl_certifications WHERE organization_id=org AND id=target FOR UPDATE;
  IF NOT FOUND AND expected_revision>0 THEN RAISE EXCEPTION 'Certification not found' USING ERRCODE='23514',CONSTRAINT='nabl_not_found'; END IF;
  IF (head.id IS NOT NULL AND (head.revision<>expected_revision OR NOT head.active)) OR (head.id IS NULL AND expected_revision<>0) THEN
    RAISE EXCEPTION 'Certification changed' USING ERRCODE='23514',CONSTRAINT='nabl_stale';
  END IF;
  IF requested_operation='retire' THEN
    SELECT * INTO stored FROM public.nabl_certificate_versions WHERE organization_id=org AND certification_id=target AND revision=head.revision;
    requested_from:=stored.valid_from; requested_to:=stored.valid_to;
    requested_scope_file:=stored.scope_file_id; requested_certificate_file:=stored.certificate_file_id;
    parameters:=ARRAY(SELECT parameter_id FROM public.nabl_scope_rows WHERE organization_id=org AND certification_id=target AND revision=head.revision ORDER BY position);
    SELECT coalesce(array_agg(item.parameter_id ORDER BY scope.position,item.position),'{}'::uuid[]),coalesce(array_agg(item.product_id ORDER BY scope.position,item.position),'{}'::uuid[])
      INTO product_parameters,selected_products FROM public.nabl_scope_products item JOIN public.nabl_scope_rows scope USING(organization_id,certification_id,revision,parameter_id)
      WHERE item.organization_id=org AND item.certification_id=target AND item.revision=head.revision;
    SELECT coalesce(array_agg(item.parameter_id ORDER BY scope.position,item.position),'{}'::uuid[]),coalesce(array_agg(item.method_id ORDER BY scope.position,item.position),'{}'::uuid[])
      INTO method_parameters,selected_methods FROM public.nabl_scope_methods item JOIN public.nabl_scope_rows scope USING(organization_id,certification_id,revision,parameter_id)
      WHERE item.organization_id=org AND item.certification_id=target AND item.revision=head.revision;
  END IF;
  PERFORM 1 FROM public.test_parameters WHERE organization_id=org AND id=ANY(parameters) ORDER BY id FOR SHARE;
  IF (SELECT count(*) FROM public.test_parameters WHERE organization_id=org AND id=ANY(parameters))<>cardinality(parameters) THEN
    RAISE EXCEPTION 'Parameter unavailable' USING ERRCODE='23514',CONSTRAINT='nabl_invalid_reference';
  END IF;
  PERFORM 1 FROM public.products WHERE organization_id=org AND id=ANY(selected_products) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.methods_of_analysis WHERE organization_id=org AND id=ANY(selected_methods) ORDER BY id FOR SHARE;
  IF EXISTS (SELECT id FROM unnest(selected_products) id EXCEPT SELECT id FROM public.products WHERE organization_id=org AND id=ANY(selected_products))
    OR EXISTS (SELECT id FROM unnest(selected_methods) id EXCEPT SELECT id FROM public.methods_of_analysis WHERE organization_id=org AND id=ANY(selected_methods))
    OR (requested_scope_file IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.nabl_files WHERE organization_id=org AND id=requested_scope_file))
    OR (requested_certificate_file IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.nabl_files WHERE organization_id=org AND id=requested_certificate_file)) THEN
    RAISE EXCEPTION 'Scope or file reference unavailable' USING ERRCODE='23514',CONSTRAINT='nabl_invalid_reference';
  END IF;
  IF requested_operation='save' THEN
    WITH available AS MATERIALIZED (SELECT test_parameter_id,product_id,method_id FROM public.decision_rules
      WHERE organization_id=org AND active AND test_parameter_id=ANY(parameters)
        AND (product_id=ANY(selected_products) OR method_id=ANY(selected_methods)) ORDER BY id FOR SHARE)
    SELECT EXISTS (SELECT 1 FROM unnest(product_parameters,selected_products) item(parameter_id,id)
        WHERE NOT EXISTS (SELECT 1 FROM available WHERE test_parameter_id=item.parameter_id AND product_id=item.id))
      OR EXISTS (SELECT 1 FROM unnest(method_parameters,selected_methods) item(parameter_id,id)
        WHERE NOT EXISTS (SELECT 1 FROM available WHERE test_parameter_id=item.parameter_id AND method_id=item.id)) INTO invalid;
    IF invalid THEN RAISE EXCEPTION 'Selections require an active Decision Rule for this parameter' USING ERRCODE='23514',CONSTRAINT='nabl_invalid_scope'; END IF;
  END IF;
  PERFORM public.nabl_lock_writer();
  IF expected_revision=0 THEN
    INSERT INTO public.nabl_certifications(organization_id,id,created_by) VALUES(org,target,actor);
  ELSE
    UPDATE public.nabl_certifications SET revision=expected_revision+1,active=requested_operation='save',updated_at=transaction_timestamp()
      WHERE organization_id=org AND id=target;
  END IF;
  INSERT INTO public.nabl_certificate_versions(organization_id,certification_id,revision,previous_revision,request_id,operation,valid_from,valid_to,
    scope_file_id,certificate_file_id,scope_count,active,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,expected_revision+1,nullif(expected_revision,0),requested_id,operation_value,requested_from,requested_to,
      requested_scope_file,requested_certificate_file,cardinality(parameters),requested_operation='save',actor,username,display_name FROM public.users WHERE id=actor;
  WITH product_counts AS (SELECT parameter_id,count(*) AS count FROM unnest(product_parameters) parameter_id GROUP BY parameter_id),
    method_counts AS (SELECT parameter_id,count(*) AS count FROM unnest(method_parameters) parameter_id GROUP BY parameter_id)
  INSERT INTO public.nabl_scope_rows(organization_id,certification_id,revision,parameter_id,position,parameter_name,scheme_abbreviation,parameter_revision,product_count,method_count)
    SELECT org,target,expected_revision+1,item.id,item.position-1,reference.name,reference.scheme_abbreviation,reference.revision,coalesce(product.count,0),coalesce(method.count,0)
      FROM unnest(parameters) WITH ORDINALITY item(id,position)
      JOIN public.test_parameters reference ON reference.organization_id=org AND reference.id=item.id
      LEFT JOIN product_counts product ON product.parameter_id=item.id LEFT JOIN method_counts method ON method.parameter_id=item.id;
  INSERT INTO public.nabl_scope_products(organization_id,certification_id,revision,parameter_id,product_id,position,product_name,product_revision)
    SELECT org,target,expected_revision+1,item.parameter_id,item.id,row_number() OVER(PARTITION BY item.parameter_id ORDER BY item.position)-1,reference.name,reference.revision
      FROM unnest(product_parameters,selected_products) WITH ORDINALITY item(parameter_id,id,position)
      JOIN public.products reference ON reference.organization_id=org AND reference.id=item.id;
  INSERT INTO public.nabl_scope_methods(organization_id,certification_id,revision,parameter_id,method_id,position,method_name,method_revision)
    SELECT org,target,expected_revision+1,item.parameter_id,item.id,row_number() OVER(PARTITION BY item.parameter_id ORDER BY item.position)-1,reference.name,reference.revision
      FROM unnest(method_parameters,selected_methods) WITH ORDINALITY item(parameter_id,id,position)
      JOIN public.methods_of_analysis reference ON reference.organization_id=org AND reference.id=item.id;
  RETURN expected_revision+1;
END $$;
--> statement-breakpoint
CREATE TRIGGER nabl_file_immutable BEFORE UPDATE OR DELETE ON nabl_files FOR EACH ROW EXECUTE FUNCTION nabl_immutable();
CREATE TRIGGER nabl_version_immutable BEFORE UPDATE OR DELETE ON nabl_certificate_versions FOR EACH ROW EXECUTE FUNCTION nabl_immutable();
CREATE TRIGGER nabl_scope_immutable BEFORE UPDATE OR DELETE ON nabl_scope_rows FOR EACH ROW EXECUTE FUNCTION nabl_immutable();
CREATE TRIGGER nabl_product_immutable BEFORE UPDATE OR DELETE ON nabl_scope_products FOR EACH ROW EXECUTE FUNCTION nabl_immutable();
CREATE TRIGGER nabl_method_immutable BEFORE UPDATE OR DELETE ON nabl_scope_methods FOR EACH ROW EXECUTE FUNCTION nabl_immutable();
ALTER TABLE nabl_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE nabl_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE nabl_certificate_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nabl_scope_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE nabl_scope_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE nabl_scope_methods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nabl_files,nabl_certifications,nabl_certificate_versions,nabl_scope_rows,nabl_scope_products,nabl_scope_methods FROM PUBLIC,sampleify_app,sampleify_report_worker;
REVOKE ALL ON FUNCTION nabl_scope_organization(),nabl_lock_writer(),nabl_immutable(),nabl_guard_file(),nabl_guard_version(),nabl_guard_scope_batch(),
  nabl_check_scope_complete(),nabl_guard_head(),nabl_check_head_complete(),nabl_upload_file(uuid,text,text,bytea),
  nabl_write_certificate(text,uuid,integer,uuid,date,date,uuid,uuid,uuid[],uuid[],uuid[],uuid[],uuid[]) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION nabl_scope_organization(),nabl_upload_file(uuid,text,text,bytea),
  nabl_write_certificate(text,uuid,integer,uuid,date,date,uuid,uuid,uuid[],uuid[],uuid[],uuid[],uuid[]) TO sampleify_app;
--> statement-breakpoint
CREATE VIEW nabl_file_directory WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,original_name,media_type,byte_length,sha256,uploaded_by,uploaded_by_username,uploaded_by_name,uploaded_at
  FROM public.nabl_files WHERE organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_file_content WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,original_name,media_type,byte_length,sha256,uploaded_by,uploaded_by_username,uploaded_by_name,uploaded_at,encode(content,'base64') AS encoded_content
  FROM public.nabl_files WHERE organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_certificate_history WITH(security_barrier=true,security_invoker=false) AS
  SELECT version.*,scope.original_name AS scope_file_name,scope.media_type AS scope_file_type,scope.byte_length AS scope_file_length,scope.sha256 AS scope_file_sha256,
    certificate.original_name AS certificate_file_name,certificate.media_type AS certificate_file_type,certificate.byte_length AS certificate_file_length,certificate.sha256 AS certificate_file_sha256
  FROM public.nabl_certificate_versions version
    LEFT JOIN public.nabl_files scope ON scope.organization_id=version.organization_id AND scope.id=version.scope_file_id
    LEFT JOIN public.nabl_files certificate ON certificate.organization_id=version.organization_id AND certificate.id=version.certificate_file_id
  WHERE version.organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_certificate_directory WITH(security_barrier=true,security_invoker=false) AS
  SELECT version.*,head.created_at,head.updated_at FROM public.nabl_certificate_history version JOIN public.nabl_certifications head
    ON head.organization_id=version.organization_id AND head.id=version.certification_id AND head.revision=version.revision
  WHERE head.active AND head.organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_scope_history WITH(security_barrier=true,security_invoker=false) AS
  SELECT * FROM public.nabl_scope_rows WHERE organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_product_history WITH(security_barrier=true,security_invoker=false) AS
  SELECT * FROM public.nabl_scope_products WHERE organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_method_history WITH(security_barrier=true,security_invoker=false) AS
  SELECT * FROM public.nabl_scope_methods WHERE organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_parameter_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,name,scheme_abbreviation,display_order,revision,active FROM public.test_parameters WHERE organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_product_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,name,revision,active FROM public.products WHERE organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_method_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,name,revision,active FROM public.methods_of_analysis WHERE organization_id=(SELECT public.nabl_scope_organization());
CREATE VIEW nabl_rule_catalog WITH(security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,test_parameter_id,product_id,method_id FROM public.decision_rules WHERE active AND organization_id=(SELECT public.nabl_scope_organization());
REVOKE ALL ON nabl_file_directory,nabl_file_content,nabl_certificate_history,nabl_certificate_directory,nabl_scope_history,nabl_product_history,nabl_method_history,
  nabl_parameter_catalog,nabl_product_catalog,nabl_method_catalog,nabl_rule_catalog FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON nabl_file_directory,nabl_file_content,nabl_certificate_history,nabl_certificate_directory,nabl_scope_history,nabl_product_history,nabl_method_history,
  nabl_parameter_catalog,nabl_product_catalog,nabl_method_catalog,nabl_rule_catalog TO sampleify_app;
