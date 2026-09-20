CREATE TABLE "sample_report_finalizations" (
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"previous_revision" integer NOT NULL,
	"completed_revision" integer NOT NULL,
	"finalized_by" uuid NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	"transaction_id" "xid8" NOT NULL,
	CONSTRAINT "report_finalization_pk" PRIMARY KEY("organization_id","event_id"),
	CONSTRAINT "report_finalization_sample_revision_key" UNIQUE("organization_id","sample_id","completed_revision"),
	CONSTRAINT "report_finalization_revision" CHECK ("sample_report_finalizations"."previous_revision" > 0 and "sample_report_finalizations"."completed_revision" = "sample_report_finalizations"."previous_revision" + 1)
);
--> statement-breakpoint
-- Finalisation and issue are distinct source actions. Existing drafts retain
-- their historical state; no earlier completion actor or time is inferred.
ALTER TABLE "sample_events" DROP CONSTRAINT "sample_event_type";--> statement-breakpoint
ALTER TABLE "sample_reports" ADD COLUMN "is_finalized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sample_report_finalizations" ADD CONSTRAINT "sample_report_finalizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_finalizations" ADD CONSTRAINT "report_finalization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."sample_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_finalizations" ADD CONSTRAINT "report_finalization_sample_fk" FOREIGN KEY ("organization_id","sample_id") REFERENCES "public"."samples"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_report_finalizations" ADD CONSTRAINT "report_finalization_actor_fk" FOREIGN KEY ("organization_id","finalized_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_events" ADD CONSTRAINT "sample_event_type" CHECK ("sample_events"."event_type" in ('sample_registered', 'test_requests_generated', 'test_request_assigned', 'datasheet_created', 'datasheet_submitted', 'reports_generated', 'reports_finalized', 'datasheet_method_added', 'datasheet_method_voided', 'test_request_job_created'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION report_guard_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sample public.samples; previous public.sample_reports; require_approved boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Generated report revisions are immutable' USING ERRCODE='55000'; END IF;
  IF session_user <> 'sampleify_app' THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
    OR NEW.generated_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
    OR NEW.generated_at IS DISTINCT FROM now() OR NEW.status <> 'draft'
    OR NOT public.app_has_permission('samples.manage') OR NOT public.report_can_print(NEW.sample_id) THEN
    RAISE EXCEPTION 'Report generation is not allowed' USING ERRCODE='42501';
  END IF;
  SELECT * INTO sample FROM public.samples WHERE organization_id=NEW.organization_id AND id=NEW.sample_id FOR NO KEY UPDATE;
  IF NOT FOUND OR sample.status='cancelled' OR
    (NEW.sample_revision, NEW.sample_number, NEW.sample_type, NEW.sample_category_name, NEW.customer_name, NEW.customer_address,
      NEW.customer_reference, NEW.received_at, NEW.registered_at, NEW.due_at, NEW.description) IS DISTINCT FROM
    (sample.revision, sample.sample_number, sample.sample_type, sample.category_name, sample.customer_name, sample.customer_address,
      sample.customer_reference, sample.received_at, sample.registered_at, sample.due_at, sample.description) THEN
    RAISE EXCEPTION 'Report sample snapshot does not match' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.template_versions WHERE organization_id=NEW.organization_id AND id=NEW.template_version_id AND kind='report' AND status='frozen')
    OR NOT EXISTS (SELECT 1 FROM public.sample_events event WHERE event.organization_id=NEW.organization_id AND event.id=NEW.generated_event_id
      AND event.sample_id=NEW.sample_id AND event.event_type=CASE WHEN NEW.is_finalized THEN 'reports_finalized' ELSE 'reports_generated' END AND event.actor_user_id=NEW.generated_by
      AND event.occurred_at=NEW.generated_at AND event.xmin::text=pg_current_xact_id()::text)
    OR NEW.sample_product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sample_products WHERE organization_id=NEW.organization_id AND id=NEW.sample_product_id AND sample_id=NEW.sample_id)
    OR NEW.sample_test_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sample_tests WHERE organization_id=NEW.organization_id AND id=NEW.sample_test_id AND sample_product_id=NEW.sample_product_id) THEN
    RAISE EXCEPTION 'Report provenance is invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO previous FROM public.sample_reports WHERE organization_id=NEW.organization_id AND sample_id=NEW.sample_id AND group_key=NEW.group_key ORDER BY revision DESC LIMIT 1;
  IF NEW.revision IS DISTINCT FROM coalesce(previous.revision, 0)+1 OR previous.id IS NOT NULL AND NEW.report_number IS DISTINCT FROM previous.report_number THEN
    RAISE EXCEPTION 'Report revision changed' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(bool_or(state.require_all_test_requests_approved), false) OR NOT EXISTS (
      SELECT 1 FROM public.workflow_runs run JOIN public.workflow_state_capability_roles capability
        ON capability.organization_id=run.organization_id AND capability.workflow_state_id=run.current_state_id AND capability.capability='download_report'
      WHERE run.organization_id=NEW.organization_id AND run.sample_id=NEW.sample_id)
    INTO require_approved FROM public.workflow_runs run JOIN public.workflow_states state ON state.organization_id=run.organization_id AND state.id=run.current_state_id
    WHERE run.organization_id=NEW.organization_id AND run.sample_id=NEW.sample_id;
  IF require_approved AND EXISTS (SELECT 1 FROM public.sample_products product JOIN public.sample_tests test ON test.organization_id=product.organization_id AND test.sample_product_id=product.id
    LEFT JOIN LATERAL (SELECT * FROM public.test_requests request WHERE request.organization_id=test.organization_id AND request.sample_test_id=test.id ORDER BY request.attempt_number DESC LIMIT 1) request ON true
    LEFT JOIN public.datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.id=request.final_datasheet_id
    WHERE product.organization_id=NEW.organization_id AND product.sample_id=NEW.sample_id AND test.status <> 'cancelled'
      AND (test.status <> 'completed' OR sheet.status IS DISTINCT FROM 'approved')) THEN
    RAISE EXCEPTION 'Approve all test requests before generating reports' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
ALTER TABLE sample_report_finalizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_report_finalizations FORCE ROW LEVEL SECURITY;
CREATE POLICY report_finalization_read ON sample_report_finalizations FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id', true), '')::uuid
  AND EXISTS (SELECT 1 FROM public.samples sample WHERE sample.organization_id=sample_report_finalizations.organization_id AND sample.id=sample_report_finalizations.sample_id)
);
GRANT SELECT ON sample_report_finalizations TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION report_guard_finalization() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Report finalisation evidence is immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER report_finalization_immutable BEFORE UPDATE OR DELETE ON sample_report_finalizations
  FOR EACH ROW EXECUTE FUNCTION report_guard_finalization();
--> statement-breakpoint
CREATE FUNCTION report_finalize_sample(p_event_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  event public.sample_events; sample public.samples; receipt public.sample_report_finalizations;
BEGIN
  IF NOT public.app_has_permission('samples.manage') OR org IS NULL OR actor IS NULL THEN
    RAISE EXCEPTION 'Sample management permission required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO event FROM public.sample_events WHERE organization_id=org AND id=p_event_id;
  IF NOT FOUND OR event.event_type<>'reports_finalized' OR event.actor_user_id<>actor OR NOT public.report_can_print(event.sample_id) THEN
    RAISE EXCEPTION 'Report finalisation is not allowed' USING ERRCODE='42501';
  END IF;
  SELECT * INTO sample FROM public.samples WHERE organization_id=org AND id=event.sample_id FOR NO KEY UPDATE;
  SELECT * INTO receipt FROM public.sample_report_finalizations WHERE organization_id=org AND event_id=p_event_id;
  IF FOUND THEN RETURN receipt.completed_revision; END IF;
  IF sample.status='cancelled' OR event.occurred_at IS DISTINCT FROM now()
    OR NOT EXISTS (SELECT 1 FROM public.sample_reports WHERE organization_id=org AND generated_event_id=p_event_id)
    OR EXISTS (SELECT 1 FROM public.sample_reports WHERE organization_id=org AND generated_event_id=p_event_id
      AND (NOT is_finalized OR sample_id<>sample.id OR sample_revision<>sample.revision OR generated_by<>actor OR generated_at<>now())) THEN
    RAISE EXCEPTION 'Finalisation requires the current generated reports' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.sample_report_finalizations(organization_id,event_id,sample_id,previous_revision,completed_revision,finalized_by,finalized_at,transaction_id)
    VALUES(org,p_event_id,sample.id,sample.revision,sample.revision+1,actor,now(),pg_current_xact_id());
  UPDATE public.samples SET status='completed',revision=samples.revision+1 WHERE organization_id=org AND id=sample.id;
  RETURN sample.revision+1;
END $$;
GRANT EXECUTE ON FUNCTION report_finalize_sample(uuid) TO sampleify_app;
--> statement-breakpoint
CREATE FUNCTION report_require_finalization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE finalization_event uuid; receipt public.sample_report_finalizations;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME='sample_reports' THEN
    IF NOT NEW.is_finalized THEN RETURN NULL; END IF;
    finalization_event := NEW.generated_event_id;
  ELSIF TG_TABLE_NAME='sample_events' THEN
    IF NEW.event_type<>'reports_finalized' THEN RETURN NULL; END IF;
    finalization_event := NEW.id;
  ELSE
    finalization_event := NEW.event_id;
  END IF;
  SELECT * INTO receipt FROM public.sample_report_finalizations WHERE organization_id=NEW.organization_id AND event_id=finalization_event;
  IF NOT FOUND OR receipt.transaction_id<>pg_current_xact_id() OR receipt.finalized_at<>now()
    OR receipt.finalized_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
    OR NOT EXISTS (SELECT 1 FROM public.samples WHERE organization_id=receipt.organization_id AND id=receipt.sample_id
      AND status='completed' AND revision=receipt.completed_revision)
    OR NOT EXISTS (SELECT 1 FROM public.sample_events WHERE organization_id=receipt.organization_id AND id=receipt.event_id
      AND sample_id=receipt.sample_id AND event_type='reports_finalized' AND actor_user_id=receipt.finalized_by AND occurred_at=receipt.finalized_at)
    OR NOT EXISTS (SELECT 1 FROM public.sample_reports WHERE organization_id=receipt.organization_id AND generated_event_id=receipt.event_id)
    OR EXISTS (SELECT 1 FROM public.sample_reports WHERE organization_id=receipt.organization_id AND generated_event_id=receipt.event_id
      AND (NOT is_finalized OR sample_id<>receipt.sample_id OR sample_revision<>receipt.previous_revision
        OR generated_by<>receipt.finalized_by OR generated_at<>receipt.finalized_at)) THEN
    RAISE EXCEPTION 'Finalised reports require matching sample completion evidence' USING ERRCODE='23514',CONSTRAINT='report_finalization_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_finalization_complete AFTER INSERT ON sample_report_finalizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_require_finalization();
CREATE CONSTRAINT TRIGGER report_finalization_report_complete AFTER INSERT ON sample_reports
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_require_finalization();
CREATE CONSTRAINT TRIGGER report_finalization_event_complete AFTER INSERT ON sample_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION report_require_finalization();
