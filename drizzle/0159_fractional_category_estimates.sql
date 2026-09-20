-- Meteor normalizes category estimates with Number and accepts finite fractions.
-- Every existing int4 estimate is exactly representable as double precision.
ALTER TABLE "sample_categories" ALTER COLUMN "estimated_time_in_days"
  TYPE double precision USING "estimated_time_in_days"::double precision;
--> statement-breakpoint
ALTER TABLE "sample_categories" ADD CONSTRAINT "sample_categories_estimate_finite"
  CHECK ("estimated_time_in_days" NOT IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision));
