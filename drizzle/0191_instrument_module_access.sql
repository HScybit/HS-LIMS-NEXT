-- Q15: Instruments requires enabled, explicitly assigned module access.
-- Existing immutable history really contains two modules. Record that fact;
-- only future settings commands capture the new three-module shape.
ALTER TABLE organization_module_access_versions ADD COLUMN module_count integer NOT NULL DEFAULT 2;
ALTER TABLE organization_module_access_versions ALTER COLUMN module_count SET DEFAULT 3;
ALTER TABLE organization_module_access_versions ADD CONSTRAINT module_access_count CHECK(module_count IN (2,3));
ALTER TABLE organization_module_access_modules DROP CONSTRAINT module_access_module_fields;
ALTER TABLE organization_module_access_modules ADD CONSTRAINT module_access_module_fields
  CHECK(module_key IN ('customer','vendor','instrument') AND role_count BETWEEN 0 AND 500 AND user_count BETWEEN 0 AND 500);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION organization_check_module_access_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF (SELECT array_agg(module_key ORDER BY module_key) FROM public.organization_module_access_modules
      WHERE organization_id=NEW.organization_id AND revision=NEW.revision) IS DISTINCT FROM
      (CASE NEW.module_count WHEN 2 THEN ARRAY['customer','vendor']::text[] ELSE ARRAY['customer','instrument','vendor']::text[] END) THEN
    RAISE EXCEPTION 'Capture the complete configured module set' USING ERRCODE='23514',CONSTRAINT='module_access_complete';
  END IF;
  IF EXISTS (
    WITH facts AS (
      SELECT module_key,'role'::text AS kind,role_count AS expected,NULL::integer AS position
        FROM public.organization_module_access_modules WHERE organization_id=NEW.organization_id AND revision=NEW.revision
      UNION ALL SELECT module_key,'user',user_count,NULL FROM public.organization_module_access_modules
        WHERE organization_id=NEW.organization_id AND revision=NEW.revision
      UNION ALL SELECT module_key,'role',NULL,position FROM public.organization_module_access_roles
        WHERE organization_id=NEW.organization_id AND revision=NEW.revision
      UNION ALL SELECT module_key,'user',NULL,position FROM public.organization_module_access_users
        WHERE organization_id=NEW.organization_id AND revision=NEW.revision
    ) SELECT 1 FROM facts GROUP BY module_key,kind
      HAVING max(expected) IS DISTINCT FROM count(position)
        OR (count(position)>0 AND (min(position)<>0 OR max(position)<>count(position)-1))
  ) THEN RAISE EXCEPTION 'Module assignments require complete ordered sets' USING ERRCODE='23514',CONSTRAINT='module_access_complete'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION organization_save_module_access(p_revision integer,p_modules text[],p_enabled boolean[],
  p_role_modules text[],p_role_ids uuid[],p_user_modules text[],p_user_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=public.organization_lock_settings_writer(); org uuid:=public.organization_module_scope();
  head public.organization_laboratory_settings; previous_instrument public.organization_module_access_modules;
BEGIN
  SELECT * INTO head FROM public.organization_laboratory_settings WHERE organization_id=org FOR UPDATE;
  IF head.organization_id IS NULL OR head.revision IS DISTINCT FROM p_revision
    OR head.updated_by IS DISTINCT FROM actor OR head.updated_at IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'Module access requires this transaction''s settings save' USING ERRCODE='23514',CONSTRAINT='module_access_current_settings';
  END IF;
  IF (p_modules IS DISTINCT FROM ARRAY['customer','vendor']::text[] AND p_modules IS DISTINCT FROM ARRAY['customer','vendor','instrument']::text[])
    OR cardinality(p_enabled) IS DISTINCT FROM cardinality(p_modules) OR array_ndims(p_enabled) IS DISTINCT FROM 1 OR array_position(p_enabled,NULL) IS NOT NULL
    OR cardinality(p_role_ids) IS NULL OR cardinality(p_role_ids)>1500 OR cardinality(p_role_modules) IS DISTINCT FROM cardinality(p_role_ids)
    OR cardinality(p_user_ids) IS NULL OR cardinality(p_user_ids)>1500 OR cardinality(p_user_modules) IS DISTINCT FROM cardinality(p_user_ids)
    OR (cardinality(p_role_ids)>0 AND (array_ndims(p_role_ids)<>1 OR array_ndims(p_role_modules)<>1))
    OR (cardinality(p_user_ids)>0 AND (array_ndims(p_user_ids)<>1 OR array_ndims(p_user_modules)<>1))
    OR EXISTS (SELECT 1 FROM unnest(p_role_modules,p_role_ids) entry(module_key,id) WHERE module_key IS NULL OR NOT (module_key=ANY(p_modules)) OR id IS NULL)
    OR EXISTS (SELECT 1 FROM unnest(p_user_modules,p_user_ids) entry(module_key,id) WHERE module_key IS NULL OR NOT (module_key=ANY(p_modules)) OR id IS NULL) THEN
    RAISE EXCEPTION 'Module access arrays must be aligned and bounded' USING ERRCODE='23514',CONSTRAINT='module_access_input';
  END IF;
  -- A two-module caller predates Instruments: preserve its saved selections.
  -- The settings writer already holds the organization and current head locks.
  IF cardinality(p_modules)=2 THEN
    SELECT * INTO previous_instrument FROM public.organization_module_access_modules module
      WHERE module.organization_id=org AND module.module_key='instrument'
        AND module.revision=(SELECT max(version.revision) FROM public.organization_module_access_versions version
          WHERE version.organization_id=org AND version.revision<p_revision);
    p_modules:=array_append(p_modules,'instrument');
    p_enabled:=array_append(p_enabled,coalesce(previous_instrument.enabled,false));
    IF previous_instrument.module_key IS NOT NULL THEN
      SELECT p_role_modules||coalesce(array_agg(module_key ORDER BY position),ARRAY[]::text[]),
        p_role_ids||coalesce(array_agg(role_id ORDER BY position),ARRAY[]::uuid[])
        INTO p_role_modules,p_role_ids FROM public.organization_module_access_roles
        WHERE organization_id=org AND revision=previous_instrument.revision AND module_key='instrument';
      SELECT p_user_modules||coalesce(array_agg(module_key ORDER BY position),ARRAY[]::text[]),
        p_user_ids||coalesce(array_agg(user_id ORDER BY position),ARRAY[]::uuid[])
        INTO p_user_modules,p_user_ids FROM public.organization_module_access_users
        WHERE organization_id=org AND revision=previous_instrument.revision AND module_key='instrument';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_role_ids) selection(id) WHERE NOT EXISTS (
      SELECT 1 FROM public.roles role WHERE role.organization_id=org AND role.id=selection.id))
    OR EXISTS (SELECT 1 FROM unnest(p_user_ids) selection(id) WHERE NOT EXISTS (
      SELECT 1 FROM public.memberships membership WHERE membership.organization_id=org AND membership.user_id=selection.id)) THEN
    RAISE EXCEPTION 'Module assignments require same-organization references' USING ERRCODE='23514',CONSTRAINT='module_access_reference';
  END IF;
  INSERT INTO public.organization_module_access_versions(organization_id,revision,module_count,saved_by) VALUES(org,p_revision,3,actor);
  INSERT INTO public.organization_module_access_modules(organization_id,revision,module_key,enabled,role_count,user_count)
    SELECT org,p_revision,module.key,module.enabled,
      (SELECT count(*) FROM unnest(p_role_modules) selection(key) WHERE selection.key=module.key),
      (SELECT count(*) FROM unnest(p_user_modules) selection(key) WHERE selection.key=module.key)
    FROM unnest(p_modules,p_enabled) module(key,enabled);
  INSERT INTO public.organization_module_access_roles(organization_id,revision,module_key,role_id,position,role_name,role_active)
    SELECT org,p_revision,selection.module_key,selection.id,
      row_number() OVER (PARTITION BY selection.module_key ORDER BY selection.ordinality)-1,role.name,role.active
    FROM unnest(p_role_modules,p_role_ids) WITH ORDINALITY selection(module_key,id,ordinality)
    JOIN public.roles role ON role.organization_id=org AND role.id=selection.id;
  -- Membership FKs preserve the selected identities. Nonlocking label reads avoid
  -- reversing the user-profile writer's user-before-organization lock order.
  INSERT INTO public.organization_module_access_users(organization_id,revision,module_key,user_id,position,user_name,user_username,user_active)
    SELECT org,p_revision,selection.module_key,selection.id,
      row_number() OVER (PARTITION BY selection.module_key ORDER BY selection.ordinality)-1,
      coalesce(nullif(person.display_name,''),nullif(person.email,''),person.id::text),person.username,person.active AND membership.active
    FROM unnest(p_user_modules,p_user_ids) WITH ORDINALITY selection(module_key,id,ordinality)
    JOIN public.memberships membership ON membership.organization_id=org AND membership.user_id=selection.id
    JOIN public.users person ON person.id=membership.user_id;
END $$;
