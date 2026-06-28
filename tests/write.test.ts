import { describe, expect, it } from "vitest";
import {
  hexId,
  intervalId,
  sessionUuid,
  shouldUpdateLast,
  tzOffsetMinutes,
} from "../src/write.js";

describe("hexId / intervalId / sessionUuid", () => {
  it("hexId returns the requested number of lowercase hex chars", () => {
    expect(hexId(8)).toMatch(/^[0-9a-f]{8}$/);
    expect(hexId(20)).toMatch(/^[0-9a-f]{20}$/);
  });

  it("intervalId is `{epochMs}-{20 hex}`", () => {
    expect(intervalId(1700000000000)).toMatch(/^1700000000000-[0-9a-f]{20}$/);
  });

  it("sessionUuid is 16 hex chars", () => {
    expect(sessionUuid()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("generates distinct ids", () => {
    expect(intervalId(1)).not.toBe(intervalId(1));
    expect(sessionUuid()).not.toBe(sessionUuid());
  });
});

describe("tzOffsetMinutes (negative for UTC+, matches getTimezoneOffset sign)", () => {
  it("UTC is 0", () => {
    expect(tzOffsetMinutes("UTC", new Date("2026-01-15T12:00:00Z"))).toBe(0);
  });

  it("America/New_York is +300 in winter (EST, UTC-5)", () => {
    expect(
      tzOffsetMinutes("America/New_York", new Date("2026-01-15T12:00:00Z")),
    ).toBe(300);
  });

  it("respects DST: America/New_York is +240 in summer (EDT, UTC-4)", () => {
    expect(
      tzOffsetMinutes("America/New_York", new Date("2026-07-15T12:00:00Z")),
    ).toBe(240);
  });

  it("Europe/Berlin is -120 in summer (CEST, UTC+2)", () => {
    expect(
      tzOffsetMinutes("Europe/Berlin", new Date("2026-07-15T12:00:00Z")),
    ).toBe(-120);
  });

  it("handles half-hour zones: Asia/Kolkata is -330 (UTC+5:30)", () => {
    expect(
      tzOffsetMinutes("Asia/Kolkata", new Date("2026-01-15T12:00:00Z")),
    ).toBe(-330);
  });
});

describe("shouldUpdateLast (newest wins, >=)", () => {
  it("updates when there is no existing entry", () => {
    expect(shouldUpdateLast(null, 100)).toBe(true);
    expect(shouldUpdateLast(undefined, 100)).toBe(true);
  });

  it("updates when the new event is newer or equal", () => {
    expect(shouldUpdateLast(100, 200)).toBe(true);
    expect(shouldUpdateLast(100, 100)).toBe(true);
  });

  it("does not update when the new event is older", () => {
    expect(shouldUpdateLast(200, 100)).toBe(false);
  });
});
