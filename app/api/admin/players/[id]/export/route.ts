import { z } from "zod";
import { audit } from "@/lib/server/admin/audit";
import { adminFromRequest } from "@/lib/server/admin/auth";
import { exportPlayer } from "@/lib/server/admin/players";
import { db } from "@/lib/server/db";
import { apiError, withErrors } from "@/lib/server/http";

/** GET /api/admin/players/:id/export → everything held about one player as JSON (DATA-07). */
export const GET = withErrors(
  "admin_export_player",
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const admin = adminFromRequest(request);
    if (!admin) return apiError(401, "unauthorized");
    const id = z.uuid().safeParse((await ctx.params).id);
    if (!id.success) return apiError(404, "not_found");
    const data = await exportPlayer(db(), id.data);
    if (!data) return apiError(404, "not_found");
    await audit(db(), admin, "export.player", id.data);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="player-${id.data}.json"`,
        "cache-control": "no-store",
      },
    });
  },
);
