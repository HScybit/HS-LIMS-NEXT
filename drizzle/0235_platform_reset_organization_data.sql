-- Re-seeding an organization rebuilds it rather than layering another
-- demonstration set on top, which means emptying it first.
--
-- Preserved: the organization itself, its System Administrator role and the
-- users holding it (with their credentials, membership and sessions), and the
-- seed-run audit trail — the run recording this reset is written through one of
-- those preserved sessions while it happens.
--
-- Everything else belonging to the organization is removed. The tables are
-- discovered from the catalog rather than listed, so a table added later is
-- cleared too.
--
-- The deletes run with session_replication_role set to replica, which is local
-- to this transaction and reverts when it ends. Two things make that necessary:
-- eighty-three triggers guard deletion of published, historical and append-only
-- rows — correct for ordinary use, and exactly what a rebuild has to get past —
-- and the schema holds genuine foreign-key cycles (datasheets <->
-- datasheet_submissions, test_requests <-> datasheets, master_bulk_rows <->
-- master_bulk_row_versions) that no single delete ordering can satisfy.
-- Constraints being unenforced for the duration is why the function proves the
-- organization is empty before it returns: a half-cleared organization must
-- fail loudly rather than be seeded on top of. The passes remain because a
-- table can still refuse a delete for a reason worth retrying.
CREATE FUNCTION platform_reset_organization_data(
  actor_organization uuid, actor_user uuid, target_organization uuid)
RETURNS TABLE (passes integer, rows_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  -- Cleared wholesale; everything else org-scoped is discovered.
  preserved constant text[] := ARRAY['seed_runs', 'seed_run_steps', 'platform_administrators',
    'memberships', 'membership_roles', 'roles', 'role_permissions', 'sessions', 'account_events'];
  target_table text;
  deleted bigint;
  still_present boolean;
  pass_deleted bigint;
  total bigint := 0;
  pass integer := 0;
  leftovers text;
BEGIN
  PERFORM 1 FROM public.platform_administrators pa
  JOIN public.memberships m ON m.organization_id = pa.organization_id AND m.user_id = pa.user_id AND m.active
  JOIN public.users u ON u.id = pa.user_id AND u.active
  WHERE pa.organization_id = actor_organization AND pa.user_id = actor_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_administrator_required';
  END IF;

  -- An organization that administers the platform is never resettable: doing so
  -- would delete the platform administrators' own working data.
  IF EXISTS (SELECT 1 FROM public.platform_administrators WHERE organization_id = target_organization) THEN
    RAISE EXCEPTION 'a platform administrator organization cannot be reset'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_organization_protected';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = target_organization) THEN
    RAISE EXCEPTION 'organization was not found' USING ERRCODE = 'no_data_found', CONSTRAINT = 'platform_organization_not_found';
  END IF;

  -- Transaction-local: other sessions keep every guard and constraint.
  BEGIN
    SET LOCAL session_replication_role = replica;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'resetting an organization requires the migration role to own the schema guards'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_reset_not_permitted';
  END;

  CREATE TEMP TABLE preserved_users ON COMMIT DROP AS
    SELECT DISTINCT m.user_id
    FROM public.memberships m
    JOIN public.membership_roles mr ON mr.organization_id = m.organization_id AND mr.user_id = m.user_id
    JOIN public.roles r ON r.organization_id = mr.organization_id AND r.id = mr.role_id AND r.protected
    WHERE m.organization_id = target_organization;

  CREATE TEMP TABLE clearable_tables ON COMMIT DROP AS
    SELECT c.table_name::text AS name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
      AND NOT (c.table_name = ANY (preserved));

  LOOP
    pass := pass + 1;
    EXIT WHEN pass > 60;
    pass_deleted := 0;
    FOR target_table IN SELECT name FROM clearable_tables LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', target_table) USING target_organization;
        GET DIAGNOSTICS deleted = ROW_COUNT;
        pass_deleted := pass_deleted + deleted;
        -- A table that is already empty need not be visited again.
        IF deleted = 0 THEN
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE organization_id = $1)', target_table)
            INTO STRICT still_present USING target_organization;
          IF NOT still_present THEN DELETE FROM clearable_tables WHERE name = target_table; END IF;
        END IF;
      EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
        -- Something still referencing these rows has yet to be cleared; a later
        -- pass reaches this table once its dependants are gone.
        NULL;
      END;
    END LOOP;
    total := total + pass_deleted;
    EXIT WHEN pass_deleted = 0;
  END LOOP;

  -- Identity is cleared last and only for users this organization introduced.
  DELETE FROM public.sessions s WHERE s.organization_id = target_organization
    AND s.user_id NOT IN (SELECT user_id FROM preserved_users);
  DELETE FROM public.account_events e WHERE e.organization_id = target_organization
    AND e.user_id NOT IN (SELECT user_id FROM preserved_users);
  DELETE FROM public.membership_roles mr WHERE mr.organization_id = target_organization
    AND mr.user_id NOT IN (SELECT user_id FROM preserved_users);
  DELETE FROM public.memberships m WHERE m.organization_id = target_organization
    AND m.user_id NOT IN (SELECT user_id FROM preserved_users);
  DELETE FROM public.role_permissions rp WHERE rp.organization_id = target_organization
    AND rp.role_id IN (SELECT id FROM public.roles WHERE organization_id = target_organization AND NOT protected);
  DELETE FROM public.roles r WHERE r.organization_id = target_organization AND NOT r.protected;

  -- A user whose only membership was this organization's has nothing left to
  -- belong to; one who is also a member elsewhere keeps their account.
  CREATE TEMP TABLE orphaned_users ON COMMIT DROP AS
    SELECT u.id FROM public.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM public.platform_administrators pa WHERE pa.user_id = u.id);
  DELETE FROM public.sessions WHERE user_id IN (SELECT id FROM orphaned_users);
  DELETE FROM public.account_events WHERE user_id IN (SELECT id FROM orphaned_users);
  DELETE FROM public.user_mfa WHERE user_id IN (SELECT id FROM orphaned_users);
  DELETE FROM public.credentials WHERE user_id IN (SELECT id FROM orphaned_users);
  DELETE FROM public.users WHERE id IN (SELECT id FROM orphaned_users);

  -- Prove it: anything still standing means the loop gave up, and silently
  -- seeding on top of a half-cleared organization is worse than failing.
  FOR target_table IN SELECT name FROM clearable_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = $1', target_table)
      INTO STRICT deleted USING target_organization;
    IF deleted > 0 THEN
      leftovers := concat_ws(', ', leftovers, format('%s (%s rows)', target_table, deleted));
    END IF;
  END LOOP;
  IF leftovers IS NOT NULL THEN
    RAISE EXCEPTION 'organization data could not be fully cleared: %', leftovers
      USING ERRCODE = 'data_exception', CONSTRAINT = 'platform_organization_not_cleared';
  END IF;

  RETURN QUERY SELECT pass, total;
END $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_reset_organization_data(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_reset_organization_data(uuid, uuid, uuid) TO sampleify_app;
