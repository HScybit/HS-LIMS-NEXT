-- Identity administration reads only identities belonging to the current tenant.
-- Credential, session and MFA tables retain their existing private grants.
INSERT INTO permissions(code,description) VALUES
  ('users.read','View users'),('users.manage','Manage users') ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION users_directory_organization() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT session.organization_id FROM public.sessions session
  JOIN public.users person ON person.id=session.user_id AND person.active AND NOT person.must_change_password
  JOIN public.credentials credential ON credential.user_id=person.id AND credential.revision=session.credential_revision
  JOIN public.memberships membership ON membership.organization_id=session.organization_id AND membership.user_id=person.id AND membership.active
  JOIN public.organizations organization ON organization.id=session.organization_id AND organization.active
  WHERE session.id=nullif(current_setting('app.session_id',true),'')::uuid
    AND session.user_id=nullif(current_setting('app.user_id',true),'')::uuid
    AND session.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp()
    AND (public.app_has_permission('users.read') OR public.app_has_permission('users.manage'))
$$;
REVOKE ALL ON FUNCTION users_directory_organization() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION users_directory_organization() TO sampleify_app;
--> statement-breakpoint
CREATE VIEW user_directory WITH (security_barrier=true,security_invoker=false) AS
  SELECT membership.organization_id,person.id,person.username,person.email,person.display_name,
    person.active AND membership.active AS active,membership.created_at,
    organization.name AS organization_name
  FROM public.memberships membership JOIN public.users person ON person.id=membership.user_id
  JOIN public.organizations organization ON organization.id=membership.organization_id
  WHERE membership.organization_id=(SELECT public.users_directory_organization());
--> statement-breakpoint
CREATE VIEW user_directory_roles WITH (security_barrier=true,security_invoker=false) AS
  SELECT assignment.organization_id,assignment.user_id,role.id AS role_id,role.name,role.description,role.active
  FROM public.membership_roles assignment JOIN public.roles role
    ON role.organization_id=assignment.organization_id AND role.id=assignment.role_id
  WHERE assignment.organization_id=(SELECT public.users_directory_organization());
--> statement-breakpoint
CREATE VIEW user_directory_activity WITH (security_barrier=true,security_invoker=false) AS
  SELECT event.organization_id,event.user_id,event.kind,event.occurred_at
  FROM public.account_events event JOIN public.memberships membership
    ON membership.organization_id=event.organization_id AND membership.user_id=event.user_id
  WHERE event.organization_id=(SELECT public.users_directory_organization()) AND event.kind IN ('sign_in','sign_out');
REVOKE ALL ON user_directory,user_directory_roles,user_directory_activity FROM PUBLIC;
GRANT SELECT ON user_directory,user_directory_roles,user_directory_activity TO sampleify_app;
