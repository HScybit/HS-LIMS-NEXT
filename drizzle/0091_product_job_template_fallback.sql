-- Resolve all selected product lines before creating any manual/automatic job.
-- The existing capture commands own template/version locks. Do not take shared
-- template locks here that those commands would later need to upgrade.
CREATE FUNCTION laboratory_product_job_templates(p_sample_id uuid, product_line_ids uuid[], automatic boolean)
RETURNS TABLE(sample_product_id uuid,template_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  settings public.organization_laboratory_settings;
BEGIN
  IF org IS NULL OR automatic IS NULL OR p_sample_id IS NULL
    OR NOT (CASE WHEN automatic THEN public.laboratory_job_generation_sample(p_sample_id) ELSE public.app_has_permission('test_requests.allocate') END)
  THEN RAISE EXCEPTION 'Job allocation or actual generation is required' USING ERRCODE='42501'; END IF;
  IF product_line_ids IS NULL OR cardinality(product_line_ids) NOT BETWEEN 1 AND 500 OR array_position(product_line_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT selected_id) FROM unnest(product_line_ids) selected_id)<>cardinality(product_line_ids)
  THEN RAISE EXCEPTION 'Select distinct product lines for one sample' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.samples WHERE organization_id=org AND id=p_sample_id FOR UPDATE;
  IF NOT FOUND OR (SELECT count(*) FROM public.sample_products line WHERE line.organization_id=org AND line.sample_id=p_sample_id
    AND line.id=ANY(product_line_ids))<>cardinality(product_line_ids)
  THEN RAISE EXCEPTION 'The selected product lines are unavailable' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.products product WHERE product.organization_id=org AND product.id IN
    (SELECT line.product_id FROM public.sample_products line WHERE line.organization_id=org AND line.sample_id=p_sample_id AND line.id=ANY(product_line_ids))
    ORDER BY product.id FOR SHARE;
  SELECT * INTO settings FROM public.organization_laboratory_settings WHERE organization_id=org FOR SHARE;
  -- A configured organization template takes precedence even if unavailable.
  -- Existing sample references remain usable after a Product is retired.
  RETURN QUERY SELECT line.id,CASE WHEN (NOT automatic OR coalesce(settings.auto_create_jobs,false)) AND template.active AND latest.kind='datasheet' THEN template.id END
    FROM public.sample_products line JOIN public.products product ON product.organization_id=line.organization_id AND product.id=line.product_id
    LEFT JOIN public.templates template ON template.organization_id=line.organization_id AND template.id=coalesce(settings.result_summary_template_id,product.job_template_id)
    LEFT JOIN LATERAL (SELECT version.kind FROM public.template_versions version WHERE version.organization_id=template.organization_id AND version.template_id=template.id
      AND version.status<>'building' ORDER BY (version.status='draft') DESC,version.number DESC LIMIT 1) latest ON true
    WHERE line.organization_id=org AND line.sample_id=p_sample_id AND line.id=ANY(product_line_ids) ORDER BY line.id;
END $$;
REVOKE ALL ON FUNCTION laboratory_product_job_templates(uuid,uuid[],boolean) FROM PUBLIC,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION laboratory_product_job_templates(uuid,uuid[],boolean) TO sampleify_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_start_auto_job(member_ids uuid[]) RETURNS TABLE(id uuid,request_number text,member_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  product_line uuid; selected_sample uuid; settings public.organization_laboratory_settings; job_id uuid:=gen_random_uuid(); job_number text; summary_template uuid;
BEGIN
  IF member_ids IS NULL OR cardinality(member_ids) NOT BETWEEN 1 AND 500 OR array_position(member_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT member_id) FROM unnest(member_ids) member_id)<>cardinality(member_ids) THEN RAISE EXCEPTION 'Select distinct new requests for an automatic job' USING ERRCODE='23514'; END IF;
  SELECT selected.sample_product_id,product.sample_id INTO product_line,selected_sample FROM public.test_requests request
    JOIN public.sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    WHERE request.organization_id=org AND request.id=member_ids[1];
  IF NOT public.laboratory_job_generation_sample(selected_sample) THEN RAISE EXCEPTION 'Automatic jobs require the actual generation action' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.samples WHERE organization_id=org AND public.samples.id=selected_sample FOR UPDATE;
  PERFORM 1 FROM public.test_requests request WHERE request.organization_id=org AND request.id=ANY(member_ids) ORDER BY request.id FOR UPDATE;
  IF (SELECT count(*) FROM public.test_requests request JOIN public.sample_tests selected
    ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
    WHERE request.organization_id=org AND request.id=ANY(member_ids) AND public.laboratory_new_generated_request(request.id)
      AND request.status='created' AND request.parent_test_request_id IS NULL AND selected.sample_product_id=product_line
      AND NOT EXISTS (SELECT 1 FROM public.test_request_assignments assignment WHERE assignment.organization_id=org
        AND assignment.test_request_id=request.id AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL))<>cardinality(member_ids)
  THEN RAISE EXCEPTION 'Automatic jobs can group only their newly generated product-line requests' USING ERRCODE='23514'; END IF;
  SELECT * INTO settings FROM public.organization_laboratory_settings WHERE organization_id=org FOR SHARE;
  SELECT resolved.template_id INTO summary_template FROM public.laboratory_product_job_templates(selected_sample,ARRAY[product_line],true) resolved;
  IF NOT coalesce(settings.auto_create_jobs,false) OR summary_template IS NULL
  THEN RAISE EXCEPTION 'Automatic job settings are unavailable' USING ERRCODE='23514'; END IF;
  job_number:=public.laboratory_next_number('job',extract(year FROM now() AT TIME ZONE 'UTC')::integer::text);
  INSERT INTO public.test_requests(organization_id,id,request_number,is_job,is_auto_created,job_sample_product_id,priority,due_at,datasheet_template_id,created_by)
    SELECT org,job_id,job_number,true,true,product_line,
      CASE WHEN bool_or(request.priority='urgent') THEN 'urgent' WHEN bool_or(request.priority='high') THEN 'high' ELSE min(request.priority) END,
      min(request.due_at),summary_template,actor FROM public.test_requests request WHERE request.organization_id=org AND request.id=ANY(member_ids);
  UPDATE public.test_requests request SET parent_test_request_id=job_id,job_member_position=member.ordinality-1,job_linked_by=actor,
    job_linked_at=now(),revision=request.revision+1 FROM unnest(member_ids) WITH ORDINALITY member(member_id,ordinality)
    WHERE request.organization_id=org AND request.id=member.member_id;
  INSERT INTO public.test_request_assignments(organization_id,test_request_id,assignment_type,assigned_user_id,assigned_by)
    SELECT org,member_id,'analyst',actor,actor FROM unnest(member_ids) member_id;
  UPDATE public.test_requests request SET status='allocated',revision=request.revision+1 WHERE request.organization_id=org AND request.id=ANY(member_ids);
  INSERT INTO public.sample_events(organization_id,sample_id,test_request_id,event_type,actor_user_id,description)
    SELECT org,selected_sample,member_id,'test_request_assigned',actor,'Test request analyst assigned during automatic job creation' FROM unnest(member_ids) member_id;
  RETURN QUERY SELECT job_id,job_number,cardinality(member_ids);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION laboratory_complete_job_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE member_count integer; last_position integer; first_position integer; selected_sample uuid;
  job public.test_requests; settings public.organization_laboratory_settings; analyst uuid; sample_state uuid; summary_template uuid;
BEGIN
  SELECT * INTO job FROM public.test_requests WHERE organization_id=NEW.organization_id AND id=NEW.id;
  SELECT * INTO settings FROM public.organization_laboratory_settings WHERE organization_id=NEW.organization_id FOR SHARE;
  SELECT sample_id INTO selected_sample FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.job_sample_product_id;
  SELECT resolved.template_id INTO summary_template FROM public.laboratory_product_job_templates(selected_sample,ARRAY[job.job_sample_product_id],job.is_auto_created) resolved;
  IF summary_template IS NULL OR job.datasheet_template_id IS DISTINCT FROM summary_template THEN
    RAISE EXCEPTION 'Jobs require the configured organization or product summary template' USING ERRCODE='23514';
  END IF;
  IF job.is_auto_created THEN
    IF NOT settings.auto_create_jobs OR NOT public.laboratory_job_generation_sample(selected_sample) OR job.status<>'created' OR job.revision<>1
      OR EXISTS (SELECT 1 FROM public.test_request_assignments WHERE organization_id=job.organization_id AND test_request_id=job.id)
      OR EXISTS (SELECT 1 FROM public.datasheets WHERE organization_id=job.organization_id AND test_request_id=job.id)
      OR EXISTS (SELECT 1 FROM public.workflow_runs WHERE organization_id=job.organization_id AND test_request_id=job.id)
    THEN RAISE EXCEPTION 'Automatic jobs stay unassigned until explicit allocation' USING ERRCODE='23514'; END IF;
    analyst:=job.created_by;
  ELSE
  -- Match workflowAllowedActions: a configured allocation capability applies
  -- to this actor; otherwise the allocator permission is the fallback.
  SELECT current_state_id INTO sample_state FROM public.workflow_runs WHERE organization_id=NEW.organization_id AND sample_id=selected_sample;
  IF EXISTS (SELECT 1 FROM public.workflow_state_capability_roles WHERE organization_id=NEW.organization_id AND workflow_state_id=sample_state AND capability='allocate')
    AND NOT EXISTS (SELECT 1 FROM public.workflow_state_capability_roles capability JOIN public.membership_roles role
      ON role.organization_id=capability.organization_id AND role.role_id=capability.role_id
      WHERE capability.organization_id=NEW.organization_id AND capability.workflow_state_id=sample_state AND capability.capability='allocate' AND role.user_id=NEW.created_by)
  THEN RAISE EXCEPTION 'The sample state does not allow this actor to create jobs' USING ERRCODE='42501'; END IF;
  SELECT assigned_user_id INTO analyst FROM public.test_request_assignments
    WHERE organization_id=NEW.organization_id AND test_request_id=NEW.id AND assignment_type='analyst' AND unassigned_at IS NULL
      AND assigned_by=NEW.created_by AND assigned_at=transaction_timestamp();
  IF job.status<>'allocated' OR analyst IS NULL OR NOT EXISTS (SELECT 1 FROM public.datasheets
    WHERE organization_id=NEW.organization_id AND test_request_id=NEW.id AND attempt_number=1 AND status='in_progress')
  THEN RAISE EXCEPTION 'A manual job requires its actual analyst and summary capture' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT count(*)::integer,min(job_member_position),max(job_member_position) INTO member_count,first_position,last_position
    FROM public.test_requests WHERE organization_id=NEW.organization_id AND parent_test_request_id=NEW.id;
  IF member_count=0 OR first_position<>0 OR last_position<>member_count-1 THEN
    RAISE EXCEPTION 'A job requires an ordered set of linked requests' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.test_requests member WHERE member.organization_id=NEW.organization_id AND member.parent_test_request_id=NEW.id
    AND ((job.is_auto_created AND NOT public.laboratory_new_generated_request(member.id)) OR member.status<>'allocated' OR NOT EXISTS (SELECT 1 FROM public.test_request_assignments assignment
      WHERE assignment.organization_id=member.organization_id AND assignment.test_request_id=member.id AND assignment.assignment_type='analyst'
        AND assignment.assigned_user_id=analyst AND assignment.unassigned_at IS NULL AND assignment.assigned_by=NEW.created_by AND assignment.assigned_at=transaction_timestamp())
      OR NOT EXISTS (SELECT 1 FROM public.datasheets sheet WHERE sheet.organization_id=member.organization_id AND sheet.test_request_id=member.id AND sheet.attempt_number=1 AND sheet.status='in_progress')))
  THEN RAISE EXCEPTION 'Job members require their actual analyst and individual captures' USING ERRCODE='23514'; END IF;
  IF job.is_auto_created AND EXISTS (SELECT 1 FROM public.test_requests member
    JOIN public.sample_tests selected ON selected.organization_id=member.organization_id AND selected.id=member.sample_test_id
    JOIN public.sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    JOIN public.sample_category_workflows mapping ON mapping.organization_id=product.organization_id AND mapping.sample_category_id=product.sample_category_id AND mapping.applies_to='test_request' AND mapping.is_default
    JOIN public.workflows workflow ON workflow.organization_id=mapping.organization_id AND workflow.id=mapping.workflow_id AND workflow.active
    JOIN public.workflow_versions version ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published'
    WHERE member.organization_id=job.organization_id AND member.parent_test_request_id=job.id
      AND NOT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_run_history history ON history.organization_id=run.organization_id AND history.workflow_run_id=run.id AND history.action='started'
        WHERE run.organization_id=member.organization_id AND run.test_request_id=member.id AND run.workflow_version_id=version.id
          AND run.started_by=job.created_by AND run.started_at=transaction_timestamp() AND history.actor_user_id=job.created_by AND history.occurred_at=transaction_timestamp()))
  THEN RAISE EXCEPTION 'Automatic children require their actual configured initial workflows' USING ERRCODE='23514'; END IF;
  INSERT INTO public.sample_events(organization_id,sample_id,test_request_id,event_type,actor_user_id,description)
    VALUES(NEW.organization_id,selected_sample,NEW.id,'test_request_job_created',NEW.created_by,
      format('%s job with %s test request%s.',CASE WHEN job.is_auto_created THEN 'Automatically created' ELSE 'Created' END,member_count,CASE WHEN member_count=1 THEN '' ELSE 's' END));
  RETURN NEW;
END $$;
