/**
 * Low-stock emails (RWD-04, ADM-03). A pool's alert thresholds are percentages of codes left
 * (default 20% and 5%). Crossing one sends one email to the alert recipients; the level is
 * remembered so the same threshold doesn't send twice, and adding codes re-arms it.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { campaignSettings, rewards } from "@/db/schema";
import { env } from "../env";
import { log } from "../log";
import { escapeHtml } from "../pages";
import { defaultSender, type Sender } from "../email/sender";
import { poolStats, type PoolStats } from "./pools";

export interface StockAlertResult {
  reward: string;
  percentLeft: number;
  /** The threshold that was just crossed, if an email went out. */
  announced: number | null;
}

/** The lowest threshold the pool is at or under, or null when it is above all of them. */
export function levelFor(percentLeft: number, thresholds: number[]): number | null {
  const under = thresholds.filter((t) => percentLeft <= t);
  return under.length > 0 ? Math.min(...under) : null;
}

/** Codes left as a share of the pool, not counting voided codes. */
export function percentLeft(p: Pick<PoolStats, "total" | "void" | "available">): number {
  const base = p.total - p.void;
  return base > 0 ? (p.available / base) * 100 : 100;
}

/** Alert recipients from the settings; ADMIN_EMAILS when none are set. */
export async function recipients(q: Db): Promise<string[]> {
  const [s] = await q.select().from(campaignSettings).where(eq(campaignSettings.id, 1));
  const custom = s?.alertEmails ?? [];
  return custom.length > 0 ? custom : env().adminEmails;
}

export async function runStockAlerts(
  q: Db,
  send: Sender = defaultSender,
  now = new Date(),
): Promise<StockAlertResult[]> {
  const to = await recipients(q);
  const out: StockAlertResult[] = [];
  const setLevel = (reward: string, alertLevel: number | null) =>
    q.update(rewards).set({ alertLevel }).where(eq(rewards.id, reward));

  for (const pool of await poolStats(q)) {
    // A pool that never had codes isn't "low", it just isn't set up yet.
    if (pool.total - pool.void <= 0) continue;
    const pct = percentLeft(pool);
    const level = levelFor(pct, pool.alertThresholds);
    let announced: number | null = null;

    if (level === null) {
      // Back above every threshold (codes were added): re-arm.
      if (pool.alertLevel !== null) await setLevel(pool.reward, null);
    } else if (pool.alertLevel === null || level < pool.alertLevel) {
      if (to.length === 0) {
        log.warn("stock_alert_no_recipients", { reward: pool.reward });
      } else {
        try {
          for (const address of to) await send(stockEmail(pool, pct, level, address, now));
          announced = level;
        } catch (error) {
          // Keep the old level so the next run tries again.
          await log.error("stock_alert_email_failed", error, { reward: pool.reward });
          out.push({ reward: pool.reward, percentLeft: pct, announced: null });
          continue;
        }
      }
      await setLevel(pool.reward, level);
    } else if (level > pool.alertLevel) {
      // Stock was added but is still under a higher threshold: re-arm without an email.
      await setLevel(pool.reward, level);
    }
    out.push({ reward: pool.reward, percentLeft: pct, announced });
  }
  return out;
}

function stockEmail(pool: PoolStats, pct: number, level: number, to: string, now: Date) {
  const left = pool.available;
  const name = `${pool.names.en} / ${pool.names.fr}`;
  const url = `${env().appUrl}/admin/codes`;
  const pctText = pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
  const subject = `Boustan game: ${pool.names.en} codes at ${pctText}% (${left} left)`;
  const text = `${name}: ${left} codes left (${pctText}% of the pool, at or under the ${level}% alert).\nAdd codes: ${url}\n\nIl reste ${left} codes pour « ${pool.names.fr} » (${pctText} % du lot, seuil d'alerte de ${level} %).\nAjouter des codes : ${url}\n`;
  const html = `<p><b>${escapeHtml(name)}</b>: ${left} codes left (${pctText}% of the pool, at or under the ${level}% alert).</p>
<p><a href="${escapeHtml(url)}">Add codes</a></p>
<p>Il reste ${left} codes pour « ${escapeHtml(pool.names.fr)} » (${pctText} % du lot, seuil d'alerte de ${level} %).</p>`;
  return {
    to,
    subject,
    html,
    text,
    headers: {},
    // Resend drops a repeat within 24 h, so a crash between sending and saving can't double up.
    idempotencyKey: `stock-${pool.reward}-${level}-${to}-${now.toISOString().slice(0, 10)}`,
    tags: [{ name: "kind", value: "stock_alert" }],
  };
}
