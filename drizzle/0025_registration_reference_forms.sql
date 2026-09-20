CREATE TABLE "product_tags" (
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "product_tags_organization_id_product_id_tag_id_pk" PRIMARY KEY("organization_id","product_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "tags_metadata" CHECK (length(trim("tags"."code")) between 1 and 64 and length(trim("tags"."name")) between 1 and 250 and "tags"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "customer_addresses" ALTER COLUMN "line_1" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_addresses" ALTER COLUMN "city" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_addresses" ALTER COLUMN "country_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD COLUMN "freeform_address" text;--> statement-breakpoint
ALTER TABLE "sample_products" ADD COLUMN "tag_id" uuid;--> statement-breakpoint
ALTER TABLE "product_tags" ADD CONSTRAINT "product_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tags" ADD CONSTRAINT "product_tags_organization_id_product_id_products_organization_id_id_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tags" ADD CONSTRAINT "product_tags_organization_id_tag_id_tags_organization_id_id_fk" FOREIGN KEY ("organization_id","tag_id") REFERENCES "public"."tags"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_code_key" ON "tags" USING btree ("organization_id",lower("code"));--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_products_organization_id_tag_id_tags_organization_id_id_fk" FOREIGN KEY ("organization_id","tag_id") REFERENCES "public"."tags"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_address_representation" CHECK (("customer_addresses"."freeform_address" is not null and length(trim("customer_addresses"."freeform_address")) between 1 and 4000
    and num_nonnulls("customer_addresses"."attention_to", "customer_addresses"."line_1", "customer_addresses"."line_2", "customer_addresses"."city", "customer_addresses"."state", "customer_addresses"."postal_code", "customer_addresses"."country_code") = 0)
    or ("customer_addresses"."freeform_address" is null and "customer_addresses"."line_1" is not null and "customer_addresses"."city" is not null and "customer_addresses"."country_code" is not null));--> statement-breakpoint
ALTER TABLE "sample_products" ADD CONSTRAINT "sample_product_tag" CHECK ("sample_products"."tag_id" is null or ("sample_products"."tag" is not null and length(trim("sample_products"."tag")) between 1 and 250));