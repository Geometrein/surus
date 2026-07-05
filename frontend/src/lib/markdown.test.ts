import { describe, it, expect } from "vitest";
import { normalizeMd, extractSqlBlocks } from "./markdown";

describe("normalizeMd", () => {
  it("forces a fenced block onto its own line (open and close)", () => {
    expect(normalizeMd("Here:```sql\nSELECT 1```")).toBe("Here:\n```sql\nSELECT 1\n```");
  });

  it("leaves already-newlined fences untouched", () => {
    const already = "Here:\n```sql\nSELECT 1\n```";
    expect(normalizeMd(already)).toBe(already);
  });
});

describe("extractSqlBlocks", () => {
  it("pulls the trimmed contents of a single sql fence", () => {
    expect(extractSqlBlocks("```sql\n  SELECT 1;  \n```")).toEqual(["SELECT 1;"]);
  });

  it("returns every sql block in order", () => {
    const text = "one\n```sql\nSELECT a\n```\ntwo\n```sql\nSELECT b\n```";
    expect(extractSqlBlocks(text)).toEqual(["SELECT a", "SELECT b"]);
  });

  it("is case-insensitive on the language tag", () => {
    expect(extractSqlBlocks("```SQL\nSELECT 1\n```")).toEqual(["SELECT 1"]);
  });

  it("ignores non-sql fences and prose", () => {
    expect(extractSqlBlocks("```python\nprint(1)\n```\njust text")).toEqual([]);
    expect(extractSqlBlocks("no code here")).toEqual([]);
  });
});
