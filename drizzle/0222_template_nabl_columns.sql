-- Replaces the "show_in_nabl"/"show_in_non_nabl" cssClass-token hack (a magic
-- string an author could accidentally break by editing the free-text class
-- field) with real boolean columns on template_sections/template_columns,
-- matching PERN's Template Studio data model. The CSS mechanism that actually
-- hides/shows these elements (custom.scss's .nabl_mode/.non_nabl_mode rule)
-- is unchanged; only the source of the show_in_nabl/show_in_non_nabl class
-- tokens moves from free-text cssClass to these columns (TemplateCanvas.jsx
-- now derives the token classes from the booleans at render time).
ALTER TABLE template_sections ADD COLUMN show_in_nabl boolean NOT NULL DEFAULT false;
ALTER TABLE template_sections ADD COLUMN show_in_non_nabl boolean NOT NULL DEFAULT false;
ALTER TABLE template_columns ADD COLUMN show_in_nabl boolean NOT NULL DEFAULT false;
ALTER TABLE template_columns ADD COLUMN show_in_non_nabl boolean NOT NULL DEFAULT false;

-- definition_guard refuses any write to an already-frozen version's rows ("Only draft
-- definitions may change") — correct for normal application writes, but this backfill
-- is a one-time storage-format rewrite that must reach frozen rows too, so the trigger
-- is disabled for just these statements (established pattern, see
-- 0204_hyperformula_expression_storage.sql).
ALTER TABLE template_sections DISABLE TRIGGER definition_guard;
UPDATE template_sections SET
  show_in_nabl = css_class ~ '(^|\s)show_in_nabl(\s|$)',
  show_in_non_nabl = css_class ~ '(^|\s)show_in_non_nabl(\s|$)'
WHERE css_class ~ '(^|\s)show_in_(non_)?nabl(\s|$)';
UPDATE template_sections SET css_class = btrim(regexp_replace(css_class, '\s*\y(show_in_nabl|show_in_non_nabl)\y\s*', ' ', 'g'))
WHERE css_class ~ '(^|\s)show_in_(non_)?nabl(\s|$)';
ALTER TABLE template_sections ENABLE TRIGGER definition_guard;

ALTER TABLE template_columns DISABLE TRIGGER definition_guard;
UPDATE template_columns SET
  show_in_nabl = css_class ~ '(^|\s)show_in_nabl(\s|$)',
  show_in_non_nabl = css_class ~ '(^|\s)show_in_non_nabl(\s|$)'
WHERE css_class ~ '(^|\s)show_in_(non_)?nabl(\s|$)';
UPDATE template_columns SET css_class = btrim(regexp_replace(css_class, '\s*\y(show_in_nabl|show_in_non_nabl)\y\s*', ' ', 'g'))
WHERE css_class ~ '(^|\s)show_in_(non_)?nabl(\s|$)';
ALTER TABLE template_columns ENABLE TRIGGER definition_guard;
