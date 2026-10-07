import { describe, expect, it } from "vitest";
import { boardOpen, campaignState, campaignStatus, type Campaign } from "./campaign";

const D = (iso: string) => new Date(iso);
const START = D("2026-10-15T04:00:00Z");
const END = D("2026-11-15T05:00:00Z");
const window: Campaign = { startsAt: START, endsAt: END, leaderboardOpen: true };

describe("contest status (SEC-08)", () => {
  it("is not started before the start, active inside the window and ended from the end on", () => {
    expect(campaignStatus(window, D("2026-10-14T23:59:59Z"))).toBe("not_started");
    expect(campaignStatus(window, START)).toBe("active");
    expect(campaignStatus(window, D("2026-10-30T12:00:00Z"))).toBe("active");
    expect(campaignStatus(window, D("2026-11-15T04:59:59Z"))).toBe("active");
    expect(campaignStatus(window, END)).toBe("ended");
    expect(campaignStatus(window, D("2027-01-01T00:00:00Z"))).toBe("ended");
  });

  it("has no limit on a side that has no date: no start is from the beginning, no end is never", () => {
    const now = D("2026-12-25T12:00:00Z");
    expect(campaignStatus({ ...window, startsAt: null }, D("2000-01-01T00:00:00Z"))).toBe("active");
    expect(campaignStatus({ ...window, endsAt: null }, now)).toBe("active");
    expect(campaignStatus({ startsAt: null, endsAt: null, leaderboardOpen: true }, now)).toBe(
      "active",
    );
  });
});

describe("whether a score counts (SEC-08)", () => {
  const inside = D("2026-10-30T12:00:00Z");

  it("counts only while the window is open and the leaderboard is on", () => {
    expect(boardOpen(window, inside)).toBe(true);
    expect(boardOpen({ ...window, leaderboardOpen: false }, inside)).toBe(false);
    expect(boardOpen(window, D("2026-10-01T00:00:00Z"))).toBe(false);
    expect(boardOpen(window, END)).toBe(false);
  });

  it("is a contest with no dates when the switch is on, and a closed one when it is off", () => {
    const open = { startsAt: null, endsAt: null, leaderboardOpen: true };
    expect(boardOpen(open, inside)).toBe(true);
    expect(boardOpen({ ...open, leaderboardOpen: false }, inside)).toBe(false);
  });
});

describe("what the start screen needs", () => {
  it("is the status, the dates as ISO strings and the leaderboard switch", () => {
    expect(campaignState(window, D("2026-10-30T12:00:00Z"))).toEqual({
      status: "active",
      startsAt: "2026-10-15T04:00:00.000Z",
      endsAt: "2026-11-15T05:00:00.000Z",
      leaderboardOpen: true,
    });
  });

  it("says null for a date that isn't set, and reports a closed switch as it is", () => {
    expect(
      campaignState(
        { startsAt: null, endsAt: null, leaderboardOpen: false },
        D("2026-10-30T00:00:00Z"),
      ),
    ).toEqual({ status: "active", startsAt: null, endsAt: null, leaderboardOpen: false });
  });

  it("reports the window's state even while the switch is off", () => {
    const off = { ...window, leaderboardOpen: false };
    expect(campaignState(off, D("2026-10-01T00:00:00Z")).status).toBe("not_started");
    expect(campaignState(off, D("2026-12-01T00:00:00Z")).status).toBe("ended");
  });
});
