ALTER TABLE "templates" ADD COLUMN "print_page_size" text DEFAULT 'A4' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_scale" numeric DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_x_margin" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_landscape" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_header" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_footer" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_header_alignment" text DEFAULT 'center' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_footer_alignment" text DEFAULT 'center' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_non_nabl_top_margin" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_non_nabl_bottom_margin" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_nabl_top_margin" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_nabl_bottom_margin" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_custom_top_non_nabl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_custom_bottom_non_nabl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_custom_top_nabl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "print_custom_bottom_nabl" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "template_rows" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "template_rows" ADD COLUMN "keep_together" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "template_columns" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "template_columns" ADD COLUMN "index_value" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "template_columns" ADD COLUMN "master_value" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "template_columns" ADD COLUMN "width_mm" numeric;--> statement-breakpoint
ALTER TABLE "template_columns" ADD COLUMN "height_mm" numeric;--> statement-breakpoint
ALTER TABLE "template_columns" ADD COLUMN "show_in_coa" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "template_columns" ADD COLUMN "show_in_template" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_print_config" CHECK ("templates"."print_page_size" in ('A3','A4','A5','Letter','Legal') and "templates"."print_scale" between 0.1 and 1 and "templates"."print_x_margin" between 0 and 500
    and "templates"."print_header_alignment" in ('left','center','right') and "templates"."print_footer_alignment" in ('left','center','right')
    and "templates"."print_non_nabl_top_margin" between 0 and 2000 and "templates"."print_non_nabl_bottom_margin" between 0 and 2000
    and "templates"."print_nabl_top_margin" between 0 and 2000 and "templates"."print_nabl_bottom_margin" between 0 and 2000);--> statement-breakpoint
ALTER TABLE "template_columns" DROP CONSTRAINT "template_column_layout";--> statement-breakpoint
ALTER TABLE "template_columns" ADD CONSTRAINT "template_column_layout" CHECK ("template_columns"."position" >= 0 and "template_columns"."span" between 0 and 12 and "template_columns"."index_value" in ('','-1','-2','-3','-4','-5','-6','-7','-8','-9','-10','-11','-12')
    and length("template_columns"."master_value") <= 200 and ("template_columns"."width_mm" is null or "template_columns"."width_mm" between 0.001 and 1000) and ("template_columns"."height_mm" is null or "template_columns"."height_mm" between 0.001 and 1000));
