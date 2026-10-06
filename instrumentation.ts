import type { Instrumentation } from "next";

/**
 * Unhandled server errors go to Sentry when SENTRY_DSN is set (NFR-08). The path is sent without
 * its query string, which can hold signed tokens.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!process.env.SENTRY_DSN || process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureException } = await import("./lib/server/sentry");
  await captureException(error, {
    path: request.path.split("?")[0],
    method: request.method,
    route: context.routePath,
    type: context.routeType,
  });
};
