ALTER TABLE "custom_field_definitions" ADD COLUMN "edit_on_reissue" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_versions" ADD COLUMN "edit_on_reissue" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION masters_track_custom_field() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retire custom fields to preserve history' USING ERRCODE='55000'; END IF;
  IF actor IS NULL OR (session_user='sampleify_app' AND (NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid)) THEN
    RAISE EXCEPTION 'Master management permission and actual editor required' USING ERRCODE='42501';
  END IF;
  IF NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Custom field writes require the actual transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active OR NEW.created_at<>transaction_timestamp() THEN
      RAISE EXCEPTION 'New custom fields start active at revision one with their creation time' USING ERRCODE='23514';
    END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NOT OLD.active THEN
      RAISE EXCEPTION 'Custom field writes preserve identity and advance the active revision' USING ERRCODE='23514';
    END IF;
    PERFORM public.masters_assert_custom_field_links(OLD.organization_id,OLD.id,OLD.revision);
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND ((NEW.key,NEW.label,NEW.description,NEW.auto_generated,NEW.scheme,NEW.nabl_display_term,NEW.non_nabl_display_term,NEW.field_type,NEW.associated_with,NEW.show_in_list,NEW.show_in_filter,NEW.allows_multiple,NEW.is_required,NEW.padded_number,NEW.display_order,NEW.date_format,NEW.datetime_format,NEW.generated_at,NEW.associate_role_specific_users,NEW.associated_with_role_id,NEW.splitter,NEW.filter_search_type,NEW.show_in_dashboard,NEW.show_in_report,NEW.validate_uniqueness,NEW.hide_from_sample_creation,NEW.option_count,NEW.edit_role_count,NEW.lookup_source_id,NEW.edit_on_reissue) IS DISTINCT FROM (OLD.key,OLD.label,OLD.description,OLD.auto_generated,OLD.scheme,OLD.nabl_display_term,OLD.non_nabl_display_term,OLD.field_type,OLD.associated_with,OLD.show_in_list,OLD.show_in_filter,OLD.allows_multiple,OLD.is_required,OLD.padded_number,OLD.display_order,OLD.date_format,OLD.datetime_format,OLD.generated_at,OLD.associate_role_specific_users,OLD.associated_with_role_id,OLD.splitter,OLD.filter_search_type,OLD.show_in_dashboard,OLD.show_in_report,OLD.validate_uniqueness,OLD.hide_from_sample_creation,OLD.option_count,OLD.edit_role_count,OLD.lookup_source_id,OLD.edit_on_reissue)) THEN
      RAISE EXCEPTION 'Custom field retirement preserves its last settings' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO public.custom_field_versions(organization_id,field_id,revision,request_id,previous_revision,operation,key,label,description,auto_generated,scheme,nabl_display_term,non_nabl_display_term,field_type,associated_with,show_in_list,show_in_filter,allows_multiple,is_required,padded_number,display_order,date_format,datetime_format,generated_at,associate_role_specific_users,associated_with_role_id,splitter,filter_search_type,show_in_dashboard,show_in_report,validate_uniqueness,hide_from_sample_creation,option_count,edit_role_count,active,saved_by,lookup_source_id,edit_on_reissue)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,NEW.key,NEW.label,NEW.description,NEW.auto_generated,NEW.scheme,NEW.nabl_display_term,NEW.non_nabl_display_term,NEW.field_type,NEW.associated_with,NEW.show_in_list,NEW.show_in_filter,NEW.allows_multiple,NEW.is_required,NEW.padded_number,NEW.display_order,NEW.date_format,NEW.datetime_format,NEW.generated_at,NEW.associate_role_specific_users,NEW.associated_with_role_id,NEW.splitter,NEW.filter_search_type,NEW.show_in_dashboard,NEW.show_in_report,NEW.validate_uniqueness,NEW.hide_from_sample_creation,NEW.option_count,NEW.edit_role_count,NEW.active,actor,NEW.lookup_source_id,NEW.edit_on_reissue);
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE VIEW user_custom_field_versions WITH (security_barrier=true,security_invoker=false) AS
  SELECT organization_id,field_id,revision,option_count,key,label,description,auto_generated,scheme,
    nabl_display_term,non_nabl_display_term,field_type,associated_with,show_in_list,show_in_filter,
    allows_multiple,is_required,padded_number,display_order,date_format,datetime_format,generated_at,
    associate_role_specific_users,associated_with_role_id,splitter,filter_search_type,
    show_in_dashboard,show_in_report,validate_uniqueness,hide_from_sample_creation,lookup_source_id,edit_on_reissue
  FROM public.custom_field_versions
  WHERE associated_with='users' AND organization_id=(SELECT public.users_directory_organization());
