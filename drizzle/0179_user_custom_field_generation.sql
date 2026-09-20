-- Q9: working User generation is an explicitly approved improvement over the source rejection.
-- Expose only tenant generation context; credentials and global user tables stay private.
CREATE FUNCTION users_scheme_context(include_users boolean,include_samples boolean)
RETURNS TABLE("currentYearDigits" text,"nextYearDigits" text,separator text,"currentMonthFormat" text,"nonNablStartNumber" text,
  "userCount" double precision,"sampleCount" double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=public.users_directory_organization();
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('users.manage') THEN
    RAISE EXCEPTION 'User scheme generation requires permission' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT settings.scheme_current_year_digits,settings.scheme_next_year_digits,settings.scheme_separator,
    settings.scheme_month_format,settings.scheme_non_nabl_start_number,
    CASE WHEN include_users THEN (SELECT count(*)::double precision FROM public.memberships member WHERE member.organization_id=org) ELSE 0::double precision END,
    CASE WHEN include_samples THEN (SELECT count(*)::double precision FROM public.samples sample WHERE sample.organization_id=org) ELSE 0::double precision END
  FROM public.organizations organization LEFT JOIN public.organization_laboratory_settings settings ON settings.organization_id=organization.id
  WHERE organization.id=org;
END $$;
REVOKE ALL ON FUNCTION users_scheme_context(boolean,boolean) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION users_scheme_context(boolean,boolean) TO sampleify_app;
--> statement-breakpoint
-- Saved keys survive definition replacement. Counters read only current captures, including inactive members.
CREATE VIEW user_field_generation_values WITH (security_barrier=true,security_invoker=false) AS
  SELECT member.organization_id,member.user_id AS subject_user_id,person.created_at,capture.saved_at AS updated_at,
    definition.key AS field_key,field.display_text
  FROM public.memberships member JOIN public.users person ON person.id=member.user_id
  JOIN public.user_field_value_versions capture ON capture.organization_id=member.organization_id
    AND capture.subject_user_id=member.user_id AND capture.revision=member.custom_field_revision
  JOIN public.user_version_custom_fields field ON field.organization_id=capture.organization_id
    AND field.subject_user_id=capture.subject_user_id AND field.revision=capture.revision
  JOIN public.custom_field_versions definition ON definition.organization_id=field.organization_id
    AND definition.field_id=field.field_id AND definition.revision=field.field_revision
  WHERE member.organization_id=(SELECT public.users_directory_organization())
    AND (SELECT public.app_has_permission('users.manage')) AND field.display_kind='text';
REVOKE ALL ON user_field_generation_values FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON user_field_generation_values TO sampleify_app;
