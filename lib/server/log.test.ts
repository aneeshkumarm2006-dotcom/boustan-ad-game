import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "./log";

describe("structured logs (NFR-08)", () => {
  afterEach(() => vi.restoreAllMocks());

  const lastLine = (spy: ReturnType<typeof vi.spyOn>) =>
    JSON.parse(String(spy.mock.calls.at(-1)![0])) as Record<string, unknown>;

  it("write one JSON object per line, with the event, the fields and a timestamp", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("run_finished", { runId: "r1", points: 283, garlic: 12, ok: true });
    expect(lastLine(out)).toMatchObject({
      level: "info",
      event: "run_finished",
      runId: "r1",
      points: 283,
      garlic: 12,
      ok: true,
    });
    expect(new Date(String(lastLine(out).ts)).getTime()).not.toBeNaN();
  });

  it("drop fields that look personal, as a backstop for the callers that shouldn't pass them", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("score_saved", {
      rank: 2,
      email: "jo@videotron.ca",
      playerEmail: "jo@videotron.ca",
      ip: "203.0.113.7",
      saveToken: "abc",
      code: "X-1",
      userAgent: "Mozilla",
      nickname: "Jo",
      address: "1 rue X",
    });
    const line = lastLine(out);
    expect(line).toMatchObject({ rank: 2 });
    for (const key of [
      "email",
      "playerEmail",
      "ip",
      "saveToken",
      "code",
      "userAgent",
      "nickname",
    ]) {
      expect(line, key).not.toHaveProperty(key);
    }
    expect(line).not.toHaveProperty("address");
  });

  it("send warnings and errors to their own streams, and scrub an error's message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    log.warn("run_flagged", { reason: "distance" });
    expect(lastLine(warn)).toMatchObject({
      level: "warn",
      event: "run_flagged",
      reason: "distance",
    });
    await log.error("save_failed", new Error("duplicate key jo@videotron.ca"), { step: "player" });
    const line = lastLine(err);
    expect(line).toMatchObject({ level: "error", event: "save_failed", step: "player" });
    expect(String(line.error)).toBe("duplicate key [email]");
  });
});
