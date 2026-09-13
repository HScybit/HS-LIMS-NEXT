CREATE TABLE "workflow_metadata_versions" (
	"organization_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"initial_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"applies_to" text NOT NULL,
	"active" boolean NOT NULL,
	"requested_code" text,
	"generated_code" boolean NOT NULL,
	"description_provided" boolean NOT NULL,
	"requested_applies_to" text,
	"requested_active" boolean,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "workflow_metadata_version_pk" PRIMARY KEY("organization_id","workflow_id","revision"),
	CONSTRAINT "workflow_metadata_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "workflow_metadata_history_revision" CHECK (("workflow_metadata_versions"."operation"='create' and "workflow_metadata_versions"."previous_revision" is null and "workflow_metadata_versions"."revision"=1 and "workflow_metadata_versions"."initial_version_id" is not null)
    or ("workflow_metadata_versions"."operation" in ('update','retire') and "workflow_metadata_versions"."previous_revision" is not null and "workflow_metadata_versions"."previous_revision">=0 and "workflow_metadata_versions"."revision"="workflow_metadata_versions"."previous_revision"+1 and "workflow_metadata_versions"."initial_version_id" is null)),
	CONSTRAINT "workflow_metadata_history_fields" CHECK (length(trim("workflow_metadata_versions"."code")) between 1 and 64 and length(trim("workflow_metadata_versions"."name")) between 1 and 200
    and "workflow_metadata_versions"."applies_to" in ('sample','test_request') and ("workflow_metadata_versions"."requested_applies_to" is null or "workflow_metadata_versions"."requested_applies_to" in ('sample','test_request'))
    and (not "workflow_metadata_versions"."generated_code" or ("workflow_metadata_versions"."operation"='create' and "workflow_metadata_versions"."requested_code" is not null))
    and ("workflow_metadata_versions"."operation"<>'retire' or (not "workflow_metadata_versions"."active" and not "workflow_metadata_versions"."description_provided" and not "workflow_metadata_versions"."generated_code"
      and num_nonnulls("workflow_metadata_versions"."requested_code","workflow_metadata_versions"."requested_applies_to","workflow_metadata_versions"."requested_active")=0)))
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "metadata_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_metadata_versions" ADD CONSTRAINT "workflow_metadata_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_metadata_versions" ADD CONSTRAINT "workflow_metadata_versions_organization_id_workflow_id_workflows_organization_id_id_fk" FOREIGN KEY ("organization_id","workflow_id") REFERENCES "public"."workflows"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_metadata_versions" ADD CONSTRAINT "workflow_metadata_versions_organization_id_initial_version_id_workflow_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","initial_version_id") REFERENCES "public"."workflow_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_metadata_versions" ADD CONSTRAINT "workflow_metadata_versions_organization_id_saved_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_created_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_updated_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","updated_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_active_name" ON "workflows" USING btree ("organization_id","name") WHERE "workflows"."active";--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflow_metadata_revision" CHECK ("workflows"."metadata_revision">=0);
--> statement-breakpoint
ALTER TABLE workflow_metadata_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_metadata_history_read ON workflow_metadata_versions FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT app_has_permission('workflows.read') OR app_has_permission('workflows.manage')));
REVOKE ALL ON workflow_metadata_versions FROM PUBLIC;
GRANT SELECT ON workflow_metadata_versions TO sampleify_app;
REVOKE INSERT,UPDATE,DELETE ON workflows FROM sampleify_app;
-- Existing draft commands SELECT ... FOR UPDATE. A guarded revision column is
-- enough for that lock, without restoring direct metadata edits.
GRANT UPDATE(metadata_revision) ON workflows TO sampleify_app;

CREATE FUNCTION workflow_metadata_require_actor() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
  org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sessions session
    JOIN public.users person ON person.id=session.user_id AND person.active AND NOT person.must_change_password
    JOIN public.credentials credential ON credential.user_id=person.id AND credential.revision=session.credential_revision
    JOIN public.memberships membership ON membership.organization_id=session.organization_id AND membership.user_id=person.id AND membership.active
    JOIN public.organizations organization ON organization.id=session.organization_id AND organization.active
    WHERE session.id=nullif(current_setting('app.session_id',true),'')::uuid AND session.user_id=actor AND session.organization_id=org
      AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
  ) OR NOT public.app_has_permission('workflows.manage') THEN
    RAISE EXCEPTION 'Active workflow management session required' USING ERRCODE='42501',CONSTRAINT='workflow_metadata_session_required';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION workflow_metadata_guard_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head public.workflows; initial public.workflow_versions;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Workflow metadata history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO head FROM public.workflows WHERE organization_id=NEW.organization_id AND id=NEW.workflow_id;
  IF NEW.saved_by IS DISTINCT FROM public.workflow_metadata_require_actor()
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.saved_at<>transaction_timestamp() OR NEW.created_transaction_id<>pg_current_xact_id()
    OR (NEW.revision,NEW.code,NEW.name,NEW.description,NEW.applies_to,NEW.active,NEW.saved_by,NEW.saved_at)
      IS DISTINCT FROM (head.metadata_revision,head.code,head.name,head.description,head.applies_to,head.active,head.updated_by,head.updated_at) THEN
    RAISE EXCEPTION 'Workflow history requires its current metadata, actual actor and transaction' USING ERRCODE='23514';
  END IF;
  IF NEW.operation='create' THEN
    SELECT * INTO initial FROM public.workflow_versions WHERE organization_id=NEW.organization_id AND id=NEW.initial_version_id;
    IF head.created_by IS DISTINCT FROM NEW.saved_by OR head.created_at<>NEW.saved_at
      OR initial.workflow_id IS DISTINCT FROM NEW.workflow_id OR initial.number<>1 OR initial.status<>'draft'
      OR initial.created_by IS DISTINCT FROM NEW.saved_by OR initial.created_at<>NEW.saved_at THEN
      RAISE EXCEPTION 'New workflow history requires its actual creation and initial draft' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION workflow_metadata_guard_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workflows are retired without deleting history' USING ERRCODE='55000'; END IF;
  IF (NEW.organization_id,NEW.id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_by,OLD.created_at)
    OR NEW.metadata_revision<>OLD.metadata_revision+1 OR NOT OLD.active THEN
    RAISE EXCEPTION 'Workflow metadata identity and revision are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION workflow_metadata_check_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head public.workflows; version public.workflow_metadata_versions;
BEGIN
  SELECT * INTO head FROM public.workflows WHERE organization_id=NEW.organization_id AND id=NEW.id;
  IF head.metadata_revision>0 THEN
    SELECT * INTO version FROM public.workflow_metadata_versions WHERE organization_id=head.organization_id AND workflow_id=head.id AND revision=head.metadata_revision;
    IF version.workflow_id IS NULL OR (head.metadata_revision,head.code,head.name,head.description,head.applies_to,head.active,head.updated_by,head.updated_at)
      IS DISTINCT FROM (version.revision,version.code,version.name,version.description,version.applies_to,version.active,version.saved_by,version.saved_at) THEN
      RAISE EXCEPTION 'Workflow metadata requires complete matching history' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER workflow_metadata_history_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_metadata_versions
  FOR EACH ROW EXECUTE FUNCTION workflow_metadata_guard_history();
CREATE TRIGGER workflow_metadata_head_guard BEFORE UPDATE OR DELETE ON workflows FOR EACH ROW EXECUTE FUNCTION workflow_metadata_guard_head();
CREATE CONSTRAINT TRIGGER workflow_metadata_head_complete AFTER INSERT OR UPDATE ON workflows DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION workflow_metadata_check_head();

-- Lock the selected active workflow before new references commit. The invoker
-- may have only sample/settings authority; child RLS and its existing guards
-- continue to authorize the actual operation.
CREATE FUNCTION workflow_guard_active_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid; initial_creation boolean:=false;
BEGIN
  IF session_user='sampleify_app' AND NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Workflow references require the current organization' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='organization_laboratory_settings' THEN target:=NEW.job_workflow_id;
  ELSIF TG_TABLE_NAME='workflow_runs' THEN
    SELECT workflow_id INTO target FROM public.workflow_versions WHERE organization_id=NEW.organization_id AND id=NEW.workflow_version_id;
  ELSE
    target:=NEW.workflow_id;
    IF TG_TABLE_NAME='workflow_versions' THEN initial_creation:=TG_OP='INSERT' AND NEW.number=1; END IF;
  END IF;
  IF target IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.workflows workflow WHERE workflow.organization_id=NEW.organization_id AND workflow.id=target
    AND (workflow.active OR (initial_creation AND workflow.metadata_revision=1 AND workflow.created_at=transaction_timestamp()
      AND workflow.created_by=nullif(current_setting('app.user_id',true),'')::uuid AND NOT EXISTS (
        SELECT 1 FROM public.workflow_metadata_versions history WHERE history.organization_id=workflow.organization_id AND history.workflow_id=workflow.id))) FOR SHARE OF workflow;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an active workflow' USING ERRCODE='23514',CONSTRAINT='workflow_active_reference'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_category_active_reference BEFORE INSERT OR UPDATE OF workflow_id ON sample_category_workflows
  FOR EACH ROW EXECUTE FUNCTION workflow_guard_active_reference();
CREATE TRIGGER workflow_settings_active_reference BEFORE INSERT OR UPDATE OF job_workflow_id ON organization_laboratory_settings
  FOR EACH ROW EXECUTE FUNCTION workflow_guard_active_reference();
CREATE TRIGGER workflow_version_active_reference BEFORE INSERT ON workflow_versions FOR EACH ROW EXECUTE FUNCTION workflow_guard_active_reference();
CREATE TRIGGER workflow_publish_active_reference BEFORE UPDATE OF status ON workflow_versions FOR EACH ROW
  WHEN (NEW.status='published') EXECUTE FUNCTION workflow_guard_active_reference();
CREATE TRIGGER workflow_run_active_reference BEFORE INSERT ON workflow_runs FOR EACH ROW EXECUTE FUNCTION workflow_guard_active_reference();

CREATE FUNCTION workflows_metadata_write(operation text,target uuid,expected_revision integer,requested_id uuid,requested_name text,
  requested_description text,description_provided boolean,requested_code text,generate_code boolean,requested_type text,requested_active boolean)
RETURNS TABLE(metadata_revision integer,initial_version_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; head public.workflows;
  prior public.workflow_metadata_versions; next_revision integer; next_code text; next_name text; next_description text; next_type text; next_active boolean;
  created_version uuid; suffix integer:=2; used boolean;
BEGIN
  actor:=public.workflow_metadata_require_actor();
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  actor:=public.workflow_metadata_require_actor();
  IF operation IS NULL OR operation NOT IN ('create','update','retire') OR target IS NULL OR requested_id IS NULL
    OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR (operation='create' AND expected_revision<>0)
    OR description_provided IS NULL OR generate_code IS NULL OR (generate_code AND operation<>'create')
    OR (NOT description_provided AND requested_description IS NOT NULL) OR (description_provided AND requested_description IS NULL)
    OR length(requested_description)>10000
    OR (requested_code IS NOT NULL AND (length(trim(requested_code)) NOT BETWEEN 1 AND 64 OR requested_code<>trim(requested_code)))
    OR (requested_type IS NOT NULL AND requested_type NOT IN ('sample','test_request'))
    OR (operation='create' AND (requested_code IS NULL OR requested_type IS NULL))
    OR (operation='retire' AND (num_nonnulls(requested_name,requested_description,requested_code,requested_type,requested_active)<>0 OR description_provided OR generate_code))
    OR (operation<>'retire' AND (requested_name IS NULL OR length(trim(requested_name)) NOT BETWEEN 1 AND 200 OR requested_name<>trim(requested_name))) THEN
    RAISE EXCEPTION 'Invalid workflow metadata command' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_input';
  END IF;
  SELECT * INTO prior FROM public.workflow_metadata_versions history WHERE history.organization_id=org AND history.request_id=requested_id;
  IF FOUND THEN
    IF prior.workflow_id<>target OR prior.operation<>operation OR coalesce(prior.previous_revision,0)<>expected_revision OR prior.saved_by<>actor
      OR prior.description_provided<>description_provided OR prior.generated_code<>generate_code
      OR prior.requested_code IS DISTINCT FROM requested_code OR prior.requested_applies_to IS DISTINCT FROM requested_type
      OR prior.requested_active IS DISTINCT FROM requested_active OR (operation<>'retire' AND prior.name IS DISTINCT FROM requested_name)
      OR (description_provided AND prior.description IS DISTINCT FROM requested_description) THEN
      RAISE EXCEPTION 'Workflow request was already used for a different change' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_request_reused';
    END IF;
    RETURN QUERY SELECT prior.revision,prior.initial_version_id; RETURN;
  END IF;
  SELECT * INTO head FROM public.workflows WHERE organization_id=org AND id=target FOR UPDATE;
  IF operation='create' AND FOUND THEN RAISE EXCEPTION 'Workflow already exists' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_identity_exists'; END IF;
  IF operation<>'create' AND (head.id IS NULL OR NOT head.active) THEN
    RAISE EXCEPTION 'Workflow was not found' USING ERRCODE='P0002',CONSTRAINT='workflow_metadata_not_found';
  END IF;
  IF operation<>'create' AND head.metadata_revision<>expected_revision THEN
    RAISE EXCEPTION 'Workflow details changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_stale';
  END IF;
  next_name:=CASE WHEN operation='retire' THEN head.name ELSE requested_name END;
  next_description:=CASE WHEN description_provided THEN requested_description ELSE coalesce(head.description,'') END;
  next_code:=coalesce(requested_code,head.code); next_type:=coalesce(requested_type,head.applies_to);
  next_active:=CASE WHEN operation='retire' THEN false ELSE coalesce(requested_active,head.active,true) END;
  IF next_active AND (operation='create' OR next_name IS DISTINCT FROM head.name) AND EXISTS (
    SELECT 1 FROM public.workflows WHERE organization_id=org AND id<>target AND active AND name=next_name
  ) THEN RAISE EXCEPTION 'A workflow with this name already exists' USING ERRCODE='23514',CONSTRAINT='workflow_name_exists'; END IF;
  IF generate_code THEN
    WHILE EXISTS (SELECT 1 FROM public.workflows WHERE organization_id=org AND lower(code)=lower(next_code)) LOOP
      next_code:=left(requested_code,60-length(suffix::text))||'-'||suffix::text; suffix:=suffix+1;
    END LOOP;
  END IF;
  IF operation<>'create' AND (NOT next_active OR next_type IS DISTINCT FROM head.applies_to) THEN
    SELECT EXISTS (SELECT 1 FROM public.workflow_runs run JOIN public.workflow_versions version
      ON version.organization_id=run.organization_id AND version.id=run.workflow_version_id WHERE version.organization_id=org AND version.workflow_id=target)
      OR EXISTS (SELECT 1 FROM public.sample_category_workflows WHERE organization_id=org AND workflow_id=target)
      OR EXISTS (SELECT 1 FROM public.organization_laboratory_settings WHERE organization_id=org AND job_workflow_id=target) INTO used;
    IF used THEN
      IF NOT next_active THEN RAISE EXCEPTION 'Workflow is currently used' USING ERRCODE='23514',CONSTRAINT='workflow_metadata_in_use';
      ELSE RAISE EXCEPTION 'Used workflow entity type is immutable' USING ERRCODE='23514',CONSTRAINT='workflow_type_in_use'; END IF;
    END IF;
  END IF;
  next_revision:=expected_revision+1;
  IF operation='create' THEN
    INSERT INTO public.workflows(organization_id,id,code,name,description,applies_to,active,metadata_revision,created_by,updated_by,updated_at)
      VALUES(org,target,next_code,next_name,next_description,next_type,next_active,next_revision,actor,actor,transaction_timestamp());
    created_version:=gen_random_uuid();
    INSERT INTO public.workflow_versions(organization_id,id,workflow_id,number,created_by,change_summary)
      VALUES(org,created_version,target,1,actor,'Initial draft');
  ELSE
    UPDATE public.workflows SET code=next_code,name=next_name,description=next_description,applies_to=next_type,active=next_active,
      metadata_revision=next_revision,updated_by=actor,updated_at=transaction_timestamp() WHERE organization_id=org AND id=target;
  END IF;
  INSERT INTO public.workflow_metadata_versions(organization_id,workflow_id,revision,request_id,previous_revision,operation,initial_version_id,
    code,name,description,applies_to,active,requested_code,generated_code,description_provided,requested_applies_to,requested_active,saved_by)
    VALUES(org,target,next_revision,requested_id,CASE WHEN operation='create' THEN NULL ELSE expected_revision END,operation,created_version,
      next_code,next_name,next_description,next_type,next_active,requested_code,generate_code,description_provided,requested_type,requested_active,actor);
  RETURN QUERY SELECT next_revision,created_version;
END $$;

REVOKE ALL ON FUNCTION workflow_metadata_require_actor(),workflow_metadata_guard_history(),workflow_metadata_guard_head(),workflow_metadata_check_head(),
  workflow_guard_active_reference(),workflows_metadata_write(text,uuid,integer,uuid,text,text,boolean,text,boolean,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflows_metadata_write(text,uuid,integer,uuid,text,text,boolean,text,boolean,text,boolean) TO sampleify_app;
