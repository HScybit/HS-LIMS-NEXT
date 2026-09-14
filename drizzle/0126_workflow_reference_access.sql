-- Reference labels are available only inside an actual active workflow session.
CREATE FUNCTION workflow_reference_organization() RETURNS uuid
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
    AND (public.app_has_permission('workflows.read') OR public.app_has_permission('workflows.manage'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workflow_reference_organization() FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION workflow_reference_organization() TO sampleify_app;
--> statement-breakpoint
CREATE VIEW "public"."workflow_role_labels" WITH (security_barrier = true, security_invoker = false) AS (
  SELECT organization_id,id,name,active FROM public.roles
  WHERE organization_id=(SELECT public.workflow_reference_organization())
);--> statement-breakpoint
CREATE VIEW "public"."workflow_template_labels" WITH (security_barrier = true, security_invoker = false) AS (
  SELECT template.organization_id,template.id,version.name,template.active FROM public.templates template
  JOIN LATERAL (
    SELECT name FROM public.template_versions version
    WHERE version.organization_id=template.organization_id AND version.template_id=template.id AND version.status<>'building'
    ORDER BY (version.status='draft') DESC,version.number DESC LIMIT 1
  ) version ON true
  WHERE template.organization_id=(SELECT public.workflow_reference_organization())
);
--> statement-breakpoint
REVOKE ALL ON workflow_role_labels,workflow_template_labels FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON workflow_role_labels,workflow_template_labels TO sampleify_app;
--> statement-breakpoint
-- The workflow/version locks are held by the caller. Hold the template against
-- concurrent deactivation until its selected workflow state has been committed.
CREATE FUNCTION workflow_select_template(selected_template uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid; selected_id uuid;
BEGIN
  PERFORM public.workflow_metadata_require_actor();
  SELECT id INTO selected_id FROM public.templates
    WHERE organization_id=org AND id=selected_template AND active FOR SHARE;
  PERFORM public.workflow_metadata_require_actor();
  IF selected_id IS NULL THEN
    RAISE EXCEPTION 'Select an active template in this organization' USING ERRCODE='23514',CONSTRAINT='workflow_template_unavailable';
  END IF;
  RETURN selected_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workflow_select_template(uuid) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION workflow_select_template(uuid) TO sampleify_app;
