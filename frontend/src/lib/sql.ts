// SQL the app writes itself, per database engine. Anything engine-specific
// belongs here, so a new engine gets its own branch instead of Postgres syntax.
import type { DatabaseKind } from "../api/client";

export function quoteIdent(kind: DatabaseKind, name: string): string {
  if (kind === "clickhouse") return "`" + name.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

export function previewTableSql(kind: DatabaseKind, schema: string, table: string): string {
  return `SELECT *\nFROM ${quoteIdent(kind, schema)}.${quoteIdent(kind, table)}\nLIMIT 10;`;
}
