-- User-form metadata uses user-management authority without exposing other master associations.
CREATE VIEW user_custom_field_definitions WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,id,revision,associated_with,active,display_order,label,show_in_list,show_in_filter
  FROM public.custom_field_definitions
  WHERE associated_with='users' AND organization_id=(SELECT public.users_directory_organization());
--> statement-breakpoint
CREATE VIEW user_custom_field_versions WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,field_id,revision,option_count,key,label,description,auto_generated,scheme,
    nabl_display_term,non_nabl_display_term,field_type,associated_with,show_in_list,show_in_filter,
    allows_multiple,is_required,padded_number,display_order,date_format,datetime_format,generated_at,
    associate_role_specific_users,associated_with_role_id,splitter,filter_search_type,
    show_in_dashboard,show_in_report,validate_uniqueness,hide_from_sample_creation
  FROM public.custom_field_versions
  WHERE associated_with='users' AND organization_id=(SELECT public.users_directory_organization());
--> statement-breakpoint
CREATE VIEW user_custom_field_version_options WITH (security_barrier=true,security_invoker=false) AS
  SELECT option.organization_id,option.field_id,option.revision,option.id,option.key,option.label,option.position
  FROM public.custom_field_version_options option JOIN public.custom_field_versions version
    ON version.organization_id=option.organization_id AND version.field_id=option.field_id AND version.revision=option.revision
  WHERE version.associated_with='users' AND option.organization_id=(SELECT public.users_directory_organization());
REVOKE ALL ON user_custom_field_definitions,user_custom_field_versions,user_custom_field_version_options FROM PUBLIC,sampleify_app,sampleify_report_worker;
GRANT SELECT ON user_custom_field_definitions,user_custom_field_versions,user_custom_field_version_options TO sampleify_app;
