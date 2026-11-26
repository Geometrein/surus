import { describe, expect, it } from "vitest";
import { PostgreSQL } from "@codemirror/lang-sql";
import { defaultSchema, editorDialect, previewTableSql, quoteIdent } from "./sql";

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

describe("editor dialect and default schema", () => {
  it("follows the engine", () => {
    expect(editorDialect("postgres")).toBe(PostgreSQL);
    expect(editorDialect("clickhouse")).not.toBe(PostgreSQL);
    expect(defaultSchema({ kind: "postgres", dbname: "app" })).toBe("public");
    expect(defaultSchema({ kind: "clickhouse", dbname: "analytics" })).toBe("analytics");
    expect(defaultSchema({ kind: "clickhouse", dbname: "" })).toBe("default");
  });
});
