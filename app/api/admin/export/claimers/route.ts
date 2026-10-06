import { audit } from "@/lib/server/admin/audit";
import { adminFromRequest } from "@/lib/server/admin/auth";
import { claimersCsv } from "@/lib/server/admin/export";
import { montrealDay } from "@/lib/server/analytics";
import { db } from "@/lib/server/db";
import { apiError, withErrors } from "@/lib/server/http";

export const maxDuration = 60;

/** GET /api/admin/export/claimers[?optedIn=1] → CSV download (ADM-06). Logged. */
export const GET = withErrors("admin_export_claimers", async (request: Request) => {
  const admin = adminFromRequest(request);
  if (!admin) return apiError(401, "unauthorized");
  const optedIn = new URL(request.url).searchParams.get("optedIn") === "1";
  const csv = await claimersCsv(db(), optedIn);
  await audit(db(), admin, "export.claimers", null, { optedInOnly: optedIn });
  const name = `boustan-claimers${optedIn ? "-opted-in" : ""}-${montrealDay(0)}.csv`;
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
});
