import { createHttpApi } from "./http";
import { createMockApi } from "./mock";
import type { GameApi } from "./types";

export * from "./types";

/** The in-browser mock, unless NEXT_PUBLIC_API_MODE=live switches to the real endpoints. */
export function createApi(search: string): GameApi {
  return process.env.NEXT_PUBLIC_API_MODE === "live" ? createHttpApi() : createMockApi(search);
}
