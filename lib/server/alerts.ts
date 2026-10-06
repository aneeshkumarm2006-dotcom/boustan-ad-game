/**
 * Alert checks run by /api/cron/alerts (NFR-08): claim errors above 2% of claims in the last
 * hour, and a bounce spike in the last day. A breach becomes a Sentry event with a fixed
 * fingerprint, so a Sentry issue alert rule can page whoever is on call.
 */
import type { Queryable } from "@/db/client";
import { captureMessage } from "./sentry";
import { log } from "./log";

export const ALERTS = {
  /** Server errors as a share of claim attempts, last hour (NFR-08). */
  claimErrorRate: { threshold: 0.02, minSample: 20, windowMs: 60 * 60 * 1000 },
  /** Hard bounces and complaints as a share of emails sent, last 24 hours. */
  bounceRate: { threshold: 0.05, minSample: 20, windowMs: 24 * 60 * 60 * 1000 },
} as const;

export interface AlertResult {
  name: keyof typeof ALERTS;
  rate: number;
  sample: number;
  firing: boolean;
}

async function count(q: Queryable, name: string, since: Date, outcome?: string): Promise<number> {
  return q.events.countDocuments({
    name,
    createdAt: { $gte: since },
    ...(outcome ? { "props.outcome": outcome } : {}),
  });
}

export async function checkAlerts(q: Queryable, now = new Date()): Promise<AlertResult[]> {
  const ce = ALERTS.claimErrorRate;
  const claimSince = new Date(now.getTime() - ce.windowMs);
  const attempts = await count(q, "api_claim", claimSince);
  const errors = await count(q, "api_claim", claimSince, "error");

  const br = ALERTS.bounceRate;
  const bounceSince = new Date(now.getTime() - br.windowMs);
  const sent = await count(q, "email_sent", bounceSince);
  const bounced = await count(q, "email_bounced", bounceSince);

  const results: AlertResult[] = [
    {
      name: "claimErrorRate",
      rate: attempts ? errors / attempts : 0,
      sample: attempts,
      firing: attempts >= ce.minSample && errors / attempts > ce.threshold,
    },
    {
      name: "bounceRate",
      rate: sent ? bounced / sent : 0,
      sample: sent,
      firing: sent >= br.minSample && bounced / sent > br.threshold,
    },
  ];
  for (const r of results.filter((a) => a.firing)) {
    log.warn("alert_firing", { alert: r.name, rate: Number(r.rate.toFixed(4)), sample: r.sample });
    await captureMessage(`Alert: ${r.name} at ${(r.rate * 100).toFixed(1)}%`, {
      tags: { alert: r.name, sample: r.sample },
      fingerprint: ["boustan-alert", r.name],
    });
  }
  return results;
}
