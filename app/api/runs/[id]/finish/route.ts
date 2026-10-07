import { z } from "zod";
import { db } from "@/lib/server/db";
import { apiError, json, readBody, requestContext, withErrors } from "@/lib/server/http";
import { finishRun } from "@/lib/server/runs";

const body = z.object({
  token: z.string().min(1).max(2048),
  distance: z.number().min(0).max(1e7),
  garlic: z.number().int().min(0).max(1e6),
  hits: z.number().int().min(0).max(1e6),
  activeMs: z.number().int().min(0).max(1e9),
});

/**
 * POST /api/runs/:id/finish → {valid, points, saveToken, best, rankPreview, rank} (SEC-02 to
 * SEC-04). The server scores the run (1 point per metre, 10 per garlic). A run that fails any
 * check gets `valid: false` and nothing else (SEC-03).
 */
export const POST = withErrors(
  "run_finish",
  async (request: Request, { params }: RouteContext<"/api/runs/[id]/finish">) => {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) return apiError(404, "not_found");
    const parsed = await readBody(request, body, 4096);
    if (!parsed.ok) return parsed.response;
    const ctx = requestContext(request);
    const { response } = await finishRun(db(), id, parsed.data, {
      playerToken: ctx.playerToken,
      clientVersion: ctx.clientVersion,
      now: new Date(),
    });
    return json(response);
  },
);
