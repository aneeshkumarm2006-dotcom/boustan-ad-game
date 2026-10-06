import { z } from "zod";
import { newEvent } from "@/db/schema";
import { CLIENT_EVENTS, type ClientEvent } from "@/lib/analytics-events";
import { db } from "@/lib/server/db";
import {
  hostSchema,
  readBody,
  requestContext,
  srcSchema,
  tooMany,
  withErrors,
} from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";

const NAMES = new Set<string>(CLIENT_EVENTS);
const propValue = z.union([z.string().max(64), z.number().finite(), z.boolean()]);

const body = z.object({
  sessionId: z.string().regex(/^[\w-]{8,64}$/),
  src: srcSchema,
  lang: z.enum(["fr", "en"]).nullable().catch(null),
  host: hostSchema,
  events: z
    .array(
      z.object({
        name: z.string().max(40),
        props: z.record(z.string().max(32), propValue).optional(),
      }),
    )
    .max(50),
});

const noContent = () =>
  new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** MongoDB field names can't start with $ or contain dots; client-chosen prop names might. */
const safeProp = ([key]: [string, unknown]) => !key.startsWith("$") && !key.includes(".");

/**
 * POST /api/events → 204 (AN-01, AN-02). Batches from the client, sent with fetch or
 * sendBeacon (as text/plain, so no preflight). Unknown names and oversized props are dropped.
 */
export const POST = withErrors("events", async (request: Request) => {
  const ctx = requestContext(request);
  const limit = await rateLimit("events", ctx.ip ?? "unknown");
  if (!limit.ok) return tooMany(limit.retryAfterS);
  const parsed = await readBody(request, body, 32 * 1024);
  if (!parsed.ok) return parsed.response;
  const batch = parsed.data;
  const rows = batch.events
    .filter((e): e is typeof e & { name: ClientEvent } => NAMES.has(e.name))
    .map((e) =>
      newEvent({
        sessionId: batch.sessionId,
        name: e.name,
        props: Object.fromEntries(
          Object.entries(e.props ?? {})
            .filter(safeProp)
            .slice(0, 8),
        ),
        src: batch.src,
        lang: batch.lang,
        device: ctx.device,
        hostOrigin: batch.host,
      }),
    );
  if (rows.length > 0) await db().events.insertMany(rows);
  return noContent();
});
