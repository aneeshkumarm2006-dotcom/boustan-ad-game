import { describe, expect, it } from "vitest";
import { parseCommand } from "./bridge";

const msg = (extra: Record<string, unknown>) => ({ ns: "boustan-game", v: 1, ...extra });

describe("parseCommand (EMB-05)", () => {
  it("accepts the four commands", () => {
    expect(parseCommand(msg({ cmd: "setLanguage", value: "en" }))).toEqual({
      cmd: "setLanguage",
      lang: "en",
    });
    expect(parseCommand(msg({ cmd: "pause" }))).toEqual({ cmd: "pause" });
    expect(parseCommand(msg({ cmd: "resume" }))).toEqual({ cmd: "resume" });
    expect(parseCommand(msg({ cmd: "mute" }))).toEqual({ cmd: "mute", muted: true });
    expect(parseCommand(msg({ cmd: "mute", value: false }))).toEqual({ cmd: "mute", muted: false });
  });

  it("rejects other namespaces, versions, commands and bad values", () => {
    expect(parseCommand({ ns: "other", v: 1, cmd: "pause" })).toBeNull();
    expect(parseCommand(msg({ v: 2, cmd: "pause" }))).toBeNull();
    expect(parseCommand(msg({ cmd: "claim" }))).toBeNull();
    expect(parseCommand(msg({ cmd: "setLanguage", value: "de" }))).toBeNull();
    expect(parseCommand("pause")).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });
});
