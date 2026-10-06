/**
 * Database schema (PRD §15.2), MongoDB through the official driver. Collections, indexes and
 * validators are created by `npm run db:migrate` (see ./migrations.ts); this file is their single
 * source of truth.
 *
 * MongoDB has no column defaults, so every `new*` builder below fills them in. Insert through the
 * builders and a document always carries every field, with `null` for "no value".
 *
 * Ids: players, runs, claims and emails use a UUID string as `_id`. Codes, consents and the
 * outboxes use an ObjectId, which sorts in insertion order (the oldest code goes first, RWD-03).
 * Player tokens use the token hash as `_id` and best runs use the player's id, so the database
 * itself keeps them to one per token and one per player.
 *
 * Additions to §15.2:
 * - `player_tokens`: one row per device, so a second host site or phone gets its own token
 *   without signing the first one out (§3.4). Only SHA-256 hashes are stored (DATA-01).
 * - `best_runs`: each player's best validated run, which the leaderboard reads (LB-02).
 * - `campaign_settings`: dates and the global claims switch, editable without a redeploy (ADM-07).
 * - `email_outbox`: coupon emails waiting to be sent or retried (MAIL-02, MAIL-07).
 * - `events_daily`: the daily analytics rollup (AN-02).
 */
import { randomUUID } from "node:crypto";
import { ObjectId, type CreateIndexesOptions, type Document } from "mongodb";

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

/** Collection names by the key the app uses for them (`db.players`, `tx.bestRuns`...). */
export const COLLECTIONS = {
  players: "players",
  playerTokens: "player_tokens",
  consents: "consents",
  runs: "runs",
  bestRuns: "best_runs",
  campaignSettings: "campaign_settings",
  rewards: "rewards",
  codes: "codes",
  claims: "claims",
  emailOutbox: "email_outbox",
  crmOutbox: "crm_outbox",
  events: "events",
  eventsDaily: "events_daily",
  adminAudit: "admin_audit",
} as const;
export type CollectionKey = keyof typeof COLLECTIONS;

/**
 * Stands in for "no expiry" when an aggregation compares a code's `expiresAt`, which is null
 * for codes that never expire: `{ $ifNull: ["$expiresAt", NO_EXPIRY] }` then compares as a date.
 */
export const NO_EXPIRY = new Date(8.64e15);

// ---------------------------------------------------------------------------------------------
// Players and consent
// ---------------------------------------------------------------------------------------------

export interface PlayerDoc {
  _id: string;
  /** As typed; the only address emails go to (RWD-05, MAIL-08). */
  email: string;
  /** One claim per person per reward (SEC-07). Anonymized when a player is deleted. */
  emailNormalized: string;
  nickname: string | null;
  /** Moderated off the leaderboard; stays hidden if they come back with the same email (LB-07). */
  hidden: boolean;
  language: string;
  ageConfirmedAt: Date | null;
  marketingOptIn: boolean;
  firstSrc: string | null;
  firstHost: string | null;
  utm: Utm;
  /** Set by a hard bounce, complaint or suppression; no email is sent after that (MAIL-07). */
  emailBlockedAt: Date | null;
  emailBlockReason: string | null;
  /** pending | synced | failed | skipped (DATA-02, CRM-05). */
  crmStatus: string;
  crmSyncedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
  deletedAt: Date | null;
}

export interface PlayerTokenDoc {
  /** SHA-256 of the token, hex. The token itself only lives on the device. */
  _id: string;
  playerId: string;
  createdAt: Date;
  lastUsedAt: Date;
}

/**
 * Append-only proof of consent (DATA-03, CASL). Nothing in the app updates a row; only erasing a
 * player (DATA-07) or the retention job (DATA-06) deletes. The app's database user gets no
 * `update` on this collection (db/roles.ts).
 */
export interface ConsentDoc {
  _id: ObjectId;
  playerId: string;
  /** terms_age | marketing */
  kind: string;
  granted: boolean;
  /** Exactly what the player saw, without markup. */
  text: string;
  textVersion: string;
  language: string;
  /** claim_form | unsubscribe | complaint */
  source: string;
  ip: string | null;
  userAgent: string | null;
  hostOrigin: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------------------------
// Runs and the leaderboard
// ---------------------------------------------------------------------------------------------

export interface RunDoc {
  /** The runId from the run token. Written once, on finish; the key blocks reuse (SEC-01). */
  _id: string;
  seed: number;
  playerId: string | null;
  src: string | null;
  hostOrigin: string | null;
  utm: Utm;
  language: string | null;
  rules: RunRules;
  tuningVersion: number;
  issuedAt: Date;
  finishedAt: Date;
  activeMs: number;
  distanceM: number;
  garlic: number;
  hits: number;
  /** valid | flagged (SEC-03) */
  status: string;
  flagReason: string | null;
  clientVersion: string | null;
  /** Set when its claim token is spent, so each token works once (SEC-04). */
  claimedAt: Date | null;
}

/** Each player's best validated run under the leaderboard order (LB-01, LB-02). */
export interface BestRunDoc {
  /** The player's id: one best run per player. */
  _id: string;
  runId: string;
  garlic: number;
  hits: number;
  distanceM: number;
  /** Ties go to whoever got there first (LB-01). */
  achievedAt: Date;
}

// ---------------------------------------------------------------------------------------------
// Campaign, rewards and codes
// ---------------------------------------------------------------------------------------------

/** One document (_id = 1). Edited from the admin or `npm run campaign` (SEC-08). */
export interface CampaignSettingsDoc {
  _id: number;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Global kill switch (SEC-08). Off until someone turns the campaign on. */
  claimsEnabled: boolean;
  /** Who gets the low-stock emails (RWD-04, ADM-03). Blank: ADMIN_EMAILS. */
  alertEmails: string[];
  /** Days after the campaign ends before players who didn't opt in are anonymized (DATA-06). */
  retentionDays: number;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Reward catalogue (§5.1). Player-facing names and terms come from the i18n files. */
export interface RewardDoc {
  /** free_coke | free_garlic_sauce (game-core REWARD_IDS) */
  _id: string;
  names: Localized;
  terms: Localized;
  /** The unlock threshold for new runs (ADM-07). */
  rule: RewardRule;
  /** Per-reward kill switch (SEC-08). */
  active: boolean;
  /** Codes expire this many days after they're issued, unless the code has its own date. */
  validityDays: number | null;
  /** Or on this fixed date. */
  validUntil: Date | null;
  /** Claims per player per campaign. The unique index on claims enforces 1. */
  maxPerPlayer: number;
  /** Low-stock emails go out when codes left fall to these percentages of the pool (RWD-04). */
  alertThresholds: number[];
  /** The lowest threshold already announced, so each one sends once until stock is added. */
  alertLevel: number | null;
  sortOrder: number;
  updatedAt: Date;
}

/** Single-use codes imported from uEat (RWD-01). The pool size is the budget (RWD-04). */
export interface CodeDoc {
  _id: ObjectId;
  rewardId: string;
  code: string;
  batch: string | null;
  expiresAt: Date | null;
  /** available | assigned | redeemed | void */
  status: string;
  claimId: string | null;
  assignedAt: Date | null;
  redeemedAt: Date | null;
  createdAt: Date;
}

export interface ClaimDoc {
  _id: string;
  playerId: string;
  rewardId: string;
  runId: string;
  /** Set in the same transaction, right after the claim is created. */
  codeId: ObjectId | null;
  expiresAt: Date | null;
  /** pending | sent | failed | blocked */
  emailStatus: string;
  src: string | null;
  utm: Utm;
  language: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------------------------
// Outboxes
// ---------------------------------------------------------------------------------------------

/** Coupon emails (MAIL-02, MAIL-05, MAIL-07). One document per email, not per code. */
export interface EmailOutboxDoc {
  _id: string;
  playerId: string;
  /** coupon | resend */
  kind: string;
  claimIds: string[];
  language: string;
  /** pending | sending | retry | sent | failed | blocked */
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  /** A sender holds the document until then, so the cron and after() never send it twice. */
  leaseUntil: Date | null;
  providerId: string | null;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

/** CRM sync queue (CRM-05). Written in the claim and consent transactions; delivered in Stage 3. */
export interface CrmOutboxDoc {
  _id: ObjectId;
  playerId: string;
  /** contact_upsert | reward_claimed | consent_changed */
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  /** pending | sent | failed | skipped */
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

// ---------------------------------------------------------------------------------------------
// Analytics and audit
// ---------------------------------------------------------------------------------------------

/** First-party analytics (AN-01). No personal data: names, small props, placement and device. */
export interface EventDoc {
  _id: ObjectId;
  /** In-memory client session; null for server events. */
  sessionId: string | null;
  name: string;
  props: Record<string, string | number | boolean>;
  src: string | null;
  lang: string | null;
  /** mobile | tablet | desktop */
  device: string | null;
  hostOrigin: string | null;
  createdAt: Date;
}

/** Daily counts per event and dimension (AN-02), refreshed by /api/cron/rollup. */
export interface EventsDailyDoc {
  _id: ObjectId;
  /** Montréal calendar day, YYYY-MM-DD. */
  day: string;
  name: string;
  /** One prop that splits the event: milestone m, reward, cta target, error reason. */
  detail: string;
  src: string;
  lang: string;
  device: string;
  events: number;
  sessions: number;
}

/** Every admin action, including CLI changes to campaign settings (SEC-09). */
export interface AdminAuditDoc {
  _id: ObjectId;
  adminEmail: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

// ---------------------------------------------------------------------------------------------
// Builders: a full document from the fields that matter, with the defaults filled in
// ---------------------------------------------------------------------------------------------

/** `Req` fields are required; the rest are optional overrides. `_id` is optional where generated. */
type Init<T, Req extends keyof T> = Pick<T, Req> & Partial<Omit<T, Req>>;

/** Defaults first, then the overrides that aren't `undefined`. */
function fill<T extends object>(defaults: T, overrides: Partial<T>): T {
  const out = { ...defaults } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export function newPlayer(v: Init<PlayerDoc, "email" | "emailNormalized" | "language">): PlayerDoc {
  const now = new Date();
  return fill<PlayerDoc>(
    {
      _id: randomUUID(),
      email: v.email,
      emailNormalized: v.emailNormalized,
      nickname: null,
      hidden: false,
      language: v.language,
      ageConfirmedAt: null,
      marketingOptIn: false,
      firstSrc: null,
      firstHost: null,
      utm: {},
      emailBlockedAt: null,
      emailBlockReason: null,
      crmStatus: "pending",
      crmSyncedAt: null,
      createdAt: now,
      lastSeenAt: now,
      deletedAt: null,
    },
    v,
  );
}

export function newPlayerToken(v: Init<PlayerTokenDoc, "_id" | "playerId">): PlayerTokenDoc {
  const now = new Date();
  return fill<PlayerTokenDoc>(
    { _id: v._id, playerId: v.playerId, createdAt: now, lastUsedAt: now },
    v,
  );
}

export function newConsent(
  v: Init<
    ConsentDoc,
    "playerId" | "kind" | "granted" | "text" | "textVersion" | "language" | "source"
  >,
): ConsentDoc {
  return fill<ConsentDoc>(
    {
      _id: new ObjectId(),
      playerId: v.playerId,
      kind: v.kind,
      granted: v.granted,
      text: v.text,
      textVersion: v.textVersion,
      language: v.language,
      source: v.source,
      ip: null,
      userAgent: null,
      hostOrigin: null,
      createdAt: new Date(),
    },
    v,
  );
}

export function newRun(
  v: Init<
    RunDoc,
    | "_id"
    | "seed"
    | "rules"
    | "tuningVersion"
    | "issuedAt"
    | "activeMs"
    | "distanceM"
    | "garlic"
    | "hits"
    | "status"
  >,
): RunDoc {
  return fill<RunDoc>(
    {
      _id: v._id,
      seed: v.seed,
      playerId: null,
      src: null,
      hostOrigin: null,
      utm: {},
      language: null,
      rules: v.rules,
      tuningVersion: v.tuningVersion,
      issuedAt: v.issuedAt,
      finishedAt: new Date(),
      activeMs: v.activeMs,
      distanceM: v.distanceM,
      garlic: v.garlic,
      hits: v.hits,
      status: v.status,
      flagReason: null,
      clientVersion: null,
      claimedAt: null,
    },
    v,
  );
}

export function newCampaignSettings(v: Partial<CampaignSettingsDoc> = {}): CampaignSettingsDoc {
  return fill<CampaignSettingsDoc>(
    {
      _id: 1,
      startsAt: null,
      endsAt: null,
      claimsEnabled: false,
      alertEmails: [],
      retentionDays: 90,
      updatedAt: new Date(),
      updatedBy: null,
    },
    v,
  );
}

export function newReward(v: Init<RewardDoc, "_id" | "names" | "terms" | "rule">): RewardDoc {
  return fill<RewardDoc>(
    {
      _id: v._id,
      names: v.names,
      terms: v.terms,
      rule: v.rule,
      active: true,
      validityDays: null,
      validUntil: null,
      maxPerPlayer: 1,
      alertThresholds: [20, 5],
      alertLevel: null,
      sortOrder: 0,
      updatedAt: new Date(),
    },
    v,
  );
}

export function newCode(v: Init<CodeDoc, "rewardId" | "code">): CodeDoc {
  return fill<CodeDoc>(
    {
      _id: new ObjectId(),
      rewardId: v.rewardId,
      code: v.code,
      batch: null,
      expiresAt: null,
      status: "available",
      claimId: null,
      assignedAt: null,
      redeemedAt: null,
      createdAt: new Date(),
    },
    v,
  );
}

export function newClaim(
  v: Init<ClaimDoc, "playerId" | "rewardId" | "runId" | "language">,
): ClaimDoc {
  return fill<ClaimDoc>(
    {
      _id: randomUUID(),
      playerId: v.playerId,
      rewardId: v.rewardId,
      runId: v.runId,
      codeId: null,
      expiresAt: null,
      emailStatus: "pending",
      src: null,
      utm: {},
      language: v.language,
      createdAt: new Date(),
    },
    v,
  );
}

export function newEmailOutbox(
  v: Init<EmailOutboxDoc, "playerId" | "kind" | "claimIds" | "language">,
): EmailOutboxDoc {
  const now = new Date();
  return fill<EmailOutboxDoc>(
    {
      _id: randomUUID(),
      playerId: v.playerId,
      kind: v.kind,
      claimIds: v.claimIds,
      language: v.language,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      providerId: null,
      lastError: null,
      createdAt: now,
      sentAt: null,
    },
    v,
  );
}

export function newCrmOutbox(
  v: Init<CrmOutboxDoc, "playerId" | "type" | "payload" | "idempotencyKey">,
): CrmOutboxDoc {
  const now = new Date();
  return fill<CrmOutboxDoc>(
    {
      _id: new ObjectId(),
      playerId: v.playerId,
      type: v.type,
      payload: v.payload,
      idempotencyKey: v.idempotencyKey,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      sentAt: null,
    },
    v,
  );
}

export function newEvent(v: Init<EventDoc, "name">): EventDoc {
  return fill<EventDoc>(
    {
      _id: new ObjectId(),
      sessionId: null,
      name: v.name,
      props: {},
      src: null,
      lang: null,
      device: null,
      hostOrigin: null,
      createdAt: new Date(),
    },
    v,
  );
}

export function newAdminAudit(v: Init<AdminAuditDoc, "adminEmail" | "action">): AdminAuditDoc {
  return fill<AdminAuditDoc>(
    {
      _id: new ObjectId(),
      adminEmail: v.adminEmail,
      action: v.action,
      target: null,
      details: {},
      createdAt: new Date(),
    },
    v,
  );
}

// ---------------------------------------------------------------------------------------------
// Indexes and validators, applied by migration 0000 (./migrations.ts)
// ---------------------------------------------------------------------------------------------

export interface IndexSpec {
  key: Record<string, 1 | -1>;
  options: CreateIndexesOptions & { name: string };
}

export const INDEXES: Record<CollectionKey, IndexSpec[]> = {
  players: [
    {
      key: { emailNormalized: 1 },
      options: { name: "players_email_normalized_key", unique: true },
    },
    // Admin lists and the retention job walk players by age.
    { key: { createdAt: 1 }, options: { name: "players_created_idx" } },
    // The leaderboard asks for the hidden players on every rank; there are few of them.
    {
      key: { hidden: 1 },
      options: { name: "players_hidden_idx", partialFilterExpression: { hidden: true } },
    },
  ],
  playerTokens: [{ key: { playerId: 1 }, options: { name: "player_tokens_player_idx" } }],
  consents: [{ key: { playerId: 1, createdAt: 1 }, options: { name: "consents_player_idx" } }],
  runs: [
    { key: { playerId: 1 }, options: { name: "runs_player_idx" } },
    { key: { finishedAt: -1 }, options: { name: "runs_finished_idx" } },
    {
      key: { finishedAt: -1 },
      options: {
        name: "runs_flagged_idx",
        partialFilterExpression: { status: "flagged" },
      },
    },
  ],
  bestRuns: [
    {
      // LB-01 order, with the player id so the order is total. `_id` is the player's id.
      key: { garlic: -1, hits: 1, distanceM: -1, achievedAt: 1, _id: 1 },
      options: { name: "best_runs_rank_idx" },
    },
  ],
  campaignSettings: [],
  rewards: [],
  codes: [
    { key: { code: 1 }, options: { name: "codes_code_key", unique: true } },
    // The claim transaction takes the oldest available code: lowest _id first (RWD-03).
    {
      key: { rewardId: 1, _id: 1 },
      options: { name: "codes_available_idx", partialFilterExpression: { status: "available" } },
    },
    // Stock counts by reward and status read this index alone.
    {
      key: { rewardId: 1, status: 1, expiresAt: 1 },
      options: { name: "codes_stock_idx" },
    },
  ],
  claims: [
    // One claim per normalized email per reward (SEC-07, RWD-05).
    {
      key: { playerId: 1, rewardId: 1 },
      options: { name: "claims_player_reward_key", unique: true },
    },
    // A code backs at most one claim. Claims not yet holding a code have a null codeId.
    {
      key: { codeId: 1 },
      options: {
        name: "claims_code_key",
        unique: true,
        partialFilterExpression: { codeId: { $type: "objectId" } },
      },
    },
    { key: { runId: 1 }, options: { name: "claims_run_idx" } },
    { key: { createdAt: 1 }, options: { name: "claims_created_idx" } },
  ],
  emailOutbox: [
    { key: { status: 1, nextAttemptAt: 1 }, options: { name: "email_outbox_due_idx" } },
    { key: { providerId: 1 }, options: { name: "email_outbox_provider_idx" } },
    { key: { playerId: 1 }, options: { name: "email_outbox_player_idx" } },
  ],
  crmOutbox: [
    {
      key: { idempotencyKey: 1 },
      options: { name: "crm_outbox_idempotency_key", unique: true },
    },
    {
      key: { nextAttemptAt: 1 },
      options: { name: "crm_outbox_due_idx", partialFilterExpression: { status: "pending" } },
    },
    { key: { playerId: 1 }, options: { name: "crm_outbox_player_idx" } },
  ],
  events: [{ key: { createdAt: 1 }, options: { name: "events_created_idx" } }],
  eventsDaily: [
    {
      key: { day: 1, name: 1, detail: 1, src: 1, lang: 1, device: 1 },
      options: { name: "events_daily_key", unique: true },
    },
  ],
  adminAudit: [{ key: { createdAt: 1 }, options: { name: "admin_audit_created_idx" } }],
};

/**
 * `$jsonSchema` validators standing in for the CHECK constraints: allowed values for the
 * enumerations the app relies on, the settings singleton and the one-claim-per-reward rule.
 */
export const VALIDATORS: Partial<Record<CollectionKey, Document>> = {
  consents: {
    $jsonSchema: {
      bsonType: "object",
      required: ["kind"],
      properties: { kind: { enum: ["terms_age", "marketing"] } },
    },
  },
  runs: {
    $jsonSchema: {
      bsonType: "object",
      required: ["status"],
      properties: { status: { enum: ["valid", "flagged"] } },
    },
  },
  campaignSettings: {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "retentionDays"],
      properties: {
        _id: { enum: [1] },
        retentionDays: { bsonType: "number", minimum: 0 },
      },
    },
  },
  rewards: {
    $jsonSchema: {
      bsonType: "object",
      required: ["maxPerPlayer"],
      properties: { maxPerPlayer: { enum: [1] } },
    },
  },
  codes: {
    $jsonSchema: {
      bsonType: "object",
      required: ["status"],
      properties: { status: { enum: ["available", "assigned", "redeemed", "void"] } },
    },
  },
};
