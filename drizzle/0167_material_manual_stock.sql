CREATE TABLE materials (
  organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, code text NOT NULL, description text NOT NULL DEFAULT '',
  category_id uuid NOT NULL, measurement_unit_id uuid NOT NULL,
  initial_quantity numeric NOT NULL DEFAULT 0, minimum_quantity numeric NOT NULL DEFAULT 0, maximum_quantity numeric,
  initial_stock_id uuid, initial_stock_created_at timestamptz, initial_stock_created_by uuid,
  active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1, save_request_id uuid, maximum_provided boolean NOT NULL DEFAULT false,
  created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT materials_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT material_category_fk FOREIGN KEY(organization_id,category_id) REFERENCES material_categories(organization_id,id),
  CONSTRAINT material_unit_fk FOREIGN KEY(organization_id,measurement_unit_id) REFERENCES measurement_units(organization_id,id),
  CONSTRAINT material_creator_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_editor_fk FOREIGN KEY(organization_id,updated_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_opening_actor_fk FOREIGN KEY(organization_id,initial_stock_created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_fields CHECK(length(trim(name)) BETWEEN 1 AND 200 AND length(trim(code)) BETWEEN 1 AND 64 AND length(description)<=16000 AND revision>0),
  CONSTRAINT material_amounts CHECK(initial_quantity BETWEEN 0 AND 1.7976931348623157e308::numeric
    AND minimum_quantity BETWEEN 0 AND 1.7976931348623157e308::numeric
    AND (maximum_quantity IS NULL OR maximum_quantity BETWEEN minimum_quantity AND 1.7976931348623157e308::numeric)),
  CONSTRAINT material_opening_identity CHECK((initial_quantity=0 AND initial_stock_id IS NULL AND initial_stock_created_at IS NULL AND initial_stock_created_by IS NULL)
    OR (initial_quantity>0 AND initial_stock_id IS NOT NULL AND initial_stock_created_at IS NOT NULL))
);
CREATE UNIQUE INDEX material_active_code ON materials(organization_id,code) WHERE active;
CREATE INDEX material_created ON materials(organization_id,created_at,id) WHERE active;
CREATE INDEX material_category_use ON materials(organization_id,category_id,id) WHERE active;
--> statement-breakpoint
CREATE TABLE material_versions (
  organization_id uuid NOT NULL REFERENCES organizations(id), material_id uuid NOT NULL, revision integer NOT NULL,
  request_id uuid NOT NULL, previous_revision integer, operation text NOT NULL,
  name text NOT NULL, code text NOT NULL, description text NOT NULL,
  category_id uuid NOT NULL, category_name text NOT NULL, category_reusable boolean NOT NULL, category_expirable boolean NOT NULL,
  measurement_unit_id uuid NOT NULL, unit_name text NOT NULL, unit_symbol text NOT NULL,
  initial_quantity numeric NOT NULL, minimum_quantity numeric NOT NULL, maximum_quantity numeric,
  initial_stock_id uuid, initial_stock_created_at timestamptz, initial_stock_created_by uuid,
  active boolean NOT NULL, maximum_provided boolean NOT NULL, saved_by uuid NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT material_version_pk PRIMARY KEY(organization_id,material_id,revision),
  CONSTRAINT material_save_request UNIQUE(organization_id,request_id),
  CONSTRAINT material_version_parent_fk FOREIGN KEY(organization_id,material_id) REFERENCES materials(organization_id,id),
  CONSTRAINT material_version_category_fk FOREIGN KEY(organization_id,category_id) REFERENCES material_categories(organization_id,id),
  CONSTRAINT material_version_unit_fk FOREIGN KEY(organization_id,measurement_unit_id) REFERENCES measurement_units(organization_id,id),
  CONSTRAINT material_version_actor_fk FOREIGN KEY(organization_id,saved_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_version_opening_actor_fk FOREIGN KEY(organization_id,initial_stock_created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_version_revision CHECK((operation='create' AND previous_revision IS NULL AND revision=1 AND active)
    OR (operation IN ('update','retire') AND previous_revision IS NOT NULL AND previous_revision>0 AND revision=previous_revision+1 AND active=(operation='update')))
);
--> statement-breakpoint
CREATE TABLE material_transactions (
  organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(), material_id uuid NOT NULL,
  request_id uuid NOT NULL, transaction_type text NOT NULL, quantity numeric NOT NULL, cost numeric,
  supplier text NOT NULL DEFAULT '', batch_serial_number text NOT NULL, expiry_date date,
  measurement_unit_id uuid NOT NULL, unit_name text NOT NULL, unit_symbol text NOT NULL, category_expirable boolean NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT material_transaction_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT material_transaction_request UNIQUE(organization_id,request_id),
  CONSTRAINT material_transaction_parent_fk FOREIGN KEY(organization_id,material_id) REFERENCES materials(organization_id,id),
  CONSTRAINT material_transaction_unit_fk FOREIGN KEY(organization_id,measurement_unit_id) REFERENCES measurement_units(organization_id,id),
  CONSTRAINT material_transaction_actor_fk FOREIGN KEY(organization_id,created_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT material_transaction_fields CHECK(transaction_type IN ('in','out','out_damaged') AND length(trim(batch_serial_number)) BETWEEN 1 AND 150 AND length(supplier)<=250),
  CONSTRAINT material_transaction_amounts CHECK(quantity>0 AND quantity<=1.7976931348623157e308::numeric
    AND ((transaction_type='in' AND cost IS NOT NULL AND cost BETWEEN 0 AND 1.7976931348623157e308::numeric)
      OR (transaction_type<>'in' AND cost IS NULL AND expiry_date IS NULL))),
  CONSTRAINT material_transaction_expiry CHECK(expiry_date IS NULL OR expiry_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
);
CREATE INDEX material_transaction_date ON material_transactions(organization_id,material_id,created_at,id);
CREATE INDEX material_transaction_batch ON material_transactions(organization_id,material_id,batch_serial_number);
CREATE INDEX material_in_batch_lookup ON material_transactions(organization_id,material_id,lower(batch_serial_number)) WHERE transaction_type='in';
--> statement-breakpoint
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON materials,material_versions,material_transactions FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT,INSERT,UPDATE ON materials TO sampleify_app;
GRANT SELECT ON material_versions TO sampleify_app;
GRANT SELECT,INSERT ON material_transactions TO sampleify_app;
CREATE POLICY material_read ON materials FOR SELECT TO sampleify_app USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage')));
CREATE POLICY material_insert ON materials FOR INSERT TO sampleify_app WITH CHECK(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
CREATE POLICY material_update ON materials FOR UPDATE TO sampleify_app USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')))
  WITH CHECK(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
CREATE POLICY material_history_read ON material_versions FOR SELECT TO sampleify_app USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage')));
CREATE POLICY material_transaction_read ON material_transactions FOR SELECT TO sampleify_app USING(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND (SELECT app_has_permission('masters.read') OR app_has_permission('masters.manage')));
CREATE POLICY material_transaction_insert ON material_transactions FOR INSERT TO sampleify_app WITH CHECK(organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
--> statement-breakpoint
CREATE FUNCTION masters_guard_material() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid; issued numeric;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  PERFORM public.masters_lock_field_writer();
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR actor IS NULL OR NEW.updated_by IS DISTINCT FROM actor OR NEW.updated_at<>transaction_timestamp() OR NEW.save_request_id IS NULL THEN
    RAISE EXCEPTION 'Material writes require actual organization, editor, request and time' USING ERRCODE='23514';
  END IF;
  IF NEW.name<>trim(NEW.name) OR NEW.code<>trim(NEW.code) OR NEW.description<>trim(NEW.description) THEN
    RAISE EXCEPTION 'Material text must be trimmed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT NEW.active OR NEW.revision<>1 OR NEW.created_at<>transaction_timestamp() OR NEW.created_by IS DISTINCT FROM actor
      OR NEW.initial_stock_id IS NOT NULL OR NEW.initial_stock_created_at IS NOT NULL OR NEW.initial_stock_created_by IS NOT NULL THEN
      RAISE EXCEPTION 'New materials require actual creation metadata and revision one' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NOT OLD.active OR NEW.revision<>OLD.revision+1
      OR (NEW.organization_id,NEW.id,NEW.created_by,NEW.created_at,NEW.initial_stock_id,NEW.initial_stock_created_at,NEW.initial_stock_created_by)
        IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_by,OLD.created_at,OLD.initial_stock_id,OLD.initial_stock_created_at,OLD.initial_stock_created_by) THEN
      RAISE EXCEPTION 'Material writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    IF NOT NEW.active AND (NEW.name,NEW.code,NEW.description,NEW.category_id,NEW.measurement_unit_id,NEW.initial_quantity,NEW.minimum_quantity,NEW.maximum_quantity)
      IS DISTINCT FROM (OLD.name,OLD.code,OLD.description,OLD.category_id,OLD.measurement_unit_id,OLD.initial_quantity,OLD.minimum_quantity,OLD.maximum_quantity) THEN
      RAISE EXCEPTION 'Material retirement preserves its last values' USING ERRCODE='23514';
    END IF;
  END IF;
  IF (TG_OP='INSERT' OR NEW.category_id IS DISTINCT FROM OLD.category_id) AND NOT EXISTS(
    SELECT 1 FROM public.material_categories WHERE organization_id=NEW.organization_id AND id=NEW.category_id AND active) THEN
    RAISE EXCEPTION 'Select an available material category' USING ERRCODE='23514',CONSTRAINT='material_category_available';
  END IF;
  IF (TG_OP='INSERT' OR NEW.measurement_unit_id IS DISTINCT FROM OLD.measurement_unit_id) AND NOT EXISTS(
    SELECT 1 FROM public.measurement_units WHERE organization_id=NEW.organization_id AND id=NEW.measurement_unit_id AND active) THEN
    RAISE EXCEPTION 'Select an available unit of measure' USING ERRCODE='23514',CONSTRAINT='material_unit_available';
  END IF;
  SELECT coalesce(sum(quantity),0) INTO issued FROM public.material_transactions
    WHERE organization_id=NEW.organization_id AND material_id=NEW.id AND transaction_type IN ('out','out_damaged') AND batch_serial_number='Initial Stock';
  IF NEW.initial_quantity<issued THEN
    RAISE EXCEPTION 'Initial quantity cannot be below the quantity already issued from initial stock' USING ERRCODE='23514',CONSTRAINT='material_initial_below_issued';
  END IF;
  IF NEW.initial_quantity=0 THEN
    NEW.initial_stock_id:=NULL; NEW.initial_stock_created_at:=NULL; NEW.initial_stock_created_by:=NULL;
  ELSIF TG_OP='INSERT' OR OLD.initial_quantity=0 THEN
    NEW.initial_stock_id:=gen_random_uuid(); NEW.initial_stock_created_at:=transaction_timestamp(); NEW.initial_stock_created_by:=actor;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER material_write_guard BEFORE INSERT OR UPDATE ON materials FOR EACH ROW EXECUTE FUNCTION masters_guard_material();
--> statement-breakpoint
CREATE FUNCTION masters_track_material() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  INSERT INTO public.material_versions(organization_id,material_id,revision,request_id,previous_revision,operation,name,code,description,
    category_id,category_name,category_reusable,category_expirable,measurement_unit_id,unit_name,unit_symbol,
    initial_quantity,minimum_quantity,maximum_quantity,initial_stock_id,initial_stock_created_at,initial_stock_created_by,active,maximum_provided,saved_by)
  SELECT NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,
    CASE WHEN TG_OP='INSERT' THEN 'create' WHEN NEW.active THEN 'update' ELSE 'retire' END,NEW.name,NEW.code,NEW.description,
    category.id,category.name,category.reusable,category.expirable,unit.id,unit.name,unit.symbol,
    NEW.initial_quantity,NEW.minimum_quantity,NEW.maximum_quantity,NEW.initial_stock_id,NEW.initial_stock_created_at,NEW.initial_stock_created_by,NEW.active,NEW.maximum_provided,NEW.updated_by
  FROM public.material_categories category JOIN public.measurement_units unit ON unit.organization_id=category.organization_id
  WHERE category.organization_id=NEW.organization_id AND category.id=NEW.category_id AND unit.id=NEW.measurement_unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material references are unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER material_version AFTER INSERT OR UPDATE ON materials FOR EACH ROW EXECUTE FUNCTION masters_track_material();
CREATE TRIGGER material_history_guard BEFORE INSERT OR UPDATE OR DELETE ON material_versions FOR EACH ROW EXECUTE FUNCTION masters_guard_material_category_history();
--> statement-breakpoint
CREATE FUNCTION masters_guard_material_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE material public.materials%ROWTYPE; expirable boolean; available numeric; batch_available numeric; actual_supplier text; actor uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Material transactions are immutable' USING ERRCODE='55000'; END IF;
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  PERFORM public.masters_lock_field_writer();
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid OR actor IS NULL
    OR NEW.created_by IS DISTINCT FROM actor OR NEW.created_at<>transaction_timestamp() OR NEW.created_transaction_id<>pg_current_xact_id() THEN
    RAISE EXCEPTION 'Material transactions require actual actor and transaction metadata' USING ERRCODE='23514';
  END IF;
  IF NEW.batch_serial_number<>trim(NEW.batch_serial_number) OR NEW.supplier<>trim(NEW.supplier) THEN
    RAISE EXCEPTION 'Material transaction text must be trimmed' USING ERRCODE='23514';
  END IF;
  SELECT * INTO material FROM public.materials WHERE organization_id=NEW.organization_id AND id=NEW.material_id FOR UPDATE;
  IF NOT FOUND OR NOT material.active THEN RAISE EXCEPTION 'Material was not found' USING ERRCODE='23514',CONSTRAINT='material_transaction_available'; END IF;
  IF NEW.id=material.initial_stock_id THEN RAISE EXCEPTION 'Transaction identifier belongs to opening stock' USING ERRCODE='23514',CONSTRAINT='material_transaction_opening_id'; END IF;
  SELECT category.expirable INTO expirable FROM public.material_categories category WHERE category.organization_id=material.organization_id AND category.id=material.category_id;
  IF NEW.category_expirable IS DISTINCT FROM expirable THEN RAISE EXCEPTION 'Material transactions retain the actual category rule' USING ERRCODE='23514'; END IF;
  IF NEW.measurement_unit_id IS DISTINCT FROM material.measurement_unit_id OR NOT EXISTS(SELECT 1 FROM public.measurement_units unit
    WHERE unit.organization_id=material.organization_id AND unit.id=NEW.measurement_unit_id AND unit.name=NEW.unit_name AND unit.symbol=NEW.unit_symbol) THEN
    RAISE EXCEPTION 'Material transactions retain their actual unit' USING ERRCODE='23514';
  END IF;
  IF NEW.transaction_type='in' THEN
    IF EXISTS(SELECT 1 FROM public.material_transactions WHERE organization_id=NEW.organization_id AND material_id=NEW.material_id
      AND transaction_type='in' AND lower(batch_serial_number)=lower(NEW.batch_serial_number))
      OR (material.initial_quantity>0 AND lower(NEW.batch_serial_number)='initial stock') THEN
      RAISE EXCEPTION 'This Batch/Serial No already exists. Enter a unique one.' USING ERRCODE='23514',CONSTRAINT='material_duplicate_in_batch';
    END IF;
    IF (expirable AND (NEW.expiry_date IS NULL OR NEW.expiry_date<(transaction_timestamp() AT TIME ZONE 'UTC')::date))
      OR (NOT expirable AND NEW.expiry_date IS NOT NULL) THEN
      RAISE EXCEPTION 'Select a valid nonpast expiry date for an expirable material' USING ERRCODE='23514',CONSTRAINT='material_expiry_required';
    END IF;
  ELSE
    SELECT material.initial_quantity+coalesce(sum(CASE WHEN transaction_type='in' THEN quantity ELSE -quantity END),0),
      CASE WHEN NEW.batch_serial_number='Initial Stock' THEN material.initial_quantity ELSE 0 END
        +coalesce(sum(CASE WHEN transaction_type='in' THEN quantity ELSE -quantity END) FILTER(WHERE batch_serial_number=NEW.batch_serial_number),0)
      INTO available,batch_available FROM public.material_transactions WHERE organization_id=NEW.organization_id AND material_id=NEW.material_id;
    IF NEW.quantity>available OR NEW.quantity>batch_available OR batch_available<=0 THEN
      RAISE EXCEPTION 'OUT quantity cannot exceed available material or selected batch quantity' USING ERRCODE='23514',CONSTRAINT='material_insufficient_stock';
    END IF;
    SELECT supplier INTO actual_supplier FROM (
      SELECT supplier,created_at,id FROM public.material_transactions WHERE organization_id=NEW.organization_id AND material_id=NEW.material_id
        AND transaction_type='in' AND batch_serial_number=NEW.batch_serial_number AND supplier<>''
      UNION ALL SELECT 'Initial Stock',material.initial_stock_created_at,material.initial_stock_id WHERE material.initial_quantity>0 AND NEW.batch_serial_number='Initial Stock'
    ) receipts ORDER BY created_at,id LIMIT 1;
    IF NEW.supplier IS DISTINCT FROM coalesce(actual_supplier,'') THEN RAISE EXCEPTION 'OUT supplier must match the selected batch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER material_transaction_guard BEFORE INSERT OR UPDATE OR DELETE ON material_transactions FOR EACH ROW EXECUTE FUNCTION masters_guard_material_transaction();
--> statement-breakpoint
CREATE FUNCTION masters_guard_material_category_use() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user='sampleify_app' AND OLD.active AND NOT NEW.active THEN
    PERFORM public.masters_lock_field_writer();
    IF EXISTS(SELECT 1 FROM public.materials WHERE organization_id=OLD.organization_id AND category_id=OLD.id AND active) THEN
      RAISE EXCEPTION 'This category is assigned to one or more materials' USING ERRCODE='23514',CONSTRAINT='material_category_in_use';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER material_category_use_guard BEFORE UPDATE ON material_categories FOR EACH ROW EXECUTE FUNCTION masters_guard_material_category_use();
REVOKE ALL ON FUNCTION masters_guard_material(),masters_track_material(),masters_guard_material_transaction(),masters_guard_material_category_use() FROM PUBLIC,sampleify_app,sampleify_report_worker;
