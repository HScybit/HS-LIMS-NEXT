-- The seeding plan is read by a platform administrator whose session belongs to
-- a different organization, so row-level security hides the target's data from
-- a direct count. This reports just the totals the plan needs.
CREATE FUNCTION platform_organization_seed_counts(actor_organization uuid, actor_user uuid, requested_organization uuid)
RETURNS TABLE (members integer, laboratories integer, customers integer, vendors integer, products integer,
               methods integer, test_parameters integer, templates integer, samples integer, instruments integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  PERFORM 1 FROM public.platform_administrators pa
  WHERE pa.organization_id = actor_organization AND pa.user_id = actor_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_administrator_required';
  END IF;

  RETURN QUERY SELECT
    (SELECT count(*)::integer FROM public.memberships WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.laboratories WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.customers WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.vendors WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.products WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.methods_of_analysis WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.test_parameters WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.templates WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.samples WHERE organization_id = requested_organization),
    (SELECT count(*)::integer FROM public.instruments WHERE organization_id = requested_organization);
END $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_organization_seed_counts(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_organization_seed_counts(uuid, uuid, uuid) TO sampleify_app;
