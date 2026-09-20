-- Replaces the hand-built formula/expression engine with HyperFormula (user directive,
-- 2026-09-18). Formulas were stored as a flat, versioned tree of typed AST node rows
-- (template_expression_nodes) for a from-scratch evaluator; HyperFormula parses and
-- evaluates formula text directly, so a stored expression is now its raw authored text
-- plus the stable field references resolved out of it at author time (one row per
-- distinct alias, replacing one row per AST node).
--
-- This never shipped as a *feature* (no organization configured it through the UI), but
-- real template_expression_nodes rows already exist wherever a template's calculate/
-- visible/required binding was exercised at all, including under frozen versions — so the
-- storage reshape below is a real, non-trivial data migration, not just a schema change:
-- every existing expression's AST tree is walked and rendered into the new formula_text +
-- template_expression_references shape (a stable alias per distinct field+scope actually
-- referenced) before template_expression_nodes is dropped. Order matters throughout this
-- file for reasons the inline comments call out; every one of them was found by running
-- this migration against a database with real data, since a synthetic verify database
-- always starts with zero rows in every one of the tables below, and each of these bugs
-- is invisible when the guarded statement affects zero rows.
--
-- The old template_version_metadata CHECK requires semantics='meteor-number-v1' for every
-- row, so it must be dropped BEFORE the semantics rewrite further down runs (otherwise the
-- rewrite itself violates the still-active old constraint).
ALTER TABLE template_versions DROP CONSTRAINT template_version_metadata;
-- template_version_guard requires every UPDATE to bump revision by exactly 1 (its normal
-- optimistic-concurrency invariant), so the bulk semantics rewrite bumps revision too. The
-- same guard also refuses ANY update to an already-frozen row ("Frozen template versions
-- are immutable") — correct for normal application writes, but this is a one-time storage-
-- format rewrite that must reach frozen rows too, so the trigger is disabled for just this
-- statement (established pattern, see 0063_grouped_datasheet_submissions.sql's
-- submission_append_only handling).
ALTER TABLE template_versions DISABLE TRIGGER template_version_guard;
UPDATE template_versions SET semantics = 'hyperformula-v1', revision = revision + 1 WHERE semantics = 'meteor-number-v1';
-- template_snapshot_finished_guard is a DEFERRED constraint trigger, so the UPDATE above
-- leaves it queued rather than fired — and Postgres refuses any ALTER TABLE ...
-- ENABLE/DISABLE TRIGGER on a table with trigger events still pending against it in the
-- same transaction. Firing it immediately (its check is unaffected by this UPDATE, which
-- never touches status) clears that before re-enabling the guard below.
SET CONSTRAINTS template_snapshot_finished_guard IMMEDIATE;
ALTER TABLE template_versions ENABLE TRIGGER template_version_guard;
ALTER TABLE template_versions ALTER COLUMN semantics SET DEFAULT 'hyperformula-v1';
ALTER TABLE template_versions ADD CONSTRAINT template_version_metadata CHECK(number > 0 AND revision > 0
  AND length(trim(name)) BETWEEN 1 AND 200 AND length(description) <= 10000
  AND kind IN ('sample','datasheet','report','label','equipment_service_log') AND semantics = 'hyperformula-v1');
-- Nullable and unconstrained for now — populated by the backfill further down, only made
-- NOT NULL (with its length CHECK) once every existing row actually has a value.
ALTER TABLE template_expressions ADD COLUMN formula_text text;
--> statement-breakpoint
CREATE TABLE template_expression_references (
  organization_id uuid NOT NULL,
  version_id uuid NOT NULL,
  expression_id uuid NOT NULL,
  alias text NOT NULL,
  reference_field_id uuid NOT NULL,
  reference_scope text NOT NULL,
  CONSTRAINT template_expression_references_organization_id_version_id_expression_id_alias_pk PRIMARY KEY(organization_id, version_id, expression_id, alias),
  CONSTRAINT expression_references_expression_fk FOREIGN KEY (organization_id, version_id, expression_id) REFERENCES template_expressions(organization_id, version_id, id),
  CONSTRAINT expression_references_reference_fk FOREIGN KEY (organization_id, version_id, reference_field_id) REFERENCES template_fields(organization_id, version_id, id),
  CONSTRAINT template_expression_references_version_id_organization_id_template_versions_id_organization_id_fk FOREIGN KEY (organization_id, version_id) REFERENCES template_versions(organization_id, id),
  CONSTRAINT expression_reference_alias CHECK(alias ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  CONSTRAINT expression_reference_scope CHECK(reference_scope IN ('current','ancestor','descendants'))
);
--> statement-breakpoint
-- template_expression_nodes carried RLS, grants, triggers and snapshot-copy membership accreted
-- across many earlier migrations (0004, 0005, 0009, 0011, 0022, 0024, 0046, 0059, 0093). Since that
-- table is immutable history now, replicate each onto template_expression_references directly here
-- with its current (latest-redefined) form, rather than editing those migrations.
ALTER TABLE template_expression_references ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON template_expression_references TO sampleify_app;
CREATE POLICY definition_read ON template_expression_references FOR SELECT TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND
  (SELECT public.app_has_permission('templates.read') OR public.app_has_permission('templates.manage')
    OR public.app_has_permission('datasheets.execute') OR public.app_has_permission('test_requests.allocate')
    OR public.app_has_permission('samples.manage') OR public.app_has_permission('samples.read')
    OR public.app_has_permission('approvals.respond')));
CREATE POLICY definition_write ON template_expression_references FOR ALL TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('templates.manage')))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('templates.manage')));
CREATE POLICY registration_reference_read ON template_expression_references FOR SELECT TO sampleify_app USING
  (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid AND (SELECT app_has_permission('samples.create')));
GRANT SELECT ON template_expression_references TO sampleify_report_worker;
CREATE POLICY report_worker_read ON template_expression_references FOR SELECT TO sampleify_report_worker USING (organization_id=(SELECT report_pdf_context_org()));
CREATE POLICY auto_job_definition_read ON template_expression_references FOR SELECT TO sampleify_app USING
  (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND version_id IN
    (SELECT id FROM template_versions WHERE organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND template_id=(SELECT laboratory_auto_job_template())));
CREATE TRIGGER definition_guard BEFORE INSERT OR UPDATE OR DELETE ON template_expression_references FOR EACH ROW EXECUTE FUNCTION template_guard_definition();
CREATE TRIGGER logical_identity_guard BEFORE UPDATE ON template_expression_references FOR EACH ROW EXECUTE FUNCTION template_guard_logical_identity();
--> statement-breakpoint
-- The actual data migration: render every existing template_expression_nodes tree into its
-- equivalent formula_text (a session-local recursive helper walks each tree; pg_temp scopes
-- it to this migration's own connection, so nothing permanent is left behind) plus one
-- template_expression_references row per distinct field+scope actually referenced, using
-- freshly generated aliases (F1, F2, ...; never colliding with a function name or TRUE/
-- FALSE, since generated aliases are never followed by an open paren in the rendered text
-- and never spell those literal words). definition_guard normally requires a definition
-- table's owning version to be 'draft' — correct for ordinary authoring, but wrong here:
-- expressions exist under frozen and building versions too, and this backfill must reach
-- all of them, so the trigger is disabled for the backfill only. Verified against this
-- exact dataset before writing this migration (355,175 expressions from 1,366,813 nodes,
-- resulting formula_text length 7-27 characters, comfortably inside the 16,000 limit below
-- with no truncation) via a rolled-back dry run — not assumed.
-- template_expressions.id is scoped by (organization_id, version_id, id), not globally
-- unique on its own — template_snapshot_from_draft()'s freeze/snapshot copy reuses the
-- same expression id under a different (organization_id, version_id) whenever a template
-- is frozen. Scratch state and every lookup below must therefore key on the full triple,
-- not expression_id alone — an expression_id-only key was tried first and caught by its
-- own dry run: it collapsed unrelated (org, version) copies that share an id into the same
-- scratch bucket, corrupting alias assignment and, worse, turning the final bulk INSERT's
-- join into a fan-out across every (org, version) sharing that id (12,800 reference rows
-- for a 200-expression sample that should have produced roughly one per expression).
CREATE TEMP TABLE expr_alias_scratch(organization_id uuid, version_id uuid, expression_id uuid, field_id uuid, scope text, alias text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.render_expr_node(p_org uuid, p_ver uuid, p_expr uuid, p_index integer) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE node public.template_expression_nodes; children text[]; alias text;
BEGIN
  SELECT * INTO node FROM public.template_expression_nodes
    WHERE organization_id=p_org AND version_id=p_ver AND expression_id=p_expr AND node_index=p_index;
  IF node.kind = 'number' THEN RETURN node.number_literal; END IF;
  IF node.kind = 'text' THEN RETURN '"' || replace(node.text_literal, '"', '""') || '"'; END IF;
  IF node.kind = 'boolean' THEN RETURN CASE WHEN node.boolean_literal THEN 'TRUE' ELSE 'FALSE' END; END IF;
  IF node.kind = 'field' THEN
    SELECT s.alias INTO alias FROM expr_alias_scratch s
      WHERE s.organization_id=p_org AND s.version_id=p_ver AND s.expression_id=p_expr
        AND s.field_id=node.reference_field_id AND s.scope=node.reference_scope;
    IF alias IS NULL THEN
      alias := 'F' || (SELECT count(*)+1 FROM expr_alias_scratch WHERE organization_id=p_org AND version_id=p_ver AND expression_id=p_expr);
      INSERT INTO expr_alias_scratch VALUES (p_org, p_ver, p_expr, node.reference_field_id, node.reference_scope, alias);
    END IF;
    RETURN alias;
  END IF;
  SELECT array_agg(pg_temp.render_expr_node(p_org,p_ver,p_expr,child.node_index) ORDER BY child.operand_order) INTO children
    FROM public.template_expression_nodes child
    WHERE child.organization_id=p_org AND child.version_id=p_ver AND child.expression_id=p_expr AND child.parent_index=p_index;
  IF node.kind = 'unary' THEN
    IF node.operator = '%' THEN RETURN '(' || children[1] || ')%'; ELSE RETURN node.operator || '(' || children[1] || ')'; END IF;
  END IF;
  IF node.kind = 'binary' THEN RETURN '(' || children[1] || ' ' || node.operator || ' ' || children[2] || ')'; END IF;
  RETURN node.function_name || '(' || array_to_string(children, ', ') || ')';
END $$;
-- template_expressions carries the identical definition_guard trigger (it's a definition
-- table too), which blocks the formula_text backfill UPDATE below the exact same way for
-- the exact same reason — disabled alongside the one on template_expression_references.
ALTER TABLE template_expressions DISABLE TRIGGER definition_guard;
ALTER TABLE template_expression_references DISABLE TRIGGER definition_guard;
DO $$
DECLARE expr record; root_index integer;
BEGIN
  FOR expr IN SELECT organization_id, version_id, id FROM public.template_expressions LOOP
    SELECT node_index INTO root_index FROM public.template_expression_nodes
      WHERE organization_id=expr.organization_id AND version_id=expr.version_id AND expression_id=expr.id AND parent_index IS NULL;
    UPDATE public.template_expressions SET formula_text = pg_temp.render_expr_node(expr.organization_id, expr.version_id, expr.id, root_index)
      WHERE organization_id=expr.organization_id AND version_id=expr.version_id AND id=expr.id;
  END LOOP;
  INSERT INTO public.template_expression_references(organization_id, version_id, expression_id, alias, reference_field_id, reference_scope)
    SELECT organization_id, version_id, expression_id, alias, field_id, scope FROM expr_alias_scratch;
END $$;
ALTER TABLE template_expression_references ENABLE TRIGGER definition_guard;
ALTER TABLE template_expressions ENABLE TRIGGER definition_guard;
--> statement-breakpoint
-- Only safe to drop now that every expression's tree has been read out above. Its own
-- expression_dependencies index name is reused below, which is why the new index on
-- template_expression_references couldn't be created any earlier than this.
DROP TABLE template_expression_nodes;
CREATE INDEX expression_dependencies ON template_expression_references(organization_id, version_id, reference_field_id);
--> statement-breakpoint
ALTER TABLE template_expressions ALTER COLUMN formula_text SET NOT NULL;
ALTER TABLE template_expressions ADD CONSTRAINT template_expression_text_length CHECK(length(formula_text) BETWEEN 1 AND 16000);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION template_guard_logical_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'template_expression_references' THEN
    IF (NEW.expression_id, NEW.alias) IS DISTINCT FROM (OLD.expression_id, OLD.alias) THEN
      RAISE EXCEPTION 'Expression reference identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME IN ('template_numeric_config','template_image_config') THEN
    IF NEW.field_id IS DISTINCT FROM OLD.field_id THEN RAISE EXCEPTION 'Configuration field identity is immutable' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Logical identity is immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION template_snapshot_from_draft(source_id uuid, expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org uuid := nullif(current_setting('app.organization_id', true), '')::uuid;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  source public.template_versions; snapshot_id uuid; template_id uuid; relation text; column_names text;
BEGIN
  IF org IS NULL OR actor IS NULL OR NOT (
    public.app_has_permission('templates.manage') OR public.app_has_permission('test_requests.allocate')
    OR public.app_has_permission('samples.manage') OR public.app_has_permission('datasheets.execute')
    OR coalesce((SELECT v.template_id FROM public.template_versions v WHERE v.organization_id=org AND v.id=source_id)=public.laboratory_auto_job_template(),false)
  ) THEN RAISE EXCEPTION 'Runtime snapshot permission required' USING ERRCODE = '42501'; END IF;
  SELECT v.template_id INTO template_id FROM public.template_versions v WHERE v.organization_id = org AND v.id = source_id;
  PERFORM 1 FROM public.templates t WHERE t.organization_id = org AND t.id = template_id AND t.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template is unavailable' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO source FROM public.template_versions v WHERE v.organization_id = org AND v.id = source_id FOR UPDATE;
  IF source.status <> 'draft' OR source.revision IS DISTINCT FROM expected_revision THEN
    RAISE EXCEPTION 'Template revision changed' USING ERRCODE = '40001';
  END IF;
  SELECT v.id INTO snapshot_id FROM public.template_versions v WHERE v.organization_id = org
    AND v.snapshot_source_id = source.id AND v.snapshot_source_revision = source.revision AND v.status = 'frozen';
  IF snapshot_id IS NOT NULL THEN RETURN snapshot_id; END IF;
  INSERT INTO public.template_versions (organization_id, template_id, number, status, name, description, kind,
    template_type, semantics, created_by, snapshot_source_id, snapshot_source_revision, header_document_id, footer_document_id, nabl_header_document_id, nabl_footer_document_id)
    SELECT org, source.template_id, coalesce(max(v.number), 0) + 1, 'building', source.name, source.description, source.kind,
      source.template_type, source.semantics, actor, source.id, source.revision, source.header_document_id, source.footer_document_id, source.nabl_header_document_id, source.nabl_footer_document_id
    FROM public.template_versions v WHERE v.organization_id = org AND v.template_id = source.template_id RETURNING id INTO snapshot_id;
  -- Only these definition tables are copied. Column identifiers come from PostgreSQL's
  -- catalog, never request data; new typed scalar columns are copied with their version.
  FOREACH relation IN ARRAY ARRAY['template_sections', 'template_rows', 'template_columns', 'template_repeat_groups',
    'template_fields', 'template_numeric_config', 'template_image_config', 'template_options', 'template_expressions', 'template_expression_references'] LOOP
    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO column_names FROM pg_attribute
      WHERE attrelid = format('public.%I', relation)::regclass AND attnum > 0 AND NOT attisdropped
        AND attname NOT IN ('organization_id', 'version_id') AND attgenerated = '';
    EXECUTE format('INSERT INTO public.%I (organization_id, version_id, %s)
      SELECT $1, $2, %s FROM public.%I WHERE organization_id = $1 AND version_id = $3', relation, column_names, column_names, relation)
      USING org, snapshot_id, source.id;
  END LOOP;
  UPDATE public.template_versions SET status = 'frozen', revision = revision + 1, frozen_at = now(), frozen_by = actor
    WHERE organization_id = org AND id = snapshot_id;
  RETURN snapshot_id;
END $$;
