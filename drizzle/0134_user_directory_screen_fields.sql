-- Preserve the existing membership created_at contract; the source screen displays identity birth.
-- Saved profile labels and live role descriptions have deliberately different provenance.
CREATE OR REPLACE VIEW user_directory WITH (security_barrier=true,security_invoker=false) AS
  SELECT membership.organization_id,person.id,person.username,person.email,person.display_name,
    person.active AND membership.active AS active,membership.created_at,organization.name AS organization_name,
    membership.active AS membership_active,person.active AS identity_active,membership.status_revision,
    person.created_at AS identity_created_at,version.default_role_id,observed.name AS default_role_name,
    role.description AS default_role_description,version.business_unit_id,version.business_unit_name,
    activity.last_login_at,activity.last_logout_at
  FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
  JOIN public.organizations organization ON organization.id=membership.organization_id
  LEFT JOIN public.user_profiles profile ON profile.organization_id=membership.organization_id AND profile.user_id=person.id
  LEFT JOIN public.user_profile_versions version ON version.organization_id=profile.organization_id AND version.user_id=profile.user_id AND version.revision=profile.revision
  LEFT JOIN public.user_profile_version_roles observed ON observed.organization_id=version.organization_id AND observed.user_id=version.user_id
    AND observed.revision=version.revision AND observed.role_id=version.default_role_id
  LEFT JOIN public.roles role ON role.organization_id=version.organization_id AND role.id=version.default_role_id
  LEFT JOIN LATERAL (
    SELECT max(event.occurred_at) FILTER (WHERE event.kind='sign_in') AS last_login_at,
      max(event.occurred_at) FILTER (WHERE event.kind='sign_out') AS last_logout_at
    FROM public.account_events event WHERE event.organization_id=membership.organization_id AND event.user_id=person.id
      AND event.kind IN ('sign_in','sign_out')
  ) activity ON true
  WHERE membership.organization_id=(SELECT public.users_directory_organization());
