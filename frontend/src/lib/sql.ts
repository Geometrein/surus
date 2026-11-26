// SQL the app writes itself, per database engine. Anything engine-specific
// belongs here, so a new engine gets its own branch instead of Postgres syntax.
import { PostgreSQL, SQLDialect } from "@codemirror/lang-sql";
import type { Connection, DatabaseKind } from "../api/client";

// CodeMirror has no ClickHouse dialect: standard keywords with ClickHouse's
// quoting and comment rules, so highlighting matches what the server reads.
const ClickHouseSQL = SQLDialect.define({
  identifierQuotes: "`\"",
  backslashEscapes: true,
  hashComments: true,
});

export function editorDialect(kind: DatabaseKind): SQLDialect {
  return kind === "clickhouse" ? ClickHouseSQL : PostgreSQL;
}

// The schema whose tables autocomplete offers unqualified: Postgres's search
// path starts at "public"; ClickHouse resolves names in the connection's database.
export function defaultSchema(conn: Pick<Connection, "kind" | "dbname"> | undefined): string {
  return conn?.kind === "clickhouse" ? conn.dbname || "default" : "public";
}

export function quoteIdent(kind: DatabaseKind, name: string): string {
  if (kind === "clickhouse") return "`" + name.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

export function previewTableSql(kind: DatabaseKind, schema: string, table: string): string {
  return `SELECT *\nFROM ${quoteIdent(kind, schema)}.${quoteIdent(kind, table)}\nLIMIT 10;`;
}
