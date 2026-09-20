-- Trigger execution is bound to the existing owner-created table triggers.
-- Runtime roles must not attach privileged guards to their own temp tables.
DO $$ DECLARE target record; BEGIN
  FOR target IN SELECT namespace.nspname,proc.proname,pg_get_function_identity_arguments(proc.oid) AS arguments
    FROM pg_proc proc JOIN pg_namespace namespace ON namespace.oid=proc.pronamespace
    WHERE namespace.nspname='public' AND proc.prorettype='pg_catalog.trigger'::regtype
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',target.nspname,target.proname,target.arguments);
  END LOOP;
END $$;
-- New functions require explicit grants. Existing public call paths retain
-- their reviewed grants to the application or worker role.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
