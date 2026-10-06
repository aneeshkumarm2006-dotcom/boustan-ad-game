ALTER TABLE "campaign_settings" ADD COLUMN "alert_emails" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_settings" ADD COLUMN "retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "rewards" ADD COLUMN "alert_thresholds" integer[] DEFAULT '{20,5}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "rewards" ADD COLUMN "alert_level" smallint;--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin_audit" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "campaign_settings" ADD CONSTRAINT "campaign_settings_retention_check" CHECK ("campaign_settings"."retention_days" >= 0);