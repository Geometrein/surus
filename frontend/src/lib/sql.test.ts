import { describe, expect, it } from "vitest";
import { previewTableSql, quoteIdent } from "./sql";

describe("quoteIdent", () => {
  it("quotes and escapes per engine", () => {
    expect(quoteIdent("postgres", 'my"table')).toBe('"my""table"');
    expect(quoteIdent("clickhouse", "my`table")).toBe("`my\\`table`");
  });
});

describe("previewTableSql", () => {
  it("writes the preview in the engine's quoting", () => {
    expect(previewTableSql("postgres", "public", "users")).toBe('SELECT *\nFROM "public"."users"\nLIMIT 10;');
    expect(previewTableSql("clickhouse", "analytics", "customers")).toBe(
      "SELECT *\nFROM `analytics`.`customers`\nLIMIT 10;",
    );
  });
});
