/**
 * Alert checks run by /api/cron/alerts (NFR-08): the share of "Save my score" attempts that end
 * in a server error in the last hour. A breach becomes a Sentry event with a fixed fingerprint,
 * so a Sentry issue alert rule can page whoever is on call.
 */
import type { Queryable } from "@/db/client";
import { captureMessage } from "./sentry";
import { log } from "./log";

export const ALERTS = {
  /** Server errors as a share of save attempts, last hour (NFR-08). */
  saveErrorRate: { threshold: 0.02, minSample: 20, windowMs: 60 * 60 * 1000 },
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
  const se = ALERTS.saveErrorRate;
  const since = new Date(now.getTime() - se.windowMs);
  const attempts = await count(q, "api_save", since);
  const errors = await count(q, "api_save", since, "error");

  const results: AlertResult[] = [
    {
      name: "saveErrorRate",
      rate: attempts ? errors / attempts : 0,
      sample: attempts,
      firing: attempts >= se.minSample && errors / attempts > se.threshold,
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
