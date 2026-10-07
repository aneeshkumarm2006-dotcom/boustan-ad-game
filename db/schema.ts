/**
 * Database schema, MongoDB through the official driver. Collections, indexes and validators are
 * created by `npm run db:migrate` (see ./migrations.ts); this file is their single source of
 * truth.
 *
 * The game is a points contest: a run is worth 1 point per metre plus 10 per garlic, and the top
 * 3 players on the leaderboard win. There are no rewards, codes or coupon emails, so there are no
 * collections for them (migration 0001 drops the ones an older database still has).
 *
 * MongoDB has no column defaults, so every `new*` builder below fills them in. Insert through the
 * builders and a document always carries every field, with `null` for "no value".
 *
 * Ids: players, runs and emails use a UUID string as `_id`. Consents and the CRM outbox use an
 * ObjectId, which sorts in insertion order. Player tokens use the token hash as `_id` and best
 * runs use the player's id, so the database itself keeps them to one per token and one per player.
 *
 * - `player_tokens`: one row per device, so a second host site or phone gets its own token
 *   without signing the first one out. Only SHA-256 hashes are stored (DATA-01).
 * - `best_runs`: each player's best validated run, which the leaderboard reads (LB-02).
 * - `campaign_settings`: the contest dates and the leaderboard switch, editable without a
 *   redeploy (ADM-07).
 * - `events_daily`: the daily analytics rollup (AN-02).
 */
import { randomUUID } from "node:crypto";
import { ObjectId, type CreateIndexesOptions, type Document } from "mongodb";

export type Utm = Partial<
  Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_content", string>
>;

/** Collection names by the key the app uses for them (`db.players`, `tx.bestRuns`...). */
export const COLLECTIONS = {
  players: "players",
  playerTokens: "player_tokens",
  consents: "consents",
  runs: "runs",
  bestRuns: "best_runs",
  campaignSettings: "campaign_settings",
  crmOutbox: "crm_outbox",
  events: "events",
  eventsDaily: "events_daily",
  adminAudit: "admin_audit",
} as const;
export type CollectionKey = keyof typeof COLLECTIONS;

/** Collections of the old rewards-and-coupons design, which migration 0001 removes. */
export const LEGACY_COLLECTIONS = ["rewards", "codes", "claims", "email_outbox"] as const;

// ---------------------------------------------------------------------------------------------
// Players and consent
// ---------------------------------------------------------------------------------------------

export interface PlayerDoc {
  _id: string;
  /** As typed; the address Boustan uses to reach the winners. */
  email: string;
  /** One player per address (SEC-07). Anonymized when a player is deleted. */
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
  /** save_form */
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
  tuningVersion: number;
  issuedAt: Date;
  finishedAt: Date;
  activeMs: number;
  /** Metres as the client reported them (within 2% of the curve, or the run is flagged). */
  distanceM: number;
  garlic: number;
  hits: number;
  /**
   * Points the server awarded: whole metres of the curve at `activeMs` plus 10 per garlic. A
   * flagged run earns 0.
   */
  points: number;
  /** valid | flagged (SEC-03) */
  status: string;
  flagReason: string | null;
  clientVersion: string | null;
  /** Set when its save token is spent, so each token works once (SEC-04). */
  savedAt: Date | null;
}

/** Each player's best validated run (LB-01, LB-02). */
export interface BestRunDoc {
  /** The player's id: one best run per player. */
  _id: string;
  runId: string;
  points: number;
  distanceM: number;
  garlic: number;
  /** Equal points go to whoever got there first (LB-01). */
  achievedAt: Date;
}

// ---------------------------------------------------------------------------------------------
// Contest settings
// ---------------------------------------------------------------------------------------------

/** One document (_id = 1). Edited from the admin or `npm run campaign` (SEC-08). */
export interface CampaignSettingsDoc {
  _id: number;
  startsAt: Date | null;
  endsAt: Date | null;
  /**
   * Whether new scores count towards the leaderboard (SEC-08). Off until someone opens the
   * contest; players can still play while it is off.
   */
  leaderboardOpen: boolean;
  /** Days after the contest ends before players who didn't opt in are anonymized (DATA-06). */
  retentionDays: number;
  updatedAt: Date;
  updatedBy: string | null;
}

// ---------------------------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------------------------

/** CRM sync queue (CRM-05). Written in the save and consent transactions; delivered in Stage 3. */
export interface CrmOutboxDoc {
  _id: ObjectId;
  playerId: string;
  /** contact_upsert | consent_changed */
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
  /** One prop that splits the event: milestone points, cta target, error reason. */
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
    | "tuningVersion"
    | "issuedAt"
    | "activeMs"
    | "distanceM"
    | "garlic"
    | "hits"
    | "points"
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
      tuningVersion: v.tuningVersion,
      issuedAt: v.issuedAt,
      finishedAt: new Date(),
      activeMs: v.activeMs,
      distanceM: v.distanceM,
      garlic: v.garlic,
      hits: v.hits,
      points: v.points,
      status: v.status,
      flagReason: null,
      clientVersion: null,
      savedAt: null,
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
      leaderboardOpen: false,
      retentionDays: 90,
      updatedAt: new Date(),
      updatedBy: null,
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

/** The leaderboard order: most points, then whoever got there first. `_id` makes it total. */
export const BEST_RUNS_RANK_INDEX: IndexSpec = {
  key: { points: -1, achievedAt: 1, _id: 1 },
  options: { name: "best_runs_points_idx" },
};

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
  bestRuns: [BEST_RUNS_RANK_INDEX],
  campaignSettings: [],
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
 * enumerations the app relies on and the settings singleton.
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
};
