-- Only the scheme settings and counts required by Parameter generation are exposed.
CREATE FUNCTION masters_parameter_scheme_context(include_parameters boolean,include_samples boolean)
RETURNS TABLE("currentYearDigits" text,"nextYearDigits" text,separator text,"currentMonthFormat" text,"nonNablStartNumber" text,
  "parameterCount" double precision,"sampleCount" double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid:=nullif(current_setting('app.organization_id',true),'')::uuid;
BEGIN
  IF org IS NULL OR NOT public.app_has_permission('masters.manage') THEN
    RAISE EXCEPTION 'Parameter scheme generation requires permission' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT settings.scheme_current_year_digits,settings.scheme_next_year_digits,settings.scheme_separator,
    settings.scheme_month_format,settings.scheme_non_nabl_start_number,
    CASE WHEN include_parameters THEN (SELECT count(*)::double precision FROM public.test_parameters parameter WHERE parameter.organization_id=org AND parameter.active) ELSE 0::double precision END,
    CASE WHEN include_samples THEN (SELECT count(*)::double precision FROM public.samples sample WHERE sample.organization_id=org) ELSE 0::double precision END
  FROM public.organizations organization LEFT JOIN public.organization_laboratory_settings settings ON settings.organization_id=organization.id
  WHERE organization.id=org;
END $$;
REVOKE ALL ON FUNCTION masters_parameter_scheme_context(boolean,boolean) FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT EXECUTE ON FUNCTION masters_parameter_scheme_context(boolean,boolean) TO sampleify_app;
--> statement-breakpoint
