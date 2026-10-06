/**
 * Database schema (PRD §15.2), Postgres through Drizzle. Migrations in ./migrations are
 * generated from this file (`npm run db:generate`); the consent-log trigger, CHECK constraints
 * on enums and the reporting views live in hand-written migrations next to them.
 *
 * Additions to §15.2:
 * - `player_tokens`: one row per device, so a second host site or phone gets its own token
 *   without signing the first one out (§3.4). Only SHA-256 hashes are stored (DATA-01).
 * - `best_runs`: each player's best validated run, which the leaderboard reads (LB-02).
 * - `campaign_settings`: dates and the global claims switch, editable without a redeploy (ADM-07).
 * - `email_outbox`: coupon emails waiting to be sent or retried (MAIL-02, MAIL-07).
 * - `events_daily`: the daily analytics rollup (AN-02).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const tstz = (name: string) => timestamp(name, { withTimezone: true });

export type Utm = Partial<
  Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_content", string>
>;
/** Thresholds a run was started under (ADM-07: setting changes apply to new runs only). */
export interface RunRules {
  distanceM: number;
  garlic: number;
}
export type Localized = { fr: string; en: string };
export type RewardRule = { distanceM: number } | { garlic: number };

// ---------------------------------------------------------------------------------------------
// Players and consent
// ---------------------------------------------------------------------------------------------

export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** As typed; the only address emails go to (RWD-05, MAIL-08). */
    email: text("email").notNull(),
    /** One claim per person per reward (SEC-07). Anonymized when a player is deleted. */
    emailNormalized: text("email_normalized").notNull(),
    nickname: text("nickname"),
    /** Moderated off the leaderboard; stays hidden if they come back with the same email (LB-07). */
    hidden: boolean("hidden").notNull().default(false),
    language: text("language").notNull(),
    ageConfirmedAt: tstz("age_confirmed_at"),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    firstSrc: text("first_src"),
    firstHost: text("first_host"),
    utm: jsonb("utm").$type<Utm>().notNull().default({}),
    /** Set by a hard bounce, complaint or suppression; no email is sent after that (MAIL-07). */
    emailBlockedAt: tstz("email_blocked_at"),
    emailBlockReason: text("email_block_reason"),
    /** pending | synced | failed | skipped (DATA-02, CRM-05). */
    crmStatus: text("crm_status").notNull().default("pending"),
    crmSyncedAt: tstz("crm_synced_at"),
    createdAt: createdAt(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
    deletedAt: tstz("deleted_at"),
  },
  (t) => [uniqueIndex("players_email_normalized_key").on(t.emailNormalized)],
);

export const playerTokens = pgTable(
  "player_tokens",
  {
    /** SHA-256 of the token, hex. The token itself only lives on the device. */
    tokenHash: text("token_hash").primaryKey(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    createdAt: createdAt(),
    lastUsedAt: tstz("last_used_at").notNull().defaultNow(),
  },
  (t) => [index("player_tokens_player_idx").on(t.playerId)],
);

/**
 * Append-only proof of consent (DATA-03, CASL). A trigger rejects UPDATE and DELETE; the
 * retention job (DATA-06) is the only thing allowed to delete, and it has to say so.
 */
export const consents = pgTable(
  "consents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    /** terms_age | marketing */
    kind: text("kind").notNull(),
    granted: boolean("granted").notNull(),
    /** Exactly what the player saw, without markup. */
    text: text("text").notNull(),
    textVersion: text("text_version").notNull(),
    language: text("language").notNull(),
    /** claim_form | unsubscribe | complaint */
    source: text("source").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    hostOrigin: text("host_origin"),
    createdAt: createdAt(),
  },
  (t) => [
    index("consents_player_idx").on(t.playerId, t.createdAt),
    check("consents_kind_check", sql`${t.kind} in ('terms_age', 'marketing')`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Runs and the leaderboard
// ---------------------------------------------------------------------------------------------

export const runs = pgTable(
  "runs",
  {
    /** The runId from the run token. Written once, on finish; the key blocks reuse (SEC-01). */
    id: uuid("id").primaryKey(),
    seed: bigint("seed", { mode: "number" }).notNull(),
    playerId: uuid("player_id").references(() => players.id),
    src: text("src"),
    hostOrigin: text("host_origin"),
    utm: jsonb("utm").$type<Utm>().notNull().default({}),
    language: text("language"),
    rules: jsonb("rules").$type<RunRules>().notNull(),
    tuningVersion: smallint("tuning_version").notNull(),
    issuedAt: tstz("issued_at").notNull(),
    finishedAt: tstz("finished_at").notNull().defaultNow(),
    activeMs: integer("active_ms").notNull(),
    distanceM: doublePrecision("distance_m").notNull(),
    garlic: integer("garlic").notNull(),
    hits: integer("hits").notNull(),
    /** valid | flagged (SEC-03) */
    status: text("status").notNull(),
    flagReason: text("flag_reason"),
    clientVersion: text("client_version"),
    /** Set when its claim token is spent, so each token works once (SEC-04). */
    claimedAt: tstz("claimed_at"),
  },
  (t) => [
    index("runs_player_idx").on(t.playerId),
    index("runs_flagged_idx")
      .on(t.finishedAt)
      .where(sql`${t.status} = 'flagged'`),
    check("runs_status_check", sql`${t.status} in ('valid', 'flagged')`),
  ],
);

/** Each player's best validated run under the leaderboard order (LB-01, LB-02). */
export const bestRuns = pgTable(
  "best_runs",
  {
    playerId: uuid("player_id")
      .primaryKey()
      .references(() => players.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    garlic: integer("garlic").notNull(),
    hits: integer("hits").notNull(),
    distanceM: doublePrecision("distance_m").notNull(),
    /** Ties go to whoever got there first (LB-01). */
    achievedAt: tstz("achieved_at").notNull(),
  },
  (t) => [
    index("best_runs_rank_idx").on(
      t.garlic.desc(),
      t.hits.asc(),
      t.distanceM.desc(),
      t.achievedAt.asc(),
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Campaign, rewards and codes
// ---------------------------------------------------------------------------------------------

/** One row (id = 1). Edited from SQL or `npm run campaign` until the admin exists (SEC-08). */
export const campaignSettings = pgTable(
  "campaign_settings",
  {
    id: smallint("id").primaryKey().default(1),
    startsAt: tstz("starts_at"),
    endsAt: tstz("ends_at"),
    /** Global kill switch (SEC-08). Off until someone turns the campaign on. */
    claimsEnabled: boolean("claims_enabled").notNull().default(false),
    /** Who gets the low-stock emails (RWD-04, ADM-03). Blank: ADMIN_EMAILS. */
    alertEmails: text("alert_emails")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Days after the campaign ends before players who didn't opt in are anonymized (DATA-06). */
    retentionDays: integer("retention_days").notNull().default(90),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    check("campaign_settings_singleton", sql`${t.id} = 1`),
    check("campaign_settings_retention_check", sql`${t.retentionDays} >= 0`),
  ],
);

/** Reward catalogue (§5.1). Player-facing names and terms come from the i18n files. */
export const rewards = pgTable(
  "rewards",
  {
    /** free_coke | free_garlic_sauce (game-core REWARD_IDS) */
    id: text("id").primaryKey(),
    names: jsonb("names").$type<Localized>().notNull(),
    terms: jsonb("terms").$type<Localized>().notNull(),
    /** The unlock threshold for new runs (ADM-07). */
    rule: jsonb("rule").$type<RewardRule>().notNull(),
    /** Per-reward kill switch (SEC-08). */
    active: boolean("active").notNull().default(true),
    /** Codes expire this many days after they're issued, unless the code has its own date. */
    validityDays: integer("validity_days"),
    /** Or on this fixed date. */
    validUntil: tstz("valid_until"),
    /** Claims per player per campaign. The unique index on claims enforces 1. */
    maxPerPlayer: smallint("max_per_player").notNull().default(1),
    /** Low-stock emails go out when codes left fall to these percentages of the pool (RWD-04). */
    alertThresholds: integer("alert_thresholds")
      .array()
      .notNull()
      .default(sql`'{20,5}'::integer[]`),
    /** The lowest threshold already announced, so each one sends once until stock is added. */
    alertLevel: smallint("alert_level"),
    sortOrder: smallint("sort_order").notNull().default(0),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("rewards_max_per_player_check", sql`${t.maxPerPlayer} = 1`)],
);

/** Single-use codes imported from uEat (RWD-01). The pool size is the budget (RWD-04). */
export const codes = pgTable(
  "codes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    rewardId: text("reward_id")
      .notNull()
      .references(() => rewards.id),
    code: text("code").notNull(),
    batch: text("batch"),
    expiresAt: tstz("expires_at"),
    /** available | assigned | redeemed | void */
    status: text("status").notNull().default("available"),
    claimId: uuid("claim_id"),
    assignedAt: tstz("assigned_at"),
    redeemedAt: tstz("redeemed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("codes_code_key").on(t.code),
    // The claim transaction takes the lowest available id with FOR UPDATE SKIP LOCKED (RWD-03).
    index("codes_available_idx")
      .on(t.rewardId, t.id)
      .where(sql`${t.status} = 'available'`),
    check("codes_status_check", sql`${t.status} in ('available', 'assigned', 'redeemed', 'void')`),
  ],
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    rewardId: text("reward_id")
      .notNull()
      .references(() => rewards.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    /** Set in the same transaction, right after the row is created. */
    codeId: bigint("code_id", { mode: "number" }).references(() => codes.id),
    expiresAt: tstz("expires_at"),
    /** pending | sent | failed | blocked */
    emailStatus: text("email_status").notNull().default("pending"),
    src: text("src"),
    utm: jsonb("utm").$type<Utm>().notNull().default({}),
    language: text("language").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // One claim per normalized email per reward (SEC-07, RWD-05).
    uniqueIndex("claims_player_reward_key").on(t.playerId, t.rewardId),
    uniqueIndex("claims_code_key").on(t.codeId),
    index("claims_run_idx").on(t.runId),
  ],
);

// ---------------------------------------------------------------------------------------------
// Outboxes
// ---------------------------------------------------------------------------------------------

/** Coupon emails (MAIL-02, MAIL-05, MAIL-07). One row per email, not per code. */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    /** coupon | resend */
    kind: text("kind").notNull(),
    claimIds: uuid("claim_ids").array().notNull(),
    language: text("language").notNull(),
    /** pending | sending | retry | sent | failed | blocked */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    /** A sender holds the row until then, so the cron and after() never send it twice. */
    leaseUntil: tstz("lease_until"),
    providerId: text("provider_id"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: tstz("sent_at"),
  },
  (t) => [
    index("email_outbox_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('pending', 'retry', 'sending')`),
    index("email_outbox_provider_idx").on(t.providerId),
    index("email_outbox_player_idx").on(t.playerId),
  ],
);

/** CRM sync queue (CRM-05). Written in the claim and consent transactions; delivered in Stage 3. */
export const crmOutbox = pgTable(
  "crm_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    /** contact_upsert | reward_claimed | consent_changed */
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** pending | sent | failed | skipped */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: tstz("sent_at"),
  },
  (t) => [
    uniqueIndex("crm_outbox_idempotency_key").on(t.idempotencyKey),
    index("crm_outbox_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Analytics and audit
// ---------------------------------------------------------------------------------------------

/** First-party analytics (AN-01). No personal data: names, small props, placement and device. */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** In-memory client session; null for server events. */
    sessionId: text("session_id"),
    name: text("name").notNull(),
    props: jsonb("props").$type<Record<string, string | number | boolean>>().notNull().default({}),
    src: text("src"),
    lang: text("lang"),
    /** mobile | tablet | desktop */
    device: text("device"),
    hostOrigin: text("host_origin"),
    createdAt: createdAt(),
  },
  (t) => [index("events_created_idx").on(t.createdAt)],
);

/** Daily counts per event and dimension (AN-02), refreshed by /api/cron/rollup. */
export const eventsDaily = pgTable(
  "events_daily",
  {
    /** Montréal calendar day. */
    day: date("day", { mode: "string" }).notNull(),
    name: text("name").notNull(),
    /** One prop that splits the event: milestone m, reward, cta target, error reason. */
    detail: text("detail").notNull().default(""),
    src: text("src").notNull().default(""),
    lang: text("lang").notNull().default(""),
    device: text("device").notNull().default(""),
    events: integer("events").notNull(),
    sessions: integer("sessions").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.name, t.detail, t.src, t.lang, t.device] })],
);

/** Every admin action, including CLI changes to campaign settings (SEC-09). */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    adminEmail: text("admin_email").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("admin_audit_created_idx").on(t.createdAt)],
);
