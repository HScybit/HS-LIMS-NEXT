-- Validate large certification scopes in batches even after repeated small saves.
-- Both functions retain their signatures, owner, ACL, security boundary and locks.
CREATE OR REPLACE FUNCTION public.nabl_write_certificate(requested_operation text,target uuid,expected_revision integer,requested_id uuid,
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
        AND (product_id=ANY(ARRAY(SELECT DISTINCT id FROM unnest(selected_products) id))
          OR method_id=ANY(ARRAY(SELECT DISTINCT id FROM unnest(selected_methods) id))) ORDER BY id FOR SHARE)
    SELECT EXISTS (SELECT item.parameter_id,item.id FROM unnest(product_parameters,selected_products) item(parameter_id,id)
        EXCEPT SELECT test_parameter_id,product_id FROM available)
      OR EXISTS (SELECT item.parameter_id,item.id FROM unnest(method_parameters,selected_methods) item(parameter_id,id)
        EXCEPT SELECT test_parameter_id,method_id FROM available) INTO invalid;
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
-- Aggregate child counts once; a newly written revision may have no statistics.
CREATE OR REPLACE FUNCTION public.nabl_check_scope_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE invalid boolean;
BEGIN
  WITH scoped AS MATERIALIZED (SELECT * FROM public.nabl_scope_rows
    WHERE organization_id=NEW.organization_id AND certification_id=NEW.certification_id AND revision=NEW.revision),
  observations AS (
    SELECT item.parameter_id,expected.kind,expected.quantity AS expected_count,NULL::integer AS position
      FROM scoped item CROSS JOIN LATERAL (VALUES ('product',item.product_count),('method',item.method_count)) expected(kind,quantity)
    UNION ALL
    SELECT parameter_id,'product',0,position FROM public.nabl_scope_products
      WHERE organization_id=NEW.organization_id AND certification_id=NEW.certification_id AND revision=NEW.revision
    UNION ALL
    SELECT parameter_id,'method',0,position FROM public.nabl_scope_methods
      WHERE organization_id=NEW.organization_id AND certification_id=NEW.certification_id AND revision=NEW.revision
  )
  SELECT (SELECT count(*) FROM scoped)<>NEW.scope_count
    OR (NEW.scope_count>0 AND ((SELECT min(position) FROM scoped)<>0 OR (SELECT max(position) FROM scoped)<>NEW.scope_count-1))
    OR EXISTS (SELECT 1 FROM observations GROUP BY parameter_id,kind
      HAVING sum(expected_count)<>count(position)
        OR (count(position)>0 AND (min(position)<>0 OR max(position)<>count(position)-1))) INTO invalid;
  IF invalid THEN RAISE EXCEPTION 'Certification history requires complete ordered scope rows' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
