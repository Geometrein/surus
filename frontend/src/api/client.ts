// Typed client for the Surus FastAPI backend.

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://127.0.0.1:8765";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch {
    // fetch rejects opaquely ("Failed to fetch") when the request never completed.
    throw new Error(`Request to ${API_BASE} didn't complete — the backend is unreachable or timed out.`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

// --- types -----------------------------------------------------------------

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  dbname: string;
  user: string;
  sslmode: string;
  color: string;
  connected: boolean;
}

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  dbname: string;
  user: string;
  password: string;
  sslmode: string;
  color: string;
}

export interface TableRef {
  schema: string;
  name: string;
  kind: string;
  rowEstimate: number;
}
export interface SchemaTree {
  schemas: { name: string; tables: TableRef[] }[];
}

export interface RelationshipNode {
  schema: string;
  name: string;
  kind: string;
  rowEstimate: number;
  columns: { name: string; isFk: boolean }[];
}
export interface RelationshipEdge {
  fromSchema: string;
  fromTable: string;
  fromColumn: string;
  toSchema: string;
  toTable: string;
  toColumn: string;
}
export interface RelationshipGraph {
  tables: RelationshipNode[];
  edges: RelationshipEdge[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  notice: string | null;
}

export interface TableDetail {
  schema: string;
  name: string;
  kind: string;
  rowEstimate: number;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    isPk: boolean;
    default: string | null;
  }[];
  foreignKeys: { column: string; references: string }[];
  indexes: { name: string; definition: string; isUnique: boolean; isPrimary: boolean }[];
}

export interface ConnectionSnapshot {
  sampledAt: number;
  tables: {
    schema: string;
    name: string;
    kind: string;
    rowEstimate: number;
    columns: { name: string; type: string; isFk: boolean }[];
  }[];
  edges: {
    fromSchema: string;
    fromTable: string;
    fromColumn: string;
    toSchema: string;
    toTable: string;
    toColumn: string;
  }[];
}

export interface TableSizes {
  sizes: { schema: string; name: string; sizeBytes: number }[];
}

export interface ConnectionInfo {
  version: string;
  extensions: {
    name: string;
    installed_version: string;
    default_version: string;
    update_available: boolean;
    comment: string | null;
  }[];
}

// --- endpoints -------------------------------------------------------------

export interface LlmProvider {
  id: string;
  label: string;
  keyPlaceholder: string;
  hasKey: boolean;
}

export interface Settings {
  providers: LlmProvider[];               // one card per LLM provider
  hasLlmKey: boolean;                      // true if any provider has a key
  models: string[];                        // every offered model, across providers
  modelProviders: Record<string, string>;  // model id -> provider id
  defaultModel: string;
  systemPrompt: string;        // fixed base prompt (read-only)
  customInstructions: string;  // user-editable, appended to the base
  agentTimeoutSec: number;     // per-query timeout for the agent's tool queries
  agentMaxSteps: number;       // max tool-use round-trips per agent run
  agentMaxTokens: number;      // max output tokens per model call
  queryTimeoutSec: number;     // editor/query pool timeout (applied on reconnect)
  previewRowLimit: number;     // max rows returned by editor queries
}

export interface ChatSessionT {
  id: string;
  connection_id: string;
  model: string;
  mode: string;
  title: string;
  created_at: string;
}

export interface ChatMessageT {
  id: string;
  session_id: string;
  role: string;
  content: string;
  steps_json: string | null;
}

export interface AgentEvent {
  kind: "text" | "tool_call" | "tool_result" | "done" | "error" | "end";
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown> | null;
  ok?: boolean;
}

// Stream the agent's response (SSE over a POST). Calls onEvent per event.
export async function streamChat(
  sessionId: string,
  content: string,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE}/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/^data: /, "").trim();
      buf = buf.slice(idx + 2);
      if (line) onEvent(JSON.parse(line) as AgentEvent);
    }
  }
}

export interface Workspace {
  path: string | null;
}

export interface QueryFolder {
  id: string;           // relative path from workspace root, e.g. "analytics" or "analytics/reports"
  name: string;
  connectionId: string | null;
  children: QueryFolder[];
}

export interface SavedQuery {
  id: string;       // relative path within workspace, e.g. "my-folder/query.sql"
  connection_id: string | null;
  folder_id: string | null;  // directory name, or null for workspace root
  name: string;
  sql: string;
}

export interface QueryLogEntry {
  seq: number;
  ts: number; // epoch seconds
  source: "user" | "agent" | "system";
  connectionId: string | null;
  pool: string | null;
  sql: string;
  durationMs: number;
  rowCount: number | null;
  error: string | null;
}

export const api = {
  getSettings: () => req<Settings>("/settings"),

  getWorkspace: () => req<Workspace>("/queries/workspace"),
  pickWorkspace: () => req<Workspace>("/queries/workspace/pick", { method: "POST" }),
  setWorkspace: (path: string) =>
    req<Workspace>("/queries/workspace", { method: "POST", body: JSON.stringify({ path }) }),
  revealWorkspace: () => req<{ ok: boolean }>("/queries/workspace/reveal", { method: "POST" }),

  listFolders: () => req<QueryFolder[]>("/queries/folders"),
  createFolder: (name: string, connectionId?: string, parentFolderId?: string) =>
    req<QueryFolder>("/queries/folders", {
      method: "POST",
      body: JSON.stringify({ name, connectionId, parentFolderId }),
    }),
  updateFolder: (id: string, name: string, parentFolderId?: string) =>
    req<QueryFolder>(`/queries/folders/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, ...(parentFolderId !== undefined && { parentFolderId }) }),
    }),
  deleteFolder: (id: string) =>
    req<{ ok: boolean }>(`/queries/folders/${id}`, { method: "DELETE" }),

  listQueries: () => req<SavedQuery[]>("/queries"),
  saveQuery: (name: string, sql: string, connectionId: string | null, folderId: string | null = null) =>
    req<SavedQuery>("/queries", {
      method: "POST",
      body: JSON.stringify({ name, sql, connectionId, folderId }),
    }),
  updateQuery: (id: string, name: string, sql: string, connectionId: string | null, folderId: string | null) =>
    req<SavedQuery>(`/queries/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, sql, connectionId, folderId }),
    }),
  deleteQuery: (id: string) => req<{ ok: boolean }>(`/queries/${id}`, { method: "DELETE" }),
  setLlmKey: (key: string, provider: string) =>
    req<{ provider: string; hasKey: boolean }>("/settings/llm-key", {
      method: "PUT",
      body: JSON.stringify({ key, provider }),
    }),
  setCustomInstructions: (customInstructions: string) =>
    req<{ customInstructions: string }>("/settings/custom-instructions", {
      method: "PUT",
      body: JSON.stringify({ customInstructions }),
    }),
  setAgentTimeout: (agentTimeoutSec: number) =>
    req<{ agentTimeoutSec: number }>("/settings/agent-timeout", {
      method: "PUT",
      body: JSON.stringify({ agentTimeoutSec }),
    }),
  setAgentMaxSteps: (agentMaxSteps: number) =>
    req<{ agentMaxSteps: number }>("/settings/agent-max-steps", {
      method: "PUT",
      body: JSON.stringify({ agentMaxSteps }),
    }),
  setAgentMaxTokens: (agentMaxTokens: number) =>
    req<{ agentMaxTokens: number }>("/settings/agent-max-tokens", {
      method: "PUT",
      body: JSON.stringify({ agentMaxTokens }),
    }),
  setDefaultModel: (defaultModel: string) =>
    req<{ defaultModel: string }>("/settings/default-model", {
      method: "PUT",
      body: JSON.stringify({ defaultModel }),
    }),
  setQueryTimeout: (queryTimeoutSec: number) =>
    req<{ queryTimeoutSec: number }>("/settings/query-timeout", {
      method: "PUT",
      body: JSON.stringify({ queryTimeoutSec }),
    }),
  setPreviewRowLimit: (previewRowLimit: number) =>
    req<{ previewRowLimit: number }>("/settings/preview-row-limit", {
      method: "PUT",
      body: JSON.stringify({ previewRowLimit }),
    }),
  createChatSession: (connectionId: string, model: string, mode: string) =>
    req<ChatSessionT>("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ connectionId, model, mode }),
    }),
  listSessions: (connectionId: string) =>
    req<ChatSessionT[]>(`/chat/sessions?connectionId=${connectionId}`),
  getSessionMessages: (sessionId: string) =>
    req<ChatMessageT[]>(`/chat/sessions/${sessionId}/messages`),
  stopChat: (sessionId: string) =>
    req<{ ok: boolean }>(`/chat/sessions/${sessionId}/stop`, { method: "POST" }),
  deleteSession: (sessionId: string) =>
    req<{ ok: boolean }>(`/chat/sessions/${sessionId}`, { method: "DELETE" }),
  renameSession: (sessionId: string, title: string) =>
    req<ChatSessionT>(`/chat/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  listConnections: () => req<Connection[]>("/connections"),
  testConnection: (b: ConnectionInput, id?: string) =>
    req<{ ok: boolean; version: string }>("/connections/test", {
      method: "POST",
      body: JSON.stringify({ ...b, id }),
    }),
  createConnection: (b: ConnectionInput) =>
    req<Connection>("/connections", { method: "POST", body: JSON.stringify(b) }),
  updateConnection: (id: string, b: ConnectionInput) =>
    req<Connection>(`/connections/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  deleteConnection: (id: string) =>
    req<{ ok: boolean }>(`/connections/${id}`, { method: "DELETE" }),
  connect: (id: string) =>
    req<{ connected: boolean; version: string }>(`/connections/${id}/connect`, { method: "POST" }),
  disconnect: (id: string) =>
    req<{ connected: boolean }>(`/connections/${id}/disconnect`, { method: "POST" }),

  schema: (id: string) => req<SchemaTree>(`/connections/${id}/schema`),
  schemaColumns: (id: string) => req<Record<string, Record<string, string[]>>>(`/connections/${id}/schema/columns`),
  relationships: (id: string) => req<RelationshipGraph>(`/connections/${id}/schema/relationships`),
  snapshot: (id: string) => req<ConnectionSnapshot>(`/connections/${id}/snapshot`),
  tableSizes: (id: string) => req<TableSizes>(`/connections/${id}/snapshot/sizes`),
  refreshSnapshot: (id: string) => req<{ ok: boolean }>(`/connections/${id}/snapshot/refresh`, { method: "POST" }),
  tableDetail: (connectionId: string, schema: string, table: string) =>
    req<TableDetail>(`/connections/${connectionId}/schema/${schema}/${table}`),
  refreshSchema: (id: string) =>
    req<{ ok: boolean; agentContextsRefreshed: number }>(
      `/connections/${id}/schema/refresh`,
      { method: "POST" }
    ),
  // maxRows: omit for the default preview cap, or 0 to fetch all rows uncapped.
  // write: run on the write pool (editor write-mode toggle only; off by default).
  runQuery: (id: string, sql: string, maxRows?: number, write = false) =>
    req<QueryResult>(`/connections/${id}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql,
        ...(maxRows === undefined ? {} : { maxRows }),
        ...(write ? { write: true } : {}),
      }),
    }),
  cancelQuery: (id: string) =>
    req<{ ok: boolean; reason?: string }>(`/connections/${id}/query/cancel`, { method: "POST" }),
  connectionInfo: (id: string) => req<ConnectionInfo>(`/connections/${id}/info`),

  queryLogsSince: (after: number) =>
    req<{ entries: QueryLogEntry[]; lastSeq: number }>(`/logs/queries?after=${after}`),
};
