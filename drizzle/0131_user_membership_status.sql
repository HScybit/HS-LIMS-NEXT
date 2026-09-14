CREATE TABLE "user_status_versions" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"active" boolean NOT NULL,
	"previous_active" boolean NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_by_username" text NOT NULL,
	"saved_by_name" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "user_status_version_pk" PRIMARY KEY("organization_id","user_id","revision"),
	CONSTRAINT "user_status_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "user_status_transition" CHECK ("user_status_versions"."previous_revision">=0 and "user_status_versions"."revision"="user_status_versions"."previous_revision"+1 and "user_status_versions"."active"<>"user_status_versions"."previous_active"),
	CONSTRAINT "user_status_labels" CHECK (length(trim("user_status_versions"."username")) between 1 and 100 and length(trim("user_status_versions"."display_name")) between 1 and 200
    and length(trim("user_status_versions"."saved_by_username")) between 1 and 100 and length(trim("user_status_versions"."saved_by_name")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "status_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_status_versions" ADD CONSTRAINT "user_status_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_status_versions" ADD CONSTRAINT "user_status_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_status_versions" ADD CONSTRAINT "user_status_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "membership_status_revision" CHECK ("memberships"."status_revision">=0);
--> statement-breakpoint
CREATE FUNCTION users_guard_membership_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status_revision<>0 THEN RAISE EXCEPTION 'New memberships have no invented status history' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.organization_id,NEW.user_id) IS DISTINCT FROM (OLD.organization_id,OLD.user_id) THEN
    RAISE EXCEPTION 'Membership identity cannot change' USING ERRCODE='55000';
  END IF;
  IF (NEW.active,NEW.status_revision) IS NOT DISTINCT FROM (OLD.active,OLD.status_revision) THEN RETURN NEW; END IF;
  -- Owner-only unrecorded observations remain importable. Restricted roles have no direct membership writes.
  IF OLD.status_revision=0 AND NEW.status_revision=0 THEN RETURN NEW; END IF;
  IF OLD.status_revision=2147483647 OR NEW.status_revision<>OLD.status_revision+1 OR NEW.active=OLD.active THEN
    RAISE EXCEPTION 'A recorded status change requires its next revision' USING ERRCODE='23514';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR (public.users_require_manager()=NEW.user_id AND NOT NEW.active) THEN
    RAISE EXCEPTION 'Cannot disable yourself or change another organization' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_status_guard BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION users_guard_membership_status();

CREATE FUNCTION users_guard_status_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Membership status history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.saved_by IS DISTINCT FROM public.users_require_manager()
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.saved_at<>transaction_timestamp() OR NEW.created_transaction_id<>pg_current_xact_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
      JOIN public.users editor ON editor.id=NEW.saved_by
      WHERE membership.organization_id=NEW.organization_id AND membership.user_id=NEW.user_id
        AND membership.status_revision=NEW.revision AND membership.active=NEW.active
        AND (NEW.username,NEW.display_name,NEW.saved_by_username,NEW.saved_by_name)
          IS NOT DISTINCT FROM (person.username,person.display_name,editor.username,editor.display_name)
    ) THEN RAISE EXCEPTION 'Status history requires the actual membership change and editor' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_status_history_guard BEFORE INSERT OR UPDATE OR DELETE ON user_status_versions FOR EACH ROW EXECUTE FUNCTION users_guard_status_history();

CREATE FUNCTION users_require_status_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.status_revision>0 AND NEW.status_revision IS DISTINCT FROM OLD.status_revision AND NOT EXISTS (
    SELECT 1 FROM public.user_status_versions version WHERE version.organization_id=NEW.organization_id AND version.user_id=NEW.user_id
      AND version.revision=NEW.status_revision AND version.previous_revision=OLD.status_revision
      AND version.active=NEW.active AND version.previous_active=OLD.active AND version.created_transaction_id=pg_current_xact_id()
  ) THEN RAISE EXCEPTION 'Membership status requires its actual immutable transition' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER membership_status_history_required AFTER UPDATE ON memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION users_require_status_history();

ALTER TABLE user_status_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_status_versions FROM PUBLIC,sampleify_app,sampleify_report_worker;
REVOKE ALL ON FUNCTION users_guard_membership_status(),users_guard_status_history(),users_require_status_history() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION users_write_status(target uuid,expected_revision integer,requested_id uuid,requested_active boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid;
  head public.memberships; prior public.user_status_versions; protected_permission text;
BEGIN
  actor:=public.users_require_manager();
  IF target IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR requested_id IS NULL OR requested_active IS NULL THEN
    RAISE EXCEPTION 'Invalid membership status change' USING ERRCODE='23514',CONSTRAINT='user_status_invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=target) THEN
    RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found';
  END IF;
  PERFORM 1 FROM public.users WHERE id=ANY(ARRAY[actor,target]) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=ANY(ARRAY[actor,target]) ORDER BY user_id FOR UPDATE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  SELECT * INTO prior FROM public.user_status_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF (prior.user_id,prior.saved_by,prior.previous_revision,prior.active) IS DISTINCT FROM (target,actor,expected_revision,requested_active) THEN
      RAISE EXCEPTION 'Save request already used for another status change' USING ERRCODE='23514',CONSTRAINT='user_status_request_reused';
    END IF;
    RETURN prior.revision;
  END IF;
  SELECT * INTO head FROM public.memberships WHERE organization_id=org AND user_id=target;
  IF NOT FOUND THEN RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found'; END IF;
  IF target=actor AND NOT requested_active THEN
    RAISE EXCEPTION 'You cannot disable your own account' USING ERRCODE='23514',CONSTRAINT='user_status_cannot_disable_self';
  END IF;
  IF head.status_revision<>expected_revision THEN
    RAISE EXCEPTION 'Status changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='user_status_stale';
  END IF;
  IF head.active=requested_active THEN
    RAISE EXCEPTION 'Membership already has that status' USING ERRCODE='23514',CONSTRAINT='user_status_unchanged';
  END IF;
  IF NOT requested_active THEN
    FOREACH protected_permission IN ARRAY ARRAY['roles.manage','users.manage'] LOOP
      IF EXISTS (
        SELECT 1 FROM public.membership_roles assignment JOIN public.roles role ON role.organization_id=assignment.organization_id AND role.id=assignment.role_id AND role.active
        JOIN public.role_permissions permission ON permission.organization_id=role.organization_id AND permission.role_id=role.id AND permission.permission_code=protected_permission
        JOIN public.users person ON person.id=assignment.user_id AND person.active
        WHERE assignment.organization_id=org AND assignment.user_id=target
      ) AND NOT EXISTS (
        SELECT 1 FROM public.membership_roles assignment JOIN public.roles role ON role.organization_id=assignment.organization_id AND role.id=assignment.role_id AND role.active
        JOIN public.role_permissions permission ON permission.organization_id=role.organization_id AND permission.role_id=role.id AND permission.permission_code=protected_permission
        JOIN public.memberships membership ON membership.organization_id=assignment.organization_id AND membership.user_id=assignment.user_id AND membership.active
        JOIN public.users person ON person.id=membership.user_id AND person.active
        WHERE assignment.organization_id=org AND assignment.user_id<>target
      ) THEN RAISE EXCEPTION 'The last active administrator must be retained' USING ERRCODE='23514',CONSTRAINT='user_profile_last_administrator'; END IF;
    END LOOP;
  END IF;
  UPDATE public.memberships SET active=requested_active,status_revision=expected_revision+1 WHERE organization_id=org AND user_id=target;
  IF NOT requested_active THEN
    UPDATE public.sessions SET revoked_at=now() WHERE organization_id=org AND user_id=target AND revoked_at IS NULL;
  END IF;
  -- The insert revalidates the actual actor even if revocation waited for a target session lock.
  INSERT INTO public.user_status_versions(organization_id,user_id,revision,previous_revision,request_id,active,previous_active,
    username,display_name,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,expected_revision+1,expected_revision,requested_id,requested_active,head.active,
      person.username,person.display_name,actor,editor.username,editor.display_name
    FROM public.users person JOIN public.users editor ON editor.id=actor WHERE person.id=target;
  RETURN expected_revision+1;
END $$;
REVOKE ALL ON FUNCTION users_write_status(uuid,integer,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION users_write_status(uuid,integer,uuid,boolean) TO sampleify_app;
--> statement-breakpoint
CREATE OR REPLACE VIEW user_directory WITH (security_barrier=true,security_invoker=false) AS
  SELECT membership.organization_id,person.id,person.username,person.email,person.display_name,
    person.active AND membership.active AS active,membership.created_at,organization.name AS organization_name,
    membership.active AS membership_active,person.active AS identity_active,membership.status_revision
  FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
  JOIN public.organizations organization ON organization.id=membership.organization_id
  WHERE membership.organization_id=(SELECT public.users_directory_organization());
CREATE VIEW user_status_history WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,user_id,revision,previous_revision,request_id,active,previous_active,username,display_name,
    saved_by,saved_by_username,saved_by_name,saved_at
  FROM public.user_status_versions WHERE organization_id=(SELECT public.users_directory_organization());
REVOKE ALL ON user_status_history FROM PUBLIC;
GRANT SELECT ON user_status_history TO sampleify_app;
