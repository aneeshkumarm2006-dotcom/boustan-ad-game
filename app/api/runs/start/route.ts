import { z } from "zod";
import {
  hostSchema,
  json,
  langSchema,
  readBody,
  requestContext,
  srcSchema,
  tooMany,
  utmSchema,
  withErrors,
} from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { startRun } from "@/lib/server/runs";

const body = z.object({
  src: srcSchema,
  lang: langSchema.catch("fr"),
  utm: utmSchema,
  host: hostSchema,
});

/** POST /api/runs/start → {runId, seed, token, campaign} (SEC-01, §3.3). */
export const POST = withErrors("run_start", async (request: Request) => {
  const ctx = requestContext(request);
  const limit = await rateLimit("runStart", ctx.ip ?? "unknown");
  if (!limit.ok) return tooMany(limit.retryAfterS);
  const parsed = await readBody(request, body, 4096);
  if (!parsed.ok) return parsed.response;
  return json(await startRun(parsed.data));
});
