CREATE TABLE "user_signature_versions" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"original_name" text,
	"media_type" text,
	"content" "bytea",
	"byte_length" integer,
	"sha256" text,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_by_username" text NOT NULL,
	"saved_by_name" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_transaction_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "user_signature_version_pk" PRIMARY KEY("organization_id","user_id","revision"),
	CONSTRAINT "user_signature_request_key" UNIQUE("organization_id","request_id"),
	CONSTRAINT "user_signature_revision" CHECK ("user_signature_versions"."previous_revision">=0 and "user_signature_versions"."revision"="user_signature_versions"."previous_revision"+1),
	CONSTRAINT "user_signature_payload" CHECK (("user_signature_versions"."operation"='remove' and num_nonnulls("user_signature_versions"."original_name","user_signature_versions"."media_type","user_signature_versions"."content","user_signature_versions"."byte_length","user_signature_versions"."sha256")=0)
    or ("user_signature_versions"."operation"='upload' and num_nonnulls("user_signature_versions"."original_name","user_signature_versions"."media_type","user_signature_versions"."content","user_signature_versions"."byte_length","user_signature_versions"."sha256")=5
      and "user_signature_versions"."byte_length" between 0 and 20971520 and "user_signature_versions"."byte_length"=octet_length("user_signature_versions"."content") and "user_signature_versions"."sha256"=encode(sha256("user_signature_versions"."content"),'hex')
      and length(trim("user_signature_versions"."original_name")) between 1 and 500 and "user_signature_versions"."original_name" !~ '[[:cntrl:]]'
      and position('/' in "user_signature_versions"."original_name")=0 and position(chr(92) in "user_signature_versions"."original_name")=0
      and length("user_signature_versions"."media_type")<=255 and "user_signature_versions"."media_type" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$')),
	CONSTRAINT "user_signature_labels" CHECK (length(trim("user_signature_versions"."username")) between 1 and 100 and length(trim("user_signature_versions"."display_name")) between 1 and 200
    and length(trim("user_signature_versions"."saved_by_username")) between 1 and 100 and length(trim("user_signature_versions"."saved_by_name")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "signature_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_signature_versions" ADD CONSTRAINT "user_signature_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_signature_versions" ADD CONSTRAINT "user_signature_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_signature_versions" ADD CONSTRAINT "user_signature_actor_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "membership_signature_revision" CHECK ("memberships"."signature_revision">=0);
--> statement-breakpoint
CREATE FUNCTION users_guard_signature_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.signature_revision<>0 THEN RAISE EXCEPTION 'New memberships have no invented signature history' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.signature_revision=OLD.signature_revision THEN RETURN NEW; END IF;
  IF OLD.signature_revision=2147483647 OR NEW.signature_revision<>OLD.signature_revision+1 THEN
    RAISE EXCEPTION 'A signature change requires its next revision' USING ERRCODE='23514';
  END IF;
  PERFORM public.users_require_manager();
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Signature belongs to another organization' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_signature_guard BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION users_guard_signature_head();

CREATE FUNCTION users_guard_signature_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Signature files and history are immutable' USING ERRCODE='55000'; END IF;
  IF NEW.saved_by IS DISTINCT FROM public.users_require_manager()
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.saved_at<>transaction_timestamp() OR NEW.created_transaction_id<>pg_current_xact_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
      JOIN public.users editor ON editor.id=NEW.saved_by
      WHERE membership.organization_id=NEW.organization_id AND membership.user_id=NEW.user_id AND membership.signature_revision=NEW.revision
        AND (NEW.username,NEW.display_name,NEW.saved_by_username,NEW.saved_by_name)
          IS NOT DISTINCT FROM (person.username,person.display_name,editor.username,editor.display_name)
    ) OR (NEW.previous_revision>0 AND NOT EXISTS (
      SELECT 1 FROM public.user_signature_versions previous WHERE previous.organization_id=NEW.organization_id AND previous.user_id=NEW.user_id
        AND previous.revision=NEW.previous_revision AND (NEW.operation<>'remove' OR previous.operation='upload')
    )) OR (NEW.previous_revision=0 AND NEW.operation='remove') THEN
    RAISE EXCEPTION 'Signature history requires the actual preceding file selection and editor' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_signature_history_guard BEFORE INSERT OR UPDATE OR DELETE ON user_signature_versions FOR EACH ROW EXECUTE FUNCTION users_guard_signature_history();

CREATE FUNCTION users_require_signature_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.signature_revision IS DISTINCT FROM OLD.signature_revision AND NOT EXISTS (
    SELECT 1 FROM public.user_signature_versions version WHERE version.organization_id=NEW.organization_id AND version.user_id=NEW.user_id
      AND version.revision=NEW.signature_revision AND version.previous_revision=OLD.signature_revision AND version.created_transaction_id=pg_current_xact_id()
  ) THEN RAISE EXCEPTION 'Membership signature requires its actual immutable event' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER membership_signature_history_required AFTER UPDATE ON memberships DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION users_require_signature_history();
ALTER TABLE user_signature_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_signature_versions FROM PUBLIC,sampleify_app,sampleify_report_worker;
REVOKE ALL ON FUNCTION users_guard_signature_head(),users_guard_signature_history(),users_require_signature_history() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION users_write_signature(target uuid,expected_revision integer,requested_id uuid,requested_operation text,
  requested_name text,requested_type text,requested_content bytea,requested_length integer,requested_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; actor uuid; head_revision integer; head_operation text; prior record;
BEGIN
  actor:=public.users_require_manager();
  IF target IS NULL OR expected_revision IS NULL OR expected_revision NOT BETWEEN 0 AND 2147483646 OR requested_id IS NULL
    OR requested_operation IS NULL OR requested_operation NOT IN ('upload','remove')
    OR (requested_operation='upload' AND (num_nonnulls(requested_name,requested_type,requested_content,requested_length,requested_sha256)<>5
      OR requested_length NOT BETWEEN 0 AND 20971520 OR requested_length<>octet_length(requested_content)))
    OR (requested_operation='remove' AND num_nonnulls(requested_name,requested_type,requested_content,requested_length,requested_sha256)<>0) THEN
    RAISE EXCEPTION 'Invalid signature command' USING ERRCODE='23514',CONSTRAINT='user_signature_invalid_input';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=org AND user_id=target) THEN
    RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found';
  END IF;
  PERFORM 1 FROM public.users WHERE id=ANY(ARRAY[actor,target]) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM public.memberships WHERE organization_id=org AND user_id=ANY(ARRAY[actor,target]) ORDER BY user_id FOR UPDATE;
  PERFORM 1 FROM public.sessions WHERE id=nullif(current_setting('app.session_id',true),'')::uuid FOR SHARE;
  actor:=public.users_require_manager();
  -- Request comparison and metadata reads never select an old BYTEA payload.
  SELECT user_id,saved_by,previous_revision,revision,operation,original_name,media_type,byte_length,sha256 INTO prior
    FROM public.user_signature_versions WHERE organization_id=org AND request_id=requested_id;
  IF FOUND THEN
    IF (prior.user_id,prior.saved_by,prior.previous_revision,prior.operation,prior.original_name,prior.media_type,prior.byte_length,prior.sha256)
      IS DISTINCT FROM (target,actor,expected_revision,requested_operation,requested_name,requested_type,requested_length,requested_sha256)
      OR (requested_operation='upload' AND requested_sha256 IS DISTINCT FROM encode(sha256(requested_content),'hex')) THEN
      RAISE EXCEPTION 'Save request already used for another signature change' USING ERRCODE='23514',CONSTRAINT='user_signature_request_reused';
    END IF;
    RETURN prior.revision;
  END IF;
  SELECT signature_revision INTO head_revision FROM public.memberships WHERE organization_id=org AND user_id=target;
  IF NOT FOUND THEN RAISE EXCEPTION 'User was not found' USING ERRCODE='P0002',CONSTRAINT='user_profile_not_found'; END IF;
  IF head_revision<>expected_revision THEN
    RAISE EXCEPTION 'Signature changed; reload before saving' USING ERRCODE='23514',CONSTRAINT='user_signature_stale';
  END IF;
  SELECT operation INTO head_operation FROM public.user_signature_versions WHERE organization_id=org AND user_id=target AND revision=head_revision;
  IF requested_operation='remove' AND head_operation IS DISTINCT FROM 'upload' THEN
    RAISE EXCEPTION 'This membership has no signature file to remove' USING ERRCODE='23514',CONSTRAINT='user_signature_empty';
  END IF;
  UPDATE public.memberships SET signature_revision=expected_revision+1 WHERE organization_id=org AND user_id=target;
  INSERT INTO public.user_signature_versions(organization_id,user_id,revision,previous_revision,request_id,operation,original_name,media_type,content,byte_length,sha256,
    username,display_name,saved_by,saved_by_username,saved_by_name)
    SELECT org,target,expected_revision+1,expected_revision,requested_id,requested_operation,requested_name,requested_type,requested_content,requested_length,requested_sha256,
      person.username,person.display_name,actor,editor.username,editor.display_name
    FROM public.users person JOIN public.users editor ON editor.id=actor WHERE person.id=target;
  RETURN expected_revision+1;
END $$;
REVOKE ALL ON FUNCTION users_write_signature(uuid,integer,uuid,text,text,text,bytea,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION users_write_signature(uuid,integer,uuid,text,text,text,bytea,integer,text) TO sampleify_app;
--> statement-breakpoint
CREATE VIEW user_signature_heads WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,user_id,signature_revision AS revision FROM public.memberships WHERE organization_id=(SELECT public.users_directory_organization());
CREATE VIEW user_signature_history WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,user_id,revision,previous_revision,request_id,operation,original_name,media_type,byte_length,sha256,
    username,display_name,saved_by,saved_by_username,saved_by_name,saved_at
  FROM public.user_signature_versions WHERE organization_id=(SELECT public.users_directory_organization());
REVOKE ALL ON user_signature_heads,user_signature_history FROM PUBLIC;
GRANT SELECT ON user_signature_heads,user_signature_history TO sampleify_app;

-- A view lets the exact-file query stream its result without an SRF tuplestore spilling a large encoded row.
CREATE VIEW user_signature_files WITH (security_barrier=true,security_invoker=false) AS
  SELECT version.organization_id,version.request_id AS id,version.user_id,version.revision,version.original_name,version.media_type,version.byte_length,version.sha256,version.content
  FROM public.user_signature_versions version WHERE version.organization_id=(SELECT public.users_directory_organization())
    AND version.operation='upload';
REVOKE ALL ON user_signature_files FROM PUBLIC;
GRANT SELECT ON user_signature_files TO sampleify_app;
