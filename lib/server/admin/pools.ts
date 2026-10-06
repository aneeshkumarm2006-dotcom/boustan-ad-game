/**
 * Code pools (RWD-01, RWD-02, ADM-03, ADM-08). The pool size is the budget cap, so imports are
 * strict: codes are trimmed and de-duplicated, a code already in any pool is rejected, and
 * the admin gets a summary of what happened to every row.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Queryable } from "@/db/client";
import { codes, rewards } from "@/db/schema";
import { REWARD_IDS, isRewardId, type RewardId } from "@/game-core";
import { parseCsv } from "@/lib/csv";
import { parseMontrealLocal } from "./time";

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CODE_ROWS = 200_000;
const CHUNK = 2000;
/** Printable ASCII with no spaces. uEat's real format is open question #11. */
const CODE_FORMAT = /^[\x21-\x7e]{3,64}$/;

export interface ParsedCode {
  code: string;
  expiresAt: Date | null;
  batch: string | null;
}

export interface CodeRowProblem {
  /** 1-based line in the file. */
  line: number;
  value: string;
  reason: "format" | "date";
}

export interface ParsedCodes {
  /** Data rows read, after the header. */
  rows: number;
  valid: ParsedCode[];
  invalid: CodeRowProblem[];
  /** Repeats of a code earlier in the same file. */
  duplicatesInFile: number;
}

/**
 * Reads a pool CSV (RWD-02). `code` is required; `expires_at` and `batch` are optional. With a
 * header row, columns are found by name; without one, the first column is the code. Dates are
 * YYYY-MM-DD (end of that day, Montréal) or YYYY-MM-DDTHH:mm.
 */
export function parseCodesCsv(text: string): ParsedCodes {
  const table = parseCsv(text);
  const header = table[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const hasHeader = header.includes("code");
  const col = (name: string) => (hasHeader ? header.indexOf(name) : name === "code" ? 0 : -1);
  const [codeCol, expiresCol, batchCol] = [col("code"), col("expires_at"), col("batch")];
  const out: ParsedCodes = { rows: 0, valid: [], invalid: [], duplicatesInFile: 0 };
  const seen = new Set<string>();
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < table.length; i++) {
    const row = table[i];
    const line = i + 1;
    out.rows++;
    const code = (row[codeCol] ?? "").trim();
    if (!CODE_FORMAT.test(code)) {
      out.invalid.push({ line, value: code.slice(0, 80), reason: "format" });
      continue;
    }
    let expiresAt: Date | null = null;
    const rawDate = expiresCol >= 0 ? (row[expiresCol] ?? "").trim() : "";
    if (rawDate) {
      // A bare date means the end of that day, so "expires 2026-11-15" includes the 15th.
      expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
        ? addDay(parseMontrealLocal(rawDate))
        : (parseMontrealLocal(rawDate) ?? iso(rawDate));
      if (!expiresAt) {
        out.invalid.push({ line, value: rawDate.slice(0, 80), reason: "date" });
        continue;
      }
    }
    if (seen.has(code)) {
      out.duplicatesInFile++;
      continue;
    }
    seen.add(code);
    const batch = batchCol >= 0 ? (row[batchCol] ?? "").trim().slice(0, 80) : "";
    out.valid.push({ code, expiresAt, batch: batch || null });
  }
  return out;
}

function addDay(d: Date | null): Date | null {
  return d ? new Date(d.getTime() + 86_400_000 - 60_000) : null;
}

/** A full ISO timestamp with an offset ("2026-11-15T23:59:00Z"), or null. */
function iso(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return null;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ImportSummary {
  reward: RewardId;
  batch: string;
  rows: number;
  imported: number;
  duplicatesInFile: number;
  /** Already in a pool, so left alone (RWD-02). */
  alreadyExist: number;
  /** Of those, how many sit in a different reward's pool. */
  inOtherPool: number;
  invalid: CodeRowProblem[];
}

export function defaultBatchName(now = new Date()): string {
  return `import-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
}

export type ImportResult = { ok: true; summary: ImportSummary } | { ok: false; error: string };

/** Adds a CSV's codes to a reward's pool. Nothing is written if the file has no usable rows. */
export async function importCodes(
  q: Db,
  reward: string,
  csv: string,
  opts: { batch?: string; now?: Date } = {},
): Promise<ImportResult> {
  if (!isRewardId(reward)) return { ok: false, error: "unknown_reward" };
  if (csv.length > MAX_CSV_BYTES) return { ok: false, error: "too_large" };
  const parsed = parseCodesCsv(csv);
  if (parsed.rows > MAX_CODE_ROWS) return { ok: false, error: "too_many_rows" };
  if (parsed.rows === 0) return { ok: false, error: "empty" };
  const batchName = (opts.batch ?? "").trim().slice(0, 80) || defaultBatchName(opts.now);

  let imported = 0;
  let alreadyExist = 0;
  let inOtherPool = 0;
  await q.transaction(async (tx) => {
    for (let i = 0; i < parsed.valid.length; i += CHUNK) {
      const chunk = parsed.valid.slice(i, i + CHUNK);
      const existing = await tx
        .select({ code: codes.code, rewardId: codes.rewardId })
        .from(codes)
        .where(
          inArray(
            codes.code,
            chunk.map((c) => c.code),
          ),
        );
      const taken = new Map(existing.map((e) => [e.code, e.rewardId]));
      const fresh = chunk.filter((c) => !taken.has(c.code));
      alreadyExist += chunk.length - fresh.length;
      inOtherPool += existing.filter((e) => e.rewardId !== reward).length;
      if (fresh.length === 0) continue;
      // The unique index is the real guard if two imports run at once.
      const inserted = await tx
        .insert(codes)
        .values(
          fresh.map((c) => ({
            rewardId: reward,
            code: c.code,
            expiresAt: c.expiresAt,
            batch: c.batch ?? batchName,
          })),
        )
        .onConflictDoNothing({ target: codes.code })
        .returning({ id: codes.id });
      imported += inserted.length;
      alreadyExist += fresh.length - inserted.length;
    }
  });

  return {
    ok: true,
    summary: {
      reward,
      batch: batchName,
      rows: parsed.rows,
      imported,
      duplicatesInFile: parsed.duplicatesInFile,
      alreadyExist,
      inOtherPool,
      invalid: parsed.invalid,
    },
  };
}

// ---------- uEat redeemed report (ADM-08) ----------

export interface RedemptionSummary {
  rows: number;
  /** Issued codes now marked redeemed. */
  marked: number;
  alreadyRedeemed: number;
  /** In the report but never issued to a player (still available, or void). */
  notIssued: number;
  /** In the report but not in any pool. */
  unknown: number;
  invalid: number;
}

/**
 * Marks issued codes as redeemed from uEat's report. Needs a `code` column (or one column of
 * codes); an optional `redeemed_at` is kept, otherwise the upload time is used.
 */
export async function markRedeemed(
  q: Db,
  csv: string,
  now = new Date(),
): Promise<{ ok: true; summary: RedemptionSummary } | { ok: false; error: "too_large" | "empty" }> {
  if (csv.length > MAX_CSV_BYTES) return { ok: false, error: "too_large" };
  const table = parseCsv(csv);
  const header = table[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const hasHeader = header.includes("code");
  const codeCol = hasHeader ? header.indexOf("code") : 0;
  const atCol = hasHeader ? header.indexOf("redeemed_at") : -1;
  const body = table.slice(hasHeader ? 1 : 0);
  if (body.length === 0) return { ok: false, error: "empty" };

  const summary: RedemptionSummary = {
    rows: body.length,
    marked: 0,
    alreadyRedeemed: 0,
    notIssued: 0,
    unknown: 0,
    invalid: 0,
  };
  const wanted = new Map<string, Date>();
  for (const row of body) {
    const code = (row[codeCol] ?? "").trim();
    if (!CODE_FORMAT.test(code)) {
      summary.invalid++;
      continue;
    }
    const raw = atCol >= 0 ? (row[atCol] ?? "").trim() : "";
    const at = raw ? (parseMontrealLocal(raw) ?? iso(raw)) : null;
    if (!wanted.has(code)) wanted.set(code, at ?? now);
  }
  const list = [...wanted.entries()];
  await q.transaction(async (tx) => {
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const found = await tx
        .select({ id: codes.id, code: codes.code, status: codes.status })
        .from(codes)
        .where(
          inArray(
            codes.code,
            chunk.map(([c]) => c),
          ),
        );
      const byCode = new Map(found.map((f) => [f.code, f]));
      for (const [code, at] of chunk) {
        const row = byCode.get(code);
        if (!row) summary.unknown++;
        else if (row.status === "redeemed") summary.alreadyRedeemed++;
        else if (row.status !== "assigned") summary.notIssued++;
        else {
          await tx
            .update(codes)
            .set({ status: "redeemed", redeemedAt: at })
            .where(and(eq(codes.id, row.id), eq(codes.status, "assigned")));
          summary.marked++;
        }
      }
    }
  });
  return { ok: true, summary };
}

// ---------- stock view and alert settings ----------

export interface PoolStats {
  reward: RewardId;
  active: boolean;
  names: { fr: string; en: string };
  total: number;
  available: number;
  /** Available but past their own expiry date: they can't be issued. */
  expiredAvailable: number;
  assigned: number;
  redeemed: number;
  void: number;
  alertThresholds: number[];
  alertLevel: number | null;
  /** Share of issued codes that uEat reports redeemed, 0 to 1; null before any is issued. */
  redemptionRate: number | null;
}

export async function poolStats(q: Queryable): Promise<PoolStats[]> {
  const counts = await q
    .select({
      reward: codes.rewardId,
      total: sql<number>`count(*)::int`,
      available: sql<number>`count(*) filter (where ${codes.status} = 'available' and (${codes.expiresAt} is null or ${codes.expiresAt} > now()))::int`,
      expiredAvailable: sql<number>`count(*) filter (where ${codes.status} = 'available' and ${codes.expiresAt} <= now())::int`,
      assigned: sql<number>`count(*) filter (where ${codes.status} = 'assigned')::int`,
      redeemed: sql<number>`count(*) filter (where ${codes.status} = 'redeemed')::int`,
      void: sql<number>`count(*) filter (where ${codes.status} = 'void')::int`,
    })
    .from(codes)
    .groupBy(codes.rewardId);
  const rows = await q.select().from(rewards).orderBy(rewards.sortOrder);
  return rows
    .filter((r) => isRewardId(r.id))
    .map((r) => {
      const c = counts.find((x) => x.reward === r.id);
      const issued = (c?.assigned ?? 0) + (c?.redeemed ?? 0);
      return {
        reward: r.id as RewardId,
        active: r.active,
        names: r.names,
        total: c?.total ?? 0,
        available: c?.available ?? 0,
        expiredAvailable: c?.expiredAvailable ?? 0,
        assigned: c?.assigned ?? 0,
        redeemed: c?.redeemed ?? 0,
        void: c?.void ?? 0,
        alertThresholds: r.alertThresholds,
        alertLevel: r.alertLevel,
        redemptionRate: issued > 0 ? (c?.redeemed ?? 0) / issued : null,
      };
    })
    .sort((a, b) => REWARD_IDS.indexOf(a.reward) - REWARD_IDS.indexOf(b.reward));
}

/** Percentages 1 to 99, highest first, at most 5. Null when the input has none. */
export function parseThresholds(input: string): number[] | null {
  const values = input
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((v) => Number(v.replace("%", "")));
  if (values.length === 0 || values.length > 5) return null;
  if (!values.every((v) => Number.isInteger(v) && v >= 1 && v <= 99)) return null;
  return [...new Set(values)].sort((a, b) => b - a);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Addresses separated by commas, spaces or semicolons. Null when any is malformed. */
export function parseEmailList(input: string): string[] | null {
  const list = input
    .split(/[\s,;]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (list.length > 20 || !list.every((v) => EMAIL.test(v) && v.length <= 254)) return null;
  return [...new Set(list)];
}

/** A pool's alert levels. Changing them lets the next check announce again. */
export async function setPoolAlerts(
  q: Queryable,
  reward: RewardId,
  thresholds: number[],
): Promise<void> {
  await q
    .update(rewards)
    .set({ alertThresholds: thresholds, alertLevel: null, updatedAt: new Date() })
    .where(eq(rewards.id, reward));
}

export interface BatchRow {
  reward: string;
  batch: string;
  codes: number;
  available: number;
  addedAt: Date;
}

/** The most recent import batches, with how many of each are still available. */
export async function recentBatches(q: Queryable, limit = 12): Promise<BatchRow[]> {
  const rows = await q
    .select({
      reward: codes.rewardId,
      batch: sql<string>`coalesce(${codes.batch}, '(none)')`,
      codes: sql<number>`count(*)::int`,
      available: sql<number>`count(*) filter (where ${codes.status} = 'available')::int`,
      addedAt: sql<Date>`min(${codes.createdAt})`,
    })
    .from(codes)
    .groupBy(codes.rewardId, sql`coalesce(${codes.batch}, '(none)')`)
    .orderBy(desc(sql`min(${codes.createdAt})`))
    .limit(limit);
  return rows.map((r) => ({ ...r, addedAt: new Date(r.addedAt) }));
}
