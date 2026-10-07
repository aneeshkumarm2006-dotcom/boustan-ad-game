import { audit } from "@/lib/server/admin/audit";
import { adminFromRequest } from "@/lib/server/admin/auth";
import { playersCsv } from "@/lib/server/admin/export";
import { montrealDay } from "@/lib/server/analytics";
import { db } from "@/lib/server/db";
import { apiError, withErrors } from "@/lib/server/http";

export const maxDuration = 60;

/** GET /api/admin/export/players[?winners=1][&optedIn=1] → CSV download (ADM-06). Logged. */
export const GET = withErrors("admin_export_players", async (request: Request) => {
  const admin = adminFromRequest(request);
  if (!admin) return apiError(401, "unauthorized");
  const params = new URL(request.url).searchParams;
  const winnersOnly = params.get("winners") === "1";
  const optedInOnly = params.get("optedIn") === "1";
  const csv = await playersCsv(db(), { winnersOnly, optedInOnly });
  await audit(db(), admin, winnersOnly ? "export.winners" : "export.players", null, {
    optedInOnly,
  });
  const name = `boustan-${winnersOnly ? "winners" : "players"}${optedInOnly ? "-opted-in" : ""}-${montrealDay(0)}.csv`;
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
});
