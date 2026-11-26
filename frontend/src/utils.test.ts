import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatCount,
  shortVersion,
  abbrevType,
  compactType,
  fitText,
  sourceBadge,
  sourceLabel,
  levelColor,
  formatClock,
  formatDateTime,
} from "./utils";

describe("formatBytes", () => {
  it("keeps bytes whole and scales to human units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
  });
});

describe("formatCount", () => {
  it("compacts large numbers and floors non-positive to 0", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(-5)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1500)).toBe("1.5K");
    expect(formatCount(2_000_000)).toBe("2M");
  });
});

describe("shortVersion", () => {
  it("keeps only the first two whitespace-separated tokens", () => {
    expect(shortVersion("PostgreSQL 16.2 on aarch64-apple-darwin")).toBe("PostgreSQL 16.2");
  });
});

describe("abbrevType", () => {
  it("shortens verbose Postgres type names", () => {
    expect(abbrevType("character varying")).toBe("varchar");
    expect(abbrevType("timestamp with time zone")).toBe("timestamptz");
    expect(abbrevType("timestamp without time zone")).toBe("timestamp");
    expect(abbrevType("double precision")).toBe("float8");
    expect(abbrevType("character(4)")).toBe("char(4)");
  });
});

describe("log source helpers", () => {
  it("maps known sources and falls back to user", () => {
    expect(sourceLabel("agent")).toBe("🤖 agent");
    expect(sourceLabel("system")).toBe("⚙ system");
    expect(sourceLabel("user")).toBe("👤 user");
    expect(sourceLabel("anything-else")).toBe("👤 user");

    expect(sourceBadge("agent")).toContain("text-agent-strong");
    expect(sourceBadge("system")).toContain("text-key");
    expect(sourceBadge("user")).toContain("text-accent-text-strong");
  });
});

describe("levelColor", () => {
  it("colors known levels and defaults unknown to info", () => {
    expect(levelColor("warn")).toBe("text-amber-400");
    expect(levelColor("error")).toBe("text-red-400");
    expect(levelColor("info")).toBe("text-soft");
    expect(levelColor("mystery")).toBe("text-soft");
  });
});

describe("timezone formatting", () => {
  // 2023-11-14T22:13:20Z
  const ms = 1_700_000_000_000;

  it("formatClock renders the wall clock in the given IANA zone", () => {
    expect(formatClock(ms, "UTC")).toBe("22:13:20");
    // New York is UTC-5 in November (EST) → 17:13:20.
    expect(formatClock(ms, "America/New_York")).toBe("17:13:20");
  });

  it("formatClock accepts an ISO string and falls back on a bad zone", () => {
    expect(formatClock("2023-11-14T22:13:20Z", "UTC")).toBe("22:13:20");
    expect(() => formatClock(ms, "Not/AZone")).not.toThrow();
  });

  it("formatDateTime honours the zone", () => {
    const utc = formatDateTime(ms, "UTC");
    const tokyo = formatDateTime(ms, "Asia/Tokyo"); // UTC+9 → next day 07:13
    expect(utc).not.toBe(tokyo);
    expect(tokyo).toMatch(/07:13/);
  });
});

describe("compactType", () => {
  it("shortens ClickHouse wrapper types", () => {
    expect(compactType("SimpleAggregateFunction(min, DateTime64(6, 'UTC'))")).toBe("min(DateTime64(6))");
    expect(compactType("Nullable(String)")).toBe("String?");
    expect(compactType("LowCardinality(Nullable(String))")).toBe("LC(String?)");
    expect(compactType("Nullable(Decimal(10, 2))")).toBe("Decimal(10, 2)?");
  });
  it("leaves short types alone", () => {
    expect(compactType("Int64")).toBe("Int64");
    expect(compactType("timestamp with time zone")).toBe("timestamptz");
  });
});

describe("fitText", () => {
  it("keeps text that fits and cuts the rest with an ellipsis", () => {
    expect(fitText("Int64", 5)).toBe("Int64");
    expect(fitText("min(DateTime64(6))", 10)).toBe("min(DateT…");
  });
});
