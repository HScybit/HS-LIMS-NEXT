CREATE TABLE sample_image_assets (
  organization_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL,
  original_name text NOT NULL, media_type text NOT NULL, content bytea NOT NULL,
  byte_length integer NOT NULL, sha256 text NOT NULL, width integer NOT NULL, height integer NOT NULL, frame_count integer NOT NULL,
  uploaded_by uuid NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sample_image_asset_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT sample_image_asset_actor_fk FOREIGN KEY(organization_id,uploaded_by) REFERENCES memberships(organization_id,user_id),
  CONSTRAINT sample_image_asset_shape CHECK (
    media_type IN ('image/png','image/jpeg','image/webp') AND length(trim(original_name)) BETWEEN 1 AND 500
    AND byte_length BETWEEN 1 AND 10485760 AND byte_length=octet_length(content) AND sha256=encode(sha256(content),'hex')
    AND width BETWEEN 1 AND 10000 AND height BETWEEN 1 AND 10000 AND frame_count BETWEEN 1 AND 200
    AND width::bigint*height::bigint*frame_count::bigint<=40000000)
);
ALTER TABLE sample_image_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_image_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY sample_image_read ON sample_image_assets FOR SELECT TO sampleify_app USING (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND (
    (SELECT app_has_permission('samples.read')) OR (SELECT app_has_permission('samples.manage'))
    OR ((SELECT app_has_permission('samples.create')) AND uploaded_by=nullif(current_setting('app.user_id',true),'')::uuid))
);
CREATE POLICY sample_image_insert ON sample_image_assets FOR INSERT TO sampleify_app WITH CHECK (
  organization_id=nullif(current_setting('app.organization_id',true),'')::uuid
  AND uploaded_by=nullif(current_setting('app.user_id',true),'')::uuid AND uploaded_at=now()
  AND ((SELECT app_has_permission('samples.create')) OR (SELECT app_has_permission('samples.manage')))
);
GRANT SELECT,INSERT ON sample_image_assets TO sampleify_app;
CREATE TRIGGER sample_image_immutable BEFORE UPDATE OR DELETE ON sample_image_assets
  FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();

ALTER TABLE sample_products ADD COLUMN image_file_id uuid;
ALTER TABLE sample_products ADD CONSTRAINT sample_product_image_fk FOREIGN KEY(organization_id,image_file_id)
  REFERENCES sample_image_assets(organization_id,id);
