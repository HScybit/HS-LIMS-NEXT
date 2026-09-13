CREATE TABLE "checklist_items" (
	"organization_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "checklist_item_pk" PRIMARY KEY("organization_id","checklist_id","id"),
	CONSTRAINT "checklist_item_order" UNIQUE("organization_id","checklist_id","display_order"),
	CONSTRAINT "checklist_item_position" CHECK ("checklist_items"."display_order">=0)
);
--> statement-breakpoint
CREATE TABLE "checklist_version_items" (
	"organization_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "checklist_version_item_pk" PRIMARY KEY("organization_id","checklist_id","revision","id"),
	CONSTRAINT "checklist_version_item_order" UNIQUE("organization_id","checklist_id","revision","display_order"),
	CONSTRAINT "checklist_version_item_position" CHECK ("checklist_version_items"."display_order">=0)
);
--> statement-breakpoint
CREATE TABLE "checklist_versions" (
	"organization_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"previous_revision" integer,
	"operation" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean NOT NULL,
	"retired_at" timestamp with time zone,
	"item_count" integer NOT NULL,
	"name_provided" boolean NOT NULL,
	"active_provided" boolean NOT NULL,
	"items_provided" boolean NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "checklist_version_pk" PRIMARY KEY("organization_id","checklist_id","revision"),
	CONSTRAINT "checklist_save_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "checklist_version_revision" CHECK (("checklist_versions"."operation"='create' and "checklist_versions"."previous_revision" is null and "checklist_versions"."revision"=1)
    or ("checklist_versions"."operation" in ('update','retire') and "checklist_versions"."previous_revision" is not null and "checklist_versions"."previous_revision">=0 and "checklist_versions"."revision"="checklist_versions"."previous_revision"+1)),
	CONSTRAINT "checklist_version_fields" CHECK ("checklist_versions"."item_count">=0 and (("checklist_versions"."operation"='retire')=("checklist_versions"."retired_at" is not null))
    and ("checklist_versions"."operation"<>'retire' or not ("checklist_versions"."name_provided" or "checklist_versions"."active_provided" or "checklist_versions"."items_provided")))
);
--> statement-breakpoint
CREATE TABLE "checklists" (
	"organization_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "checklist_tenant_key" UNIQUE("organization_id","id"),
	CONSTRAINT "checklist_revision" CHECK ("checklists"."revision">=0)
);
--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_item_master_fk" FOREIGN KEY ("organization_id","checklist_id") REFERENCES "public"."checklists"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_version_items" ADD CONSTRAINT "checklist_version_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_version_items" ADD CONSTRAINT "checklist_version_item_parent_fk" FOREIGN KEY ("organization_id","checklist_id","revision") REFERENCES "public"."checklist_versions"("organization_id","checklist_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_versions" ADD CONSTRAINT "checklist_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_versions" ADD CONSTRAINT "checklist_version_master_fk" FOREIGN KEY ("organization_id","checklist_id") REFERENCES "public"."checklists"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_versions" ADD CONSTRAINT "checklist_version_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklist_creator_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklist_editor_fk" FOREIGN KEY ("organization_id","updated_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_version_time" ON "checklist_versions" USING btree ("organization_id","saved_at");--> statement-breakpoint
CREATE INDEX "checklist_name_lookup" ON "checklists" USING btree ("organization_id","name") WHERE "checklists"."retired_at" is null;
--> statement-breakpoint
INSERT INTO permissions(code,description) VALUES ('checklists.read','View checklists'),('checklists.manage','Manage checklists') ON CONFLICT DO NOTHING;
REVOKE ALL ON checklists,checklist_items,checklist_versions,checklist_version_items FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON checklists,checklist_items,checklist_versions,checklist_version_items TO sampleify_app;

CREATE FUNCTION checklists_require_actor() RETURNS uuid
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
  ) OR NOT public.app_has_permission('checklists.manage') THEN
    RAISE EXCEPTION 'Active checklist management session required' USING ERRCODE='42501',CONSTRAINT='checklist_session_required';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION checklists_guard_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE version public.checklist_versions; head public.checklists;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Checklist history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='checklist_versions' THEN
    SELECT * INTO head FROM public.checklists WHERE organization_id=NEW.organization_id AND id=NEW.checklist_id;
    IF NEW.saved_by IS DISTINCT FROM public.checklists_require_actor()
      OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
      OR NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
      OR (NEW.revision,NEW.name,NEW.is_active,NEW.retired_at,NEW.saved_by,NEW.saved_at)
        IS DISTINCT FROM (head.revision,head.name,head.is_active,head.retired_at,head.updated_by,head.updated_at)
      OR (NEW.operation='create' AND (head.created_by,head.created_at) IS DISTINCT FROM (NEW.saved_by,NEW.saved_at))
      OR (NEW.operation='retire' AND NEW.retired_at IS DISTINCT FROM NEW.saved_at) THEN
      RAISE EXCEPTION 'Checklist history requires the actual current head, editor and transaction' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO version FROM public.checklist_versions WHERE organization_id=NEW.organization_id AND checklist_id=NEW.checklist_id AND revision=NEW.revision;
    IF version.checklist_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR version.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
      RAISE EXCEPTION 'Checklist items require their actual version transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION checklists_assert_version(org uuid,target uuid,target_revision integer,check_head boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.checklist_versions; head public.checklists;
BEGIN
  SELECT * INTO version FROM public.checklist_versions WHERE organization_id=org AND checklist_id=target AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Checklist version is missing' USING ERRCODE='23514'; END IF;
  IF version.item_count<>(SELECT count(*) FROM public.checklist_version_items WHERE organization_id=org AND checklist_id=target AND revision=target_revision) THEN
    RAISE EXCEPTION 'Checklist history requires all its ordered items' USING ERRCODE='23514';
  END IF;
  IF check_head THEN
    SELECT * INTO head FROM public.checklists WHERE organization_id=org AND id=target;
    IF (head.revision,head.name,head.is_active,head.retired_at,head.updated_by,head.updated_at)
      IS DISTINCT FROM (version.revision,version.name,version.is_active,version.retired_at,version.saved_by,version.saved_at)
      OR EXISTS (
        (SELECT id,prompt,display_order FROM public.checklist_items WHERE organization_id=org AND checklist_id=target
          EXCEPT ALL SELECT id,prompt,display_order FROM public.checklist_version_items WHERE organization_id=org AND checklist_id=target AND revision=target_revision)
        UNION ALL
        (SELECT id,prompt,display_order FROM public.checklist_version_items WHERE organization_id=org AND checklist_id=target AND revision=target_revision
          EXCEPT ALL SELECT id,prompt,display_order FROM public.checklist_items WHERE organization_id=org AND checklist_id=target)
      ) THEN
      RAISE EXCEPTION 'Current checklist must match its complete saved version' USING ERRCODE='23514';
    END IF;
  END IF;
END $$;

CREATE FUNCTION checklists_check_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head public.checklists; org uuid; target uuid;
BEGIN
  org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF TG_TABLE_NAME='checklists' THEN target:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE target:=NEW.checklist_id; END IF;
  SELECT * INTO head FROM public.checklists WHERE organization_id=org AND id=target;
  IF TG_TABLE_NAME='checklist_versions' THEN
    PERFORM public.checklists_assert_version(org,target,NEW.revision,head.revision=NEW.revision);
  ELSIF head.revision>0 THEN
    PERFORM public.checklists_assert_version(org,target,head.revision,true);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION checklists_guard_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.revision>0 THEN RAISE EXCEPTION 'Saved checklists cannot be deleted' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.organization_id,NEW.id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_by,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'Checklist identity, creation evidence and sequential revision are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION checklists_guard_items() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE head public.checklists; version public.checklist_versions; org uuid; target uuid;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Replace checklist items through a saved revision' USING ERRCODE='23514'; END IF;
  org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.checklist_id ELSE NEW.checklist_id END;
  SELECT * INTO head FROM public.checklists WHERE organization_id=org AND id=target;
  IF head.revision>0 THEN
    SELECT * INTO version FROM public.checklist_versions WHERE organization_id=org AND checklist_id=target AND revision=head.revision;
    IF version.checklist_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
      OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
      OR org IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
      RAISE EXCEPTION 'Checklist items require their current saved revision transaction' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['checklists','checklist_items','checklist_versions','checklist_version_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY checklist_read ON %I FOR SELECT TO sampleify_app USING
      (organization_id=nullif(current_setting(''app.organization_id'',true),'''')::uuid
        AND (SELECT app_has_permission(''checklists.read'') OR app_has_permission(''checklists.manage'')))',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['checklist_versions','checklist_version_items'] LOOP
    EXECUTE format('CREATE TRIGGER checklist_history_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION checklists_guard_history()',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['checklists','checklist_versions'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER checklist_complete AFTER INSERT OR UPDATE OR DELETE ON %I
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION checklists_check_complete()',relation);
  END LOOP;
END $$;
CREATE TRIGGER checklist_head_guard BEFORE UPDATE OR DELETE ON checklists FOR EACH ROW EXECUTE FUNCTION checklists_guard_head();
CREATE TRIGGER checklist_current_items_guard BEFORE INSERT OR UPDATE OR DELETE ON checklist_items FOR EACH ROW EXECUTE FUNCTION checklists_guard_items();

CREATE FUNCTION checklists_write(operation text,target uuid,expected_revision integer,requested_id uuid,requested_name text,
  requested_active boolean,requested_item_ids uuid[],requested_prompts text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid; org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
  head public.checklists; prior public.checklist_versions; next_revision integer;
  next_name text; next_active boolean; next_retired_at timestamptz; next_item_ids uuid[]; next_prompts text[]; next_orders integer[];
BEGIN
  actor:=public.checklists_require_actor();
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  actor:=public.checklists_require_actor();
  IF operation IS NULL OR operation NOT IN ('create','update','retire') OR target IS NULL OR requested_id IS NULL
    OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646
    OR (operation='create' AND (expected_revision<>0 OR requested_name IS NULL OR requested_item_ids IS NULL))
    OR (operation='retire' AND num_nonnulls(requested_name,requested_active,requested_item_ids,requested_prompts)<>0)
    OR (requested_name IS NOT NULL AND (length(trim(requested_name)) NOT BETWEEN 1 AND 200 OR requested_name<>trim(requested_name)))
    OR ((requested_item_ids IS NULL)<>(requested_prompts IS NULL))
    OR (requested_item_ids IS NOT NULL AND (coalesce(array_ndims(requested_item_ids),1)<>1 OR array_lower(requested_item_ids,1)<>1
      OR cardinality(requested_item_ids) NOT BETWEEN 1 AND 200 OR cardinality(requested_item_ids)<>(SELECT count(DISTINCT item) FROM unnest(requested_item_ids) item)
      OR coalesce(array_ndims(requested_prompts),1)<>1 OR array_lower(requested_prompts,1)<>1
      OR cardinality(requested_prompts)<>cardinality(requested_item_ids)
      OR cardinality(requested_prompts)<>(SELECT count(DISTINCT item) FROM unnest(requested_prompts) item)
      OR EXISTS (SELECT 1 FROM unnest(requested_prompts) item WHERE item IS NULL OR length(trim(item)) NOT BETWEEN 1 AND 500 OR item<>trim(item)))) THEN
    RAISE EXCEPTION 'Invalid checklist command' USING ERRCODE='23514',CONSTRAINT='checklist_invalid_input';
  END IF;
  SELECT * INTO prior FROM public.checklist_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF prior.checklist_id<>target OR prior.operation<>operation OR coalesce(prior.previous_revision,0)<>expected_revision OR prior.saved_by<>actor
      OR prior.name_provided<>(requested_name IS NOT NULL) OR prior.active_provided<>(requested_active IS NOT NULL) OR prior.items_provided<>(requested_item_ids IS NOT NULL)
      OR (requested_name IS NOT NULL AND prior.name IS DISTINCT FROM requested_name)
      OR (requested_active IS NOT NULL AND prior.is_active IS DISTINCT FROM requested_active)
      OR (requested_item_ids IS NOT NULL AND (requested_item_ids IS DISTINCT FROM ARRAY(SELECT id FROM public.checklist_version_items
        WHERE organization_id=org AND checklist_id=target AND revision=prior.revision ORDER BY display_order)
        OR requested_prompts IS DISTINCT FROM ARRAY(SELECT prompt FROM public.checklist_version_items
          WHERE organization_id=org AND checklist_id=target AND revision=prior.revision ORDER BY display_order))) THEN
      RAISE EXCEPTION 'Checklist request was used for a different change' USING ERRCODE='23514',CONSTRAINT='checklist_request_reused';
    END IF;
    RETURN prior.revision;
  END IF;
  SELECT * INTO head FROM public.checklists WHERE organization_id=org AND id=target FOR UPDATE;
  IF operation='create' AND FOUND THEN RAISE EXCEPTION 'Checklist already exists' USING ERRCODE='23514',CONSTRAINT='checklist_identifier_exists'; END IF;
  IF operation<>'create' AND (head.id IS NULL OR head.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Checklist was not found' USING ERRCODE='P0002',CONSTRAINT='checklist_not_found';
  END IF;
  IF operation<>'create' AND head.revision<>expected_revision THEN
    RAISE EXCEPTION 'Checklist changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='checklist_stale';
  END IF;
  next_name:=coalesce(requested_name,head.name); next_active:=coalesce(requested_active,head.is_active,true);
  IF operation<>'retire' AND (operation='create' OR next_name IS DISTINCT FROM head.name)
    AND EXISTS (SELECT 1 FROM public.checklists WHERE organization_id=org AND id<>target AND retired_at IS NULL AND name=next_name) THEN
    RAISE EXCEPTION 'Checklist name already exists' USING ERRCODE='23514',CONSTRAINT='checklist_name_conflict';
  END IF;
  IF head.revision>0 THEN PERFORM public.checklists_assert_version(org,target,head.revision,true); END IF;
  next_revision:=expected_revision+1;
  next_retired_at:=CASE WHEN operation='retire' THEN transaction_timestamp() ELSE NULL END;
  IF requested_item_ids IS NULL THEN
    SELECT coalesce(array_agg(id ORDER BY display_order),'{}'::uuid[]),coalesce(array_agg(prompt ORDER BY display_order),'{}'::text[]),
      coalesce(array_agg(display_order ORDER BY display_order),'{}'::integer[]) INTO next_item_ids,next_prompts,next_orders
      FROM public.checklist_items WHERE organization_id=org AND checklist_id=target;
  ELSE
    next_item_ids:=requested_item_ids; next_prompts:=requested_prompts;
    next_orders:=ARRAY(SELECT generate_series(0,cardinality(next_item_ids)-1));
  END IF;
  IF operation='create' THEN
    INSERT INTO public.checklists(organization_id,id,name,is_active,revision,created_by,created_at,updated_by,updated_at)
      VALUES(org,target,next_name,next_active,next_revision,actor,transaction_timestamp(),actor,transaction_timestamp());
  ELSE
    UPDATE public.checklists SET name=next_name,is_active=next_active,revision=next_revision,updated_by=actor,updated_at=transaction_timestamp(),retired_at=next_retired_at
      WHERE organization_id=org AND id=target;
  END IF;
  INSERT INTO public.checklist_versions(organization_id,checklist_id,revision,request_id,previous_revision,operation,name,is_active,retired_at,item_count,
    name_provided,active_provided,items_provided,saved_by)
    VALUES(org,target,next_revision,requested_id,CASE WHEN operation='create' THEN NULL ELSE expected_revision END,operation,next_name,next_active,next_retired_at,
      cardinality(next_item_ids),requested_name IS NOT NULL,requested_active IS NOT NULL,requested_item_ids IS NOT NULL,actor);
  INSERT INTO public.checklist_version_items(organization_id,checklist_id,revision,id,prompt,display_order)
    SELECT org,target,next_revision,item.id,item.prompt,item.position FROM unnest(next_item_ids,next_prompts,next_orders) item(id,prompt,position);
  DELETE FROM public.checklist_items WHERE organization_id=org AND checklist_id=target;
  INSERT INTO public.checklist_items(organization_id,checklist_id,id,prompt,display_order)
    SELECT org,target,item.id,item.prompt,item.position FROM unnest(next_item_ids,next_prompts,next_orders) item(id,prompt,position);
  RETURN next_revision;
END $$;

REVOKE ALL ON FUNCTION checklists_require_actor(),checklists_guard_history(),checklists_assert_version(uuid,uuid,integer,boolean),checklists_check_complete(),
  checklists_guard_head(),checklists_guard_items(),checklists_write(text,uuid,integer,uuid,text,boolean,uuid[],text[]) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION checklists_write(text,uuid,integer,uuid,text,boolean,uuid[],text[]) TO sampleify_app;
