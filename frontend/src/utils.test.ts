import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatCount,
  shortVersion,
  abbrevType,
  sourceBadge,
  sourceLabel,
  levelColor,
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

    expect(sourceBadge("agent")).toContain("text-[#c9a8ff]");
    expect(sourceBadge("system")).toContain("text-[#86c5a8]");
    expect(sourceBadge("user")).toContain("text-[#8fb6e8]");
  });
});

describe("levelColor", () => {
  it("colors known levels and defaults unknown to info", () => {
    expect(levelColor("warn")).toBe("text-amber-400");
    expect(levelColor("error")).toBe("text-red-400");
    expect(levelColor("info")).toBe("text-[#a0a0a8]");
    expect(levelColor("mystery")).toBe("text-[#a0a0a8]");
  });
});
