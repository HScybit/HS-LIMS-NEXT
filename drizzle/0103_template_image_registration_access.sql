-- Registration already reads the corresponding template field definitions.
-- Include their typed image configuration without granting template authoring.
CREATE POLICY registration_reference_read ON template_image_config FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT app_has_permission('samples.create')));
--> statement-breakpoint
-- A registrar can resolve images actually referenced by visible definitions,
-- including an automatically initialized child. Unreferenced uploads stay private.
CREATE POLICY registration_image_reference_read ON template_image_assets FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
    AND (SELECT app_has_permission('samples.create'))
    AND id IN (SELECT field.default_image_id FROM template_fields field
      WHERE field.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
        AND field.default_image_id IS NOT NULL));
