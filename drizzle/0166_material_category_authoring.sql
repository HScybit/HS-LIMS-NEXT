CREATE TABLE material_categories (
  organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, description text NOT NULL DEFAULT '', reusable boolean NOT NULL DEFAULT false, expirable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1, save_request_id uuid,
  created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id),
  CONSTRAINT material_category_creator_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_category_editor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_category_fields CHECK(length(trim(name)) BETWEEN 1 AND 200 AND length(description)<=16000 AND revision>0)
);
CREATE UNIQUE INDEX material_category_active_name ON material_categories(organization_id,lower(name)) WHERE active;
CREATE INDEX material_category_created ON material_categories(organization_id,created_at,id) WHERE active;
--> statement-breakpoint
CREATE TABLE material_category_versions (
  organization_id uuid NOT NULL REFERENCES organizations(id), category_id uuid NOT NULL, revision integer NOT NULL,
  request_id uuid NOT NULL, previous_revision integer, operation text NOT NULL,
  name text NOT NULL, description text NOT NULL, reusable boolean NOT NULL, expirable boolean NOT NULL, active boolean NOT NULL,
  saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(), created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT material_category_version_pk PRIMARY KEY(organization_id,category_id,revision),
  CONSTRAINT material_category_save_request UNIQUE(organization_id,request_id),
  CONSTRAINT material_category_version_parent_fk FOREIGN KEY(organization_id,category_id) REFERENCES material_categories(organization_id,id),
  CONSTRAINT material_category_version_actor_fk FOREIGN KEY(organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_category_version_revision CHECK(
    (operation='create' AND previous_revision IS NULL AND revision=1 AND active)
    OR (operation IN ('update','retire') AND previous_revision IS NOT NULL AND previous_revision>0 AND revision=previous_revision+1 AND active=(operation='update'))),
  CONSTRAINT material_category_version_fields CHECK(length(trim(name)) BETWEEN 1 AND 200 AND length(description)<=16000)
);
--> statement-breakpoint
ALTER TABLE material_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_category_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON material_categories,material_category_versions FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT,INSERT,UPDATE ON material_categories TO sampleify_app;
GRANT SELECT ON material_category_versions TO sampleify_app;
CREATE POLICY material_category_read ON material_categories FOR SELECT TO sampleify_app USING(
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage')));
CREATE POLICY material_category_insert ON material_categories FOR INSERT TO sampleify_app WITH CHECK(
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
CREATE POLICY material_category_update ON material_categories FOR UPDATE TO sampleify_app USING(
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')))
  WITH CHECK(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
CREATE POLICY material_category_history_read ON material_category_versions FOR SELECT TO sampleify_app USING(
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage')));
--> statement-breakpoint
CREATE FUNCTION masters_guard_material_category_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Material category history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.created_transaction_id<>pg_current_xact_id() OR NEW.saved_at<>transaction_timestamp()
    OR (session_user='sampleify_app' AND NEW.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid) THEN
    RAISE EXCEPTION 'Category history requires the actual editor and transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER material_category_history_guard BEFORE INSERT OR UPDATE OR DELETE ON material_category_versions
  FOR EACH ROW EXECUTE FUNCTION masters_guard_material_category_history();
--> statement-breakpoint
CREATE FUNCTION masters_track_material_category() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  -- Offline owner imports retain their real provenance; they do not acquire invented editor history.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF actor IS NULL OR NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.save_request_id IS NULL OR NEW.updated_at<>transaction_timestamp() OR NEW.updated_by IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'Category writes require the actual editor, request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active OR NEW.created_at<>transaction_timestamp() OR NEW.created_by IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'New categories require revision one and actual creation metadata' USING ERRCODE='23514';
    END IF;
    operation:='create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at,NEW.created_by) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at,OLD.created_by)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Category writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    operation:=CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND (NEW.name,NEW.description,NEW.reusable,NEW.expirable) IS DISTINCT FROM (OLD.name,OLD.description,OLD.reusable,OLD.expirable) THEN
      RAISE EXCEPTION 'Category retirement preserves its last values' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.material_category_versions(organization_id,category_id,revision,request_id,previous_revision,operation,name,description,reusable,expirable,active,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.name,NEW.description,NEW.reusable,NEW.expirable,NEW.active,actor);
  RETURN NEW;
END $$;
CREATE TRIGGER material_category_version AFTER INSERT OR UPDATE ON material_categories FOR EACH ROW EXECUTE FUNCTION masters_track_material_category();
REVOKE ALL ON FUNCTION masters_guard_material_category_history(),masters_track_material_category() FROM PUBLIC,sampleify_app,sampleify_report_worker;
