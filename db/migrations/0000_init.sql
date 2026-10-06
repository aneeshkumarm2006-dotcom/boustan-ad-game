CREATE TABLE "admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_email" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "best_runs" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"garlic" integer NOT NULL,
	"hits" integer NOT NULL,
	"distance_m" double precision NOT NULL,
	"achieved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"claims_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "campaign_settings_singleton" CHECK ("campaign_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"reward_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"code_id" bigint,
	"expires_at" timestamp with time zone,
	"email_status" text DEFAULT 'pending' NOT NULL,
	"src" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reward_id" text NOT NULL,
	"code" text NOT NULL,
	"batch" text,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'available' NOT NULL,
	"claim_id" uuid,
	"assigned_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codes_status_check" CHECK ("codes"."status" in ('available', 'assigned', 'redeemed', 'void'))
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"granted" boolean NOT NULL,
	"text" text NOT NULL,
	"text_version" text NOT NULL,
	"language" text NOT NULL,
	"source" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"host_origin" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_kind_check" CHECK ("consents"."kind" in ('terms_age', 'marketing'))
);
--> statement-breakpoint
CREATE TABLE "crm_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"claim_ids" uuid[] NOT NULL,
	"language" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"provider_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" text,
	"name" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"src" text,
	"lang" text,
	"device" text,
	"host_origin" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events_daily" (
	"day" date NOT NULL,
	"name" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"src" text DEFAULT '' NOT NULL,
	"lang" text DEFAULT '' NOT NULL,
	"device" text DEFAULT '' NOT NULL,
	"events" integer NOT NULL,
	"sessions" integer NOT NULL,
	CONSTRAINT "events_daily_day_name_detail_src_lang_device_pk" PRIMARY KEY("day","name","detail","src","lang","device")
);
--> statement-breakpoint
CREATE TABLE "player_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"nickname" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"language" text NOT NULL,
	"age_confirmed_at" timestamp with time zone,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"first_src" text,
	"first_host" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email_blocked_at" timestamp with time zone,
	"email_block_reason" text,
	"crm_status" text DEFAULT 'pending' NOT NULL,
	"crm_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rewards" (
	"id" text PRIMARY KEY NOT NULL,
	"names" jsonb NOT NULL,
	"terms" jsonb NOT NULL,
	"rule" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"validity_days" integer,
	"valid_until" timestamp with time zone,
	"max_per_player" smallint DEFAULT 1 NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_max_per_player_check" CHECK ("rewards"."max_per_player" = 1)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seed" bigint NOT NULL,
	"player_id" uuid,
	"src" text,
	"host_origin" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" text,
	"rules" jsonb NOT NULL,
	"tuning_version" smallint NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_ms" integer NOT NULL,
	"distance_m" double precision NOT NULL,
	"garlic" integer NOT NULL,
	"hits" integer NOT NULL,
	"status" text NOT NULL,
	"flag_reason" text,
	"client_version" text,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('valid', 'flagged'))
);
--> statement-breakpoint
ALTER TABLE "best_runs" ADD CONSTRAINT "best_runs_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "best_runs" ADD CONSTRAINT "best_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."rewards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_code_id_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codes" ADD CONSTRAINT "codes_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."rewards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_outbox" ADD CONSTRAINT "crm_outbox_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_tokens" ADD CONSTRAINT "player_tokens_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "best_runs_rank_idx" ON "best_runs" USING btree ("garlic" DESC NULLS LAST,"hits","distance_m" DESC NULLS LAST,"achieved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_player_reward_key" ON "claims" USING btree ("player_id","reward_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_code_key" ON "claims" USING btree ("code_id");--> statement-breakpoint
CREATE INDEX "claims_run_idx" ON "claims" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "codes_code_key" ON "codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "codes_available_idx" ON "codes" USING btree ("reward_id","id") WHERE "codes"."status" = 'available';--> statement-breakpoint
CREATE INDEX "consents_player_idx" ON "consents" USING btree ("player_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_outbox_idempotency_key" ON "crm_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "crm_outbox_due_idx" ON "crm_outbox" USING btree ("next_attempt_at") WHERE "crm_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("next_attempt_at") WHERE "email_outbox"."status" in ('pending', 'retry', 'sending');--> statement-breakpoint
CREATE INDEX "email_outbox_provider_idx" ON "email_outbox" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "email_outbox_player_idx" ON "email_outbox" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "events_created_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "player_tokens_player_idx" ON "player_tokens" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_email_normalized_key" ON "players" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "runs_player_idx" ON "runs" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "runs_flagged_idx" ON "runs" USING btree ("finished_at") WHERE "runs"."status" = 'flagged';