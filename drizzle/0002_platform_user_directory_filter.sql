-- The directory groups people by organization, which puts one organization's
-- whole staff on the first page and makes a deployment-wide list look like a
-- single-organization one. Grouping is what an administrator wants when they
-- are looking at an organization, so it stays; what was missing is a way to say
-- which organization. `requested_organizations` does that, and NULL or an empty
-- array keeps the previous behaviour of returning everybody.
DROP FUNCTION IF EXISTS platform_list_users(uuid, uuid, text, integer, integer);--> statement-breakpoint

CREATE FUNCTION platform_list_users(
  actor_organization uuid, actor_user uuid, requested_search text DEFAULT '',
  requested_page integer DEFAULT 1, requested_page_size integer DEFAULT 25,
  requested_organizations uuid[] DEFAULT NULL)
RETURNS TABLE (
  user_id uuid, username text, email text, display_name text, active boolean,
  must_change_password boolean, mfa_enabled boolean, is_platform_administrator boolean,
  organization_id uuid, organization_code text, organization_name text,
  organization_count integer, last_sign_in_at timestamptz, total_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE pattern text; size integer; offset_rows integer; scoped boolean;
BEGIN
  PERFORM 1 FROM public.platform_administrators pa
  JOIN public.memberships m ON m.organization_id = pa.organization_id AND m.user_id = pa.user_id AND m.active
  JOIN public.users u ON u.id = pa.user_id AND u.active
  WHERE pa.organization_id = actor_organization AND pa.user_id = actor_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'platform_administrator_required';
  END IF;

  size := least(greatest(coalesce(requested_page_size, 25), 1), 100);
  offset_rows := (least(greatest(coalesce(requested_page, 1), 1), 1000000) - 1) * size;
  pattern := '%' || replace(replace(replace(coalesce(requested_search, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  scoped := requested_organizations IS NOT NULL AND cardinality(requested_organizations) > 0;

  RETURN QUERY
  WITH home AS (
    SELECT DISTINCT ON (m.user_id) m.user_id, m.organization_id
    FROM public.memberships m
    ORDER BY m.user_id, m.is_default DESC, m.created_at, m.organization_id
  ), matched AS (
    SELECT u.id, u.username, u.email, u.display_name, u.active, u.must_change_password,
      coalesce(mfa.enabled, false) AS mfa_enabled,
      EXISTS (SELECT 1 FROM public.platform_administrators pa WHERE pa.user_id = u.id) AS is_platform_administrator,
      o.id AS organization_id, o.code AS organization_code, o.name AS organization_name,
      (SELECT count(*)::integer FROM public.memberships m WHERE m.user_id = u.id) AS organization_count,
      (SELECT max(e.occurred_at) FROM public.account_events e WHERE e.user_id = u.id AND e.kind = 'sign_in') AS last_sign_in_at
    FROM public.users u
    LEFT JOIN home ON home.user_id = u.id
    LEFT JOIN public.organizations o ON o.id = home.organization_id
    LEFT JOIN public.user_mfa mfa ON mfa.user_id = u.id
    WHERE (NOT scoped OR home.organization_id = ANY (requested_organizations))
      AND (requested_search IS NULL OR requested_search = '' OR (
        u.username ILIKE pattern ESCAPE '\' OR u.email ILIKE pattern ESCAPE '\' OR u.display_name ILIKE pattern ESCAPE '\'
        OR o.code ILIKE pattern ESCAPE '\' OR o.name ILIKE pattern ESCAPE '\'))
  )
  SELECT matched.id, matched.username, matched.email, matched.display_name, matched.active,
    matched.must_change_password, matched.mfa_enabled, matched.is_platform_administrator,
    matched.organization_id, matched.organization_code, matched.organization_name,
    matched.organization_count, matched.last_sign_in_at,
    (SELECT count(*)::integer FROM matched)
  FROM matched
  ORDER BY matched.organization_name NULLS LAST, matched.username
  LIMIT size OFFSET offset_rows;
END $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION platform_list_users(uuid, uuid, text, integer, integer, uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_list_users(uuid, uuid, text, integer, integer, uuid[]) TO sampleify_app;
