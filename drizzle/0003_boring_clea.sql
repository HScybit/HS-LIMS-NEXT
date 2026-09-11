CREATE TABLE "template_columns" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"row_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"span" integer DEFAULT 0 NOT NULL,
	"css_class" text DEFAULT '' NOT NULL,
	CONSTRAINT "template_columns_organization_id_version_id_id_pk" PRIMARY KEY("organization_id","version_id","id"),
	CONSTRAINT "template_column_layout" CHECK ("template_columns"."position" >= 0 and "template_columns"."span" between 0 and 12)
);
--> statement-breakpoint
CREATE TABLE "template_expression_nodes" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"expression_id" uuid NOT NULL,
	"node_index" integer NOT NULL,
	"parent_index" integer,
	"operand_order" integer NOT NULL,
	"kind" text NOT NULL,
	"number_literal" text,
	"text_literal" text,
	"boolean_literal" boolean,
	"reference_field_id" uuid,
	"reference_scope" text,
	"operator" text,
	"function_name" text,
	CONSTRAINT "template_expression_nodes_organization_id_version_id_expression_id_node_index_pk" PRIMARY KEY("organization_id","version_id","expression_id","node_index"),
	CONSTRAINT "expression_node_bounds" CHECK ("template_expression_nodes"."node_index" between 0 and 999 and "template_expression_nodes"."operand_order" between 0 and 999 and ("template_expression_nodes"."parent_index" is null or ("template_expression_nodes"."parent_index" between 0 and 999 and "template_expression_nodes"."parent_index" <> "template_expression_nodes"."node_index"))),
	CONSTRAINT "expression_node_payload" CHECK ((
    ("template_expression_nodes"."kind" = 'number' and "template_expression_nodes"."number_literal" is not null and "template_expression_nodes"."number_literal" ~ '^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$') or
    ("template_expression_nodes"."kind" = 'text' and "template_expression_nodes"."text_literal" is not null) or ("template_expression_nodes"."kind" = 'boolean' and "template_expression_nodes"."boolean_literal" is not null) or
    ("template_expression_nodes"."kind" = 'field' and "template_expression_nodes"."reference_field_id" is not null and "template_expression_nodes"."reference_scope" in ('current', 'ancestor', 'descendants')) or
    ("template_expression_nodes"."kind" = 'unary' and "template_expression_nodes"."operator" in ('+', '-', '%')) or
    ("template_expression_nodes"."kind" = 'binary' and "template_expression_nodes"."operator" in ('+', '-', '*', '/', '^', '=', '<>', '<', '>', '<=', '>=')) or
    ("template_expression_nodes"."kind" = 'call' and "template_expression_nodes"."function_name" in ('ABS', 'MIN', 'MAX', 'ROUND', 'SUM', 'AVERAGE', 'IF'))
  ) and num_nonnulls("template_expression_nodes"."number_literal", "template_expression_nodes"."text_literal", "template_expression_nodes"."boolean_literal", "template_expression_nodes"."reference_field_id", "template_expression_nodes"."operator", "template_expression_nodes"."function_name") = 1 and ("template_expression_nodes"."kind" = 'field' or "template_expression_nodes"."reference_scope" is null))
);
--> statement-breakpoint
CREATE TABLE "template_expressions" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"field_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	CONSTRAINT "template_expressions_organization_id_version_id_id_pk" PRIMARY KEY("organization_id","version_id","id"),
	CONSTRAINT "template_expression_purpose_key" UNIQUE("organization_id","version_id","field_id","purpose"),
	CONSTRAINT "template_expression_purpose" CHECK ("template_expressions"."purpose" in ('calculate', 'visible', 'required'))
);
--> statement-breakpoint
CREATE TABLE "template_fields" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"column_id" uuid NOT NULL,
	"repeat_group_id" uuid,
	"widget" text NOT NULL,
	"value_type" text NOT NULL,
	"alias" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"placeholder" text DEFAULT '' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"editable" boolean DEFAULT false NOT NULL,
	"default_state" text DEFAULT 'absent' NOT NULL,
	"default_text" text,
	"default_number" numeric,
	"default_boolean" boolean,
	"default_date" date,
	CONSTRAINT "template_fields_organization_id_version_id_id_pk" PRIMARY KEY("organization_id","version_id","id"),
	CONSTRAINT "template_column_field_key" UNIQUE("organization_id","version_id","column_id"),
	CONSTRAINT "template_field_type_key" UNIQUE("organization_id","version_id","id","value_type"),
	CONSTRAINT "template_field_alias" CHECK ("template_fields"."alias" ~ '^[A-Za-z0-9_]*$' and length("template_fields"."alias") <= 200),
	CONSTRAINT "template_widget_type" CHECK (("template_fields"."widget" in ('text_widget', 'input_widget', 'paragraph_widget') and "template_fields"."value_type" = 'text') or ("template_fields"."widget" in ('number_widget', 'formula_widget') and "template_fields"."value_type" = 'numeric') or ("template_fields"."widget" = 'checkbox_widget' and "template_fields"."value_type" = 'boolean') or ("template_fields"."widget" = 'datepicker_widget' and "template_fields"."value_type" = 'date') or ("template_fields"."widget" = 'dropdown_widget' and "template_fields"."value_type" = 'option')),
	CONSTRAINT "template_field_default" CHECK (("template_fields"."default_state" in ('absent', 'empty') and num_nonnulls("template_fields"."default_text", "template_fields"."default_number", "template_fields"."default_boolean", "template_fields"."default_date") = 0) or ("template_fields"."default_state" = 'present' and num_nonnulls("template_fields"."default_text", "template_fields"."default_number", "template_fields"."default_boolean", "template_fields"."default_date") = 1 and (("template_fields"."value_type" = 'text' and "template_fields"."default_text" is not null) or ("template_fields"."value_type" = 'numeric' and "template_fields"."default_number" is not null and "template_fields"."default_number"::text not in ('NaN', 'Infinity', '-Infinity')) or ("template_fields"."value_type" = 'boolean' and "template_fields"."default_boolean" is not null) or ("template_fields"."value_type" = 'date' and "template_fields"."default_date" is not null))))
);
--> statement-breakpoint
CREATE TABLE "template_instances" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'editing' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_instances_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "template_instance_version_key" UNIQUE("organization_id","id","version_id"),
	CONSTRAINT "template_instance_state" CHECK ("template_instances"."revision" > 0 and "template_instances"."status" in ('editing', 'frozen'))
);
--> statement-breakpoint
CREATE TABLE "template_numeric_config" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value_type" text DEFAULT 'numeric' NOT NULL,
	"display_scale" integer,
	"pad_decimals" boolean DEFAULT false NOT NULL,
	"minimum" numeric,
	"maximum" numeric,
	CONSTRAINT "template_numeric_config_organization_id_version_id_field_id_pk" PRIMARY KEY("organization_id","version_id","field_id"),
	CONSTRAINT "numeric_config_type" CHECK ("template_numeric_config"."value_type" = 'numeric' and ("template_numeric_config"."display_scale" is null or "template_numeric_config"."display_scale" between 0 and 100) and ("template_numeric_config"."minimum" is null or "template_numeric_config"."maximum" is null or "template_numeric_config"."minimum" <= "template_numeric_config"."maximum") and coalesce("template_numeric_config"."minimum"::text, '') not in ('NaN', 'Infinity', '-Infinity') and coalesce("template_numeric_config"."maximum"::text, '') not in ('NaN', 'Infinity', '-Infinity'))
);
--> statement-breakpoint
CREATE TABLE "template_occurrences" (
	"organization_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid,
	"parent_id" uuid,
	"position" integer NOT NULL,
	"created_revision" integer NOT NULL,
	"removed_revision" integer,
	CONSTRAINT "template_occurrences_organization_id_instance_id_version_id_id_pk" PRIMARY KEY("organization_id","instance_id","version_id","id"),
	CONSTRAINT "template_occurrence_shape" CHECK (("template_occurrences"."group_id" is null and "template_occurrences"."parent_id" is null and "template_occurrences"."position" = 0 and "template_occurrences"."removed_revision" is null) or ("template_occurrences"."group_id" is not null and "template_occurrences"."parent_id" is not null and "template_occurrences"."parent_id" <> "template_occurrences"."id" and "template_occurrences"."position" >= 0)),
	CONSTRAINT "template_occurrence_revision" CHECK ("template_occurrences"."created_revision" > 0 and ("template_occurrences"."removed_revision" is null or "template_occurrences"."removed_revision" > "template_occurrences"."created_revision"))
);
--> statement-breakpoint
CREATE TABLE "template_options" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"value_type" text DEFAULT 'option' NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "template_options_organization_id_version_id_field_id_id_pk" PRIMARY KEY("organization_id","version_id","field_id","id"),
	CONSTRAINT "template_option_order_key" UNIQUE("organization_id","version_id","field_id","position"),
	CONSTRAINT "template_option_value_key" UNIQUE("organization_id","version_id","field_id","value"),
	CONSTRAINT "template_option_type" CHECK ("template_options"."value_type" = 'option' and "template_options"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "template_repeat_groups" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"parent_group_id" uuid,
	"section_id" uuid,
	"row_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"minimum" integer DEFAULT 1 NOT NULL,
	"maximum" integer DEFAULT 1000 NOT NULL,
	CONSTRAINT "template_repeat_groups_organization_id_version_id_id_pk" PRIMARY KEY("organization_id","version_id","id"),
	CONSTRAINT "repeat_section_key" UNIQUE("organization_id","version_id","section_id"),
	CONSTRAINT "repeat_row_key" UNIQUE("organization_id","version_id","row_id"),
	CONSTRAINT "repeat_definition_shape" CHECK (num_nonnulls("template_repeat_groups"."section_id", "template_repeat_groups"."row_id") = 1 and "template_repeat_groups"."source" = 'manual' and "template_repeat_groups"."minimum" between 0 and 1000 and "template_repeat_groups"."maximum" between greatest(1, "template_repeat_groups"."minimum") and 1000 and "template_repeat_groups"."parent_group_id" is distinct from "template_repeat_groups"."id")
);
--> statement-breakpoint
CREATE TABLE "template_rows" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"css_class" text DEFAULT '' NOT NULL,
	CONSTRAINT "template_rows_organization_id_version_id_id_pk" PRIMARY KEY("organization_id","version_id","id"),
	CONSTRAINT "template_row_position" CHECK ("template_rows"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "template_sections" (
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"parent_column_id" uuid,
	"position" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"css_class" text DEFAULT '' NOT NULL,
	"x" numeric DEFAULT '100' NOT NULL,
	"y" numeric DEFAULT '100' NOT NULL,
	"width" numeric DEFAULT '100' NOT NULL,
	"height" numeric DEFAULT '100' NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"is_header" boolean DEFAULT false NOT NULL,
	"is_footer" boolean DEFAULT false NOT NULL,
	"is_final_result" boolean DEFAULT false NOT NULL,
	"source_version_id" uuid,
	"source_section_id" uuid,
	CONSTRAINT "template_sections_organization_id_version_id_id_pk" PRIMARY KEY("organization_id","version_id","id"),
	CONSTRAINT "template_section_layout" CHECK ("template_sections"."position" >= 0 and "template_sections"."width" > 0 and "template_sections"."height" > 0 and abs("template_sections"."x") <= 100000 and abs("template_sections"."y") <= 100000 and "template_sections"."width" <= 100000 and "template_sections"."height" <= 100000),
	CONSTRAINT "template_section_provenance" CHECK (("template_sections"."source_version_id" is null) = ("template_sections"."source_section_id" is null))
);
--> statement-breakpoint
CREATE TABLE "template_values" (
	"organization_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"value_type" text NOT NULL,
	"state" text NOT NULL,
	"origin" text NOT NULL,
	"number_value" numeric,
	"text_value" text,
	"boolean_value" boolean,
	"date_value" date,
	"option_id" uuid,
	"lexical" text,
	"error_code" text,
	"error_message" text,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_values_organization_id_instance_id_field_id_occurrence_id_revision_pk" PRIMARY KEY("organization_id","instance_id","field_id","occurrence_id","revision"),
	CONSTRAINT "template_value_revision" CHECK ("template_values"."revision" > 0 and "template_values"."origin" in ('entered', 'calculated', 'default')),
	CONSTRAINT "template_value_payload" CHECK ((
    ("template_values"."state" in ('absent', 'empty', 'not_applicable', 'invalid') and num_nonnulls("template_values"."number_value", "template_values"."text_value", "template_values"."boolean_value", "template_values"."date_value", "template_values"."option_id") = 0) or
    ("template_values"."state" = 'present' and num_nonnulls("template_values"."number_value", "template_values"."text_value", "template_values"."boolean_value", "template_values"."date_value", "template_values"."option_id") = 1 and (
      ("template_values"."value_type" = 'numeric' and "template_values"."number_value" is not null and "template_values"."number_value"::text not in ('NaN', 'Infinity', '-Infinity')) or
      ("template_values"."value_type" = 'text' and "template_values"."text_value" is not null) or ("template_values"."value_type" = 'boolean' and "template_values"."boolean_value" is not null) or
      ("template_values"."value_type" = 'date' and "template_values"."date_value" is not null) or ("template_values"."value_type" = 'option' and "template_values"."option_id" is not null)
    ))) and (("template_values"."state" = 'invalid' and "template_values"."error_code" is not null and "template_values"."error_message" is not null) or ("template_values"."state" <> 'invalid' and "template_values"."error_code" is null and "template_values"."error_message" is null)))
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"semantics" text DEFAULT 'meteor-number-v1' NOT NULL,
	"source_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"frozen_at" timestamp with time zone,
	"frozen_by" uuid,
	CONSTRAINT "template_versions_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "template_version_number_key" UNIQUE("organization_id","template_id","number"),
	CONSTRAINT "template_version_state" CHECK (("template_versions"."status" = 'draft' and "template_versions"."frozen_at" is null and "template_versions"."frozen_by" is null) or ("template_versions"."status" = 'frozen' and "template_versions"."frozen_at" is not null and "template_versions"."frozen_by" is not null)),
	CONSTRAINT "template_version_metadata" CHECK ("template_versions"."number" > 0 and "template_versions"."revision" > 0 and length(trim("template_versions"."name")) between 1 and 200 and length("template_versions"."description") <= 10000 and "template_versions"."kind" in ('sample', 'datasheet', 'report', 'label', 'equipment_service_log') and "template_versions"."semantics" = 'meteor-number-v1')
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "templates_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "templates_code_length" CHECK (length(trim("templates"."code")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "template_columns" ADD CONSTRAINT "template_columns_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_columns" ADD CONSTRAINT "template_columns_organization_id_version_id_row_id_template_rows_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","row_id") REFERENCES "public"."template_rows"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_expression_nodes" ADD CONSTRAINT "template_expression_nodes_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_expression_nodes" ADD CONSTRAINT "expression_nodes_expression_fk" FOREIGN KEY ("organization_id","version_id","expression_id") REFERENCES "public"."template_expressions"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_expression_nodes" ADD CONSTRAINT "expression_nodes_reference_fk" FOREIGN KEY ("organization_id","version_id","reference_field_id") REFERENCES "public"."template_fields"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_expression_nodes" ADD CONSTRAINT "expression_nodes_parent_fk" FOREIGN KEY ("organization_id","version_id","expression_id","parent_index") REFERENCES "public"."template_expression_nodes"("organization_id","version_id","expression_id","node_index") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_expressions" ADD CONSTRAINT "template_expressions_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_expressions" ADD CONSTRAINT "template_expressions_organization_id_version_id_field_id_template_fields_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","field_id") REFERENCES "public"."template_fields"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_organization_id_version_id_column_id_template_columns_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","column_id") REFERENCES "public"."template_columns"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_organization_id_version_id_repeat_group_id_template_repeat_groups_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","repeat_group_id") REFERENCES "public"."template_repeat_groups"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_instances" ADD CONSTRAINT "template_instances_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_instances" ADD CONSTRAINT "template_instances_organization_id_created_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_numeric_config" ADD CONSTRAINT "template_numeric_config_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_numeric_config" ADD CONSTRAINT "template_numeric_config_organization_id_version_id_field_id_value_type_template_fields_organization_id_version_id_id_value_type_fk" FOREIGN KEY ("organization_id","version_id","field_id","value_type") REFERENCES "public"."template_fields"("organization_id","version_id","id","value_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_occurrences" ADD CONSTRAINT "template_occurrences_organization_id_instance_id_version_id_template_instances_organization_id_id_version_id_fk" FOREIGN KEY ("organization_id","instance_id","version_id") REFERENCES "public"."template_instances"("organization_id","id","version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_occurrences" ADD CONSTRAINT "template_occurrences_organization_id_version_id_group_id_template_repeat_groups_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","group_id") REFERENCES "public"."template_repeat_groups"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_occurrences" ADD CONSTRAINT "template_occurrence_parent_fk" FOREIGN KEY ("organization_id","instance_id","version_id","parent_id") REFERENCES "public"."template_occurrences"("organization_id","instance_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_options" ADD CONSTRAINT "template_options_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_options" ADD CONSTRAINT "template_options_organization_id_version_id_field_id_value_type_template_fields_organization_id_version_id_id_value_type_fk" FOREIGN KEY ("organization_id","version_id","field_id","value_type") REFERENCES "public"."template_fields"("organization_id","version_id","id","value_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_repeat_groups" ADD CONSTRAINT "template_repeat_groups_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_repeat_groups" ADD CONSTRAINT "template_repeat_groups_organization_id_version_id_section_id_template_sections_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","section_id") REFERENCES "public"."template_sections"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_repeat_groups" ADD CONSTRAINT "template_repeat_groups_organization_id_version_id_row_id_template_rows_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","row_id") REFERENCES "public"."template_rows"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_repeat_groups" ADD CONSTRAINT "template_repeat_groups_organization_id_version_id_parent_group_id_template_repeat_groups_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","parent_group_id") REFERENCES "public"."template_repeat_groups"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_rows" ADD CONSTRAINT "template_rows_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_rows" ADD CONSTRAINT "template_rows_organization_id_version_id_section_id_template_sections_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","version_id","section_id") REFERENCES "public"."template_sections"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_sections" ADD CONSTRAINT "template_sections_organization_id_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_sections" ADD CONSTRAINT "section_parent_column_fk" FOREIGN KEY ("organization_id","version_id","parent_column_id") REFERENCES "public"."template_columns"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_sections" ADD CONSTRAINT "template_sections_organization_id_source_version_id_source_section_id_template_sections_organization_id_version_id_id_fk" FOREIGN KEY ("organization_id","source_version_id","source_section_id") REFERENCES "public"."template_sections"("organization_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_values_organization_id_instance_id_version_id_template_instances_organization_id_id_version_id_fk" FOREIGN KEY ("organization_id","instance_id","version_id") REFERENCES "public"."template_instances"("organization_id","id","version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_value_field_type_fk" FOREIGN KEY ("organization_id","version_id","field_id","value_type") REFERENCES "public"."template_fields"("organization_id","version_id","id","value_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_value_occurrence_fk" FOREIGN KEY ("organization_id","instance_id","version_id","occurrence_id") REFERENCES "public"."template_occurrences"("organization_id","instance_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_value_option_fk" FOREIGN KEY ("organization_id","version_id","field_id","option_id") REFERENCES "public"."template_options"("organization_id","version_id","field_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_values" ADD CONSTRAINT "template_values_organization_id_saved_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","saved_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_organization_id_template_id_templates_organization_id_id_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."templates"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_organization_id_source_version_id_template_versions_organization_id_id_fk" FOREIGN KEY ("organization_id","source_version_id") REFERENCES "public"."template_versions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_organization_id_created_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_organization_id_frozen_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","frozen_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_organization_id_created_by_memberships_organization_id_user_id_fk" FOREIGN KEY ("organization_id","created_by") REFERENCES "public"."memberships"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_columns_order" ON "template_columns" USING btree ("organization_id","version_id","row_id","position");--> statement-breakpoint
CREATE INDEX "expression_dependencies" ON "template_expression_nodes" USING btree ("organization_id","version_id","reference_field_id");--> statement-breakpoint
CREATE INDEX "template_fields_alias" ON "template_fields" USING btree ("organization_id","version_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "template_root_occurrence_key" ON "template_occurrences" USING btree ("organization_id","instance_id") WHERE "template_occurrences"."group_id" is null;--> statement-breakpoint
CREATE INDEX "template_occurrences_order" ON "template_occurrences" USING btree ("organization_id","instance_id","parent_id","group_id","position");--> statement-breakpoint
CREATE INDEX "template_rows_order" ON "template_rows" USING btree ("organization_id","version_id","section_id","position");--> statement-breakpoint
CREATE INDEX "template_sections_order" ON "template_sections" USING btree ("organization_id","version_id","parent_column_id","position");--> statement-breakpoint
CREATE INDEX "template_value_latest" ON "template_values" USING btree ("organization_id","instance_id","field_id","occurrence_id","revision" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "template_one_draft_key" ON "template_versions" USING btree ("organization_id","template_id") WHERE "template_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "templates_code_key" ON "templates" USING btree ("organization_id",lower("code"));