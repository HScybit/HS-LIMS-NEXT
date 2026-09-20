-- Product's sample-category selection was read-only: its FK requires the parent
-- product row to already exist, so the version-tracking trigger's auto-copy
-- (reading product_sample_categories at the moment the head row changes) can
-- never see a product's initial categories at create time. Tags already avoid
-- this by having the application insert their version rows explicitly; give
-- sample categories the same explicit, order-independent treatment and stop
-- relying on the trigger's auto-copy, which was never exercised by any caller.
CREATE OR REPLACE FUNCTION masters_track_product() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; operation text;
BEGIN
  -- Existing migration/fixture records gain history only on an actual app edit.
  IF session_user<>'sampleify_app' THEN RETURN NEW; END IF;
  IF actor IS NULL OR NOT public.app_has_permission('masters.manage')
    OR NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Master management permission required' USING ERRCODE='42501';
  END IF;
  IF NEW.save_request_id IS NULL OR NEW.updated_at<>transaction_timestamp() THEN
    RAISE EXCEPTION 'Product writes require an actual save request and transaction time' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'New products start active at revision one' USING ERRCODE='23514'; END IF;
    operation := 'create';
  ELSE
    IF (NEW.organization_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR (NOT OLD.active AND (NOT NEW.active OR NOT EXISTS (
        SELECT 1 FROM public.master_bulk_reviews review
        JOIN public.master_bulk_batches batch ON batch.organization_id=review.organization_id AND batch.id=review.batch_id
        JOIN public.master_bulk_rows row ON row.organization_id=review.organization_id AND row.batch_id=review.batch_id AND row.id=review.row_id AND row.revision=review.input_revision
        WHERE review.organization_id=NEW.organization_id AND review.id=NEW.save_request_id AND review.valid
          AND review.candidate_id=NEW.id AND review.expected_revision=OLD.revision AND review.operation='reactivate' AND batch.resource='products'
      ))) THEN
      RAISE EXCEPTION 'Product writes preserve identity and advance the revision without an unsupported status change' USING ERRCODE='23514';
    END IF;
    -- Check an earlier save before a second edit can replace its operational links.
    IF EXISTS (SELECT 1 FROM public.product_versions WHERE organization_id=OLD.organization_id AND product_id=OLD.id AND revision=OLD.revision) THEN
      PERFORM public.masters_assert_product_tags(OLD.organization_id,OLD.id,OLD.revision,true);
      PERFORM public.masters_assert_product_sample_categories(OLD.organization_id,OLD.id,OLD.revision,true);
    END IF;
    operation := CASE WHEN NEW.active THEN 'update' ELSE 'retire' END;
    IF NOT NEW.active AND ((NEW.code,NEW.name,NEW.description,NEW.abbreviation,NEW.job_template_id)
      IS DISTINCT FROM (OLD.code,OLD.name,OLD.description,OLD.abbreviation,OLD.job_template_id)
      OR NEW.tag_count<>(SELECT count(*) FROM public.product_tags WHERE organization_id=NEW.organization_id AND product_id=NEW.id)) THEN
      RAISE EXCEPTION 'Product retirement preserves its last settings and tags' USING ERRCODE='23514';
    END IF;
  END IF;
  IF operation<>'retire' AND NEW.job_template_id IS NOT NULL THEN
    PERFORM 1 FROM public.templates template WHERE template.organization_id=NEW.organization_id AND template.id=NEW.job_template_id AND template.active
      AND EXISTS (SELECT 1 FROM public.template_versions WHERE organization_id=NEW.organization_id AND template_id=NEW.job_template_id AND status<>'building') FOR SHARE OF template;
    IF NOT FOUND THEN RAISE EXCEPTION 'Select an active template in this organization' USING ERRCODE='23514',CONSTRAINT='product_active_template'; END IF;
  END IF;
  INSERT INTO public.product_versions(organization_id,product_id,revision,request_id,previous_revision,operation,code,name,description,abbreviation,
    job_template_id,active,tag_count,saved_by)
  VALUES(NEW.organization_id,NEW.id,NEW.revision,NEW.save_request_id,CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.revision END,operation,
    NEW.code,NEW.name,NEW.description,NEW.abbreviation,NEW.job_template_id,NEW.active,NEW.tag_count,actor);
  RETURN NEW;
END $$;
--> statement-breakpoint
GRANT INSERT ON product_version_sample_categories TO sampleify_app;
CREATE POLICY product_sample_categories_history_insert ON product_version_sample_categories FOR INSERT TO sampleify_app WITH CHECK
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (SELECT app_has_permission('masters.manage')));
--> statement-breakpoint

-- Mirror the equivalent tag guards: writing directly to the current-state table
-- outside an actual saved-revision transaction remains blocked, even though the
-- role now has INSERT/DELETE grants (previously the grant itself was the only guard).
CREATE FUNCTION masters_guard_current_product_sample_categories() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE record_organization uuid; record_product uuid; version public.product_versions;
BEGIN
  IF session_user<>'sampleify_app' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Replace product sample category links through a new saved revision' USING ERRCODE='23514'; END IF;
  record_organization := CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  record_product := CASE WHEN TG_OP='DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  SELECT history.* INTO version FROM public.products product JOIN public.product_versions history
    ON history.organization_id=product.organization_id AND history.product_id=product.id AND history.revision=product.revision AND history.request_id=product.save_request_id
    WHERE product.organization_id=record_organization AND product.id=record_product;
  IF version.product_id IS NULL OR version.created_transaction_id<>pg_current_xact_id()
    OR version.saved_by IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Product sample category changes require their new active revision' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NOT EXISTS (SELECT 1 FROM public.product_version_sample_categories
    WHERE organization_id=record_organization AND product_id=record_product AND revision=version.revision AND sample_category_id=NEW.sample_category_id) THEN
    RAISE EXCEPTION 'A current product sample category must belong to the new saved revision' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER master_current_product_sample_category_guard BEFORE INSERT OR UPDATE OR DELETE ON product_sample_categories
  FOR EACH ROW EXECUTE FUNCTION masters_guard_current_product_sample_categories();
--> statement-breakpoint

CREATE FUNCTION masters_assert_product_sample_categories(target_organization uuid,target_product uuid,target_revision integer,check_current boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE version public.product_versions;
BEGIN
  SELECT * INTO version FROM public.product_versions
    WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product sample category history is missing' USING ERRCODE='23514'; END IF;
  IF check_current AND (EXISTS (
    SELECT sample_category_id FROM public.product_sample_categories WHERE organization_id=target_organization AND product_id=target_product
    EXCEPT SELECT sample_category_id FROM public.product_version_sample_categories WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision
  ) OR EXISTS (
    SELECT sample_category_id FROM public.product_version_sample_categories WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision
    EXCEPT SELECT sample_category_id FROM public.product_sample_categories WHERE organization_id=target_organization AND product_id=target_product
  )) THEN RAISE EXCEPTION 'Current product sample categories must match their saved version' USING ERRCODE='23514'; END IF;
  IF version.operation='retire' AND EXISTS (SELECT 1 FROM public.product_versions
    WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision) AND (EXISTS (
    SELECT sample_category_id FROM public.product_version_sample_categories WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision
    EXCEPT SELECT sample_category_id FROM public.product_version_sample_categories WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision
  ) OR EXISTS (
    SELECT sample_category_id FROM public.product_version_sample_categories WHERE organization_id=target_organization AND product_id=target_product AND revision=version.previous_revision
    EXCEPT SELECT sample_category_id FROM public.product_version_sample_categories WHERE organization_id=target_organization AND product_id=target_product AND revision=target_revision
  )) THEN RAISE EXCEPTION 'Product retirement preserves its last sample categories' USING ERRCODE='23514'; END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION masters_check_current_product_sample_categories() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE record_organization uuid; record_product uuid; current_revision integer;
BEGIN
  IF session_user<>'sampleify_app' THEN RETURN NULL; END IF;
  record_organization := CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  record_product := CASE WHEN TG_OP='DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  SELECT revision INTO current_revision FROM public.products WHERE organization_id=record_organization AND id=record_product;
  PERFORM public.masters_assert_product_sample_categories(record_organization,record_product,current_revision,true);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER master_current_product_sample_categories_complete AFTER INSERT OR UPDATE OR DELETE ON product_sample_categories
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION masters_check_current_product_sample_categories();
--> statement-breakpoint
REVOKE ALL ON FUNCTION masters_guard_current_product_sample_categories(),masters_assert_product_sample_categories(uuid,uuid,integer,boolean),
  masters_check_current_product_sample_categories() FROM PUBLIC,sampleify_app,sampleify_report_worker;
